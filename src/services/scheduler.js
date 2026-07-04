import { db } from "./database.js";
import { logError, logInfo } from "../logger.js";

const SCHEDULER_INTERVAL_MS = 60_000;
const WEB_APP_URL = process.env.WEB_APP_URL || process.env.BASE_URL || "http://localhost:3000";

let schedulerTimer = null;

let lastRaidSpawnDate = "";
let lastRaidWarningDate = "";
const notifiedRaidSessions = new Set();
let lastTrackedRaidSessionId = null;
let lastHomepageStatus = true;
let homepageDownSince = null;

export function startScheduler(client) {
  if (schedulerTimer) return;

  logInfo("scheduler_started", { intervalMs: SCHEDULER_INTERVAL_MS });

  runDueScheduledTasks(client).catch((error) => {
    logError("scheduler_initial_tick_failed", null, error);
  });

  checkExpiringSubscriptions(client).catch((error) => {
    logError("scheduler_expiry_check_initial_failed", null, error);
  });

  schedulerTimer = setInterval(() => {
    runDueScheduledTasks(client).catch((error) => {
      logError("scheduler_tick_failed", null, error);
    });
    checkExpiringSubscriptions(client).catch((error) => {
      logError("scheduler_expiry_check_failed", null, error);
    });
    checkRaidPreWarning(client).catch((error) => {
      logError("raid_prewarning_failed", null, error);
    });
    checkDailyRaidSpawn(client).catch((error) => {
      logError("raid_daily_spawn_check_failed", null, error);
    });
    checkRaidDefeated(client).catch((error) => {
      logError("raid_defeated_check_failed", null, error);
    });
  }, SCHEDULER_INTERVAL_MS);

  return () => {
    if (schedulerTimer) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
      logInfo("scheduler_stopped");
    }
  };
}

function getKstDateString() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function isKstTime(hour, minute) {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return kst.getUTCHours() === hour && kst.getUTCMinutes() === minute;
}

async function checkRaidPreWarning(client) {
  if (!isKstTime(9, 55) && !isKstTime(9, 56)) return;

  const today = getKstDateString();
  if (lastRaidWarningDate === today) return;

  const configs = await db.all("SELECT guild_id, channel_id FROM raid_config");
  if (configs.length === 0) return;

  lastRaidWarningDate = today;

  const bossName = getDailyBossName();
  const configsWithMembers = [];
  for (const cfg of configs) {
    try {
      const guild = client.guilds.cache.get(cfg.guild_id);
      if (guild) configsWithMembers.push({ ...cfg, memberCount: guild.memberCount, guildName: guild.name });
    } catch { /* skip */ }
  }
  const totalMembers = configsWithMembers.reduce((s, c) => s + c.memberCount, 0);
  const estimatedHp = 5000 + totalMembers * 100;
  const serverList = configsWithMembers.map(c => `> **${c.guildName}** — ${c.memberCount.toLocaleString()}명`).join("\n");

  const embed = {
    color: 0xfbbf24,
    title: "⏰ 레이드 보스가 곧 출현합니다!",
    description:
      `**5분 후** 오전 10시에 보스가 출현합니다.\n\n` +
      `**${bossName}**\n` +
      `> 예상 HP: ${estimatedHp.toLocaleString()}\n` +
      `> 참여 서버: ${configsWithMembers.length}개\n` +
      `> 예상 보상 풀: ${calculateRewardPool(totalMembers).toLocaleString()} 코인\n\n` +
      `**참여 서버 목록**\n${serverList}\n\n` +
      `🌐 홈페이지에서 준비하세요!\n${WEB_APP_URL}/raid`,
    timestamp: new Date().toISOString(),
    footer: { text: "FLUX 레이드 시스템" },
  };

  for (const cfg of configs) {
    try {
      const guild = client.guilds.cache.get(cfg.guild_id);
      if (!guild) continue;
      const channel = guild.channels.cache.get(cfg.channel_id);
      if (!channel || !channel.isTextBased()) continue;
      await channel.send({ embeds: [embed] });
    } catch (e) {
      logError("raid_prewarning_send_failed", cfg.guild_id, e);
    }
  }

  logInfo("raid_prewarning_sent", {
    serverCount: configs.length,
    totalMembers,
    estimatedHp,
  });
}

async function checkDailyRaidSpawn(client) {
  if (!isKstTime(10, 0) && !isKstTime(10, 1) && !isKstTime(10, 2) && !isKstTime(10, 3) && !isKstTime(10, 4)) return;

  const today = getKstDateString();
  if (lastRaidSpawnDate === today) return;

  const configs = await db.all("SELECT guild_id, channel_id FROM raid_config");
  if (configs.length === 0) return;

  lastRaidSpawnDate = today;

  let totalMembers = 0;
  for (const cfg of configs) {
    try {
      const guild = await client.guilds.fetch(cfg.guild_id).catch(() => null);
      if (guild) {
        totalMembers += guild.memberCount;
      }
    } catch (e) {
      logError("raid_guild_fetch", cfg.guild_id, e);
    }
  }

  const baseHp = 5000;
  const hpPerUser = 100;
  const maxHp = baseHp + totalMembers * hpPerUser;
  const bossName = getDailyBossName();
  const rewardPool = calculateRewardPool(totalMembers);

  const guildIds = configs.map(c => c.guild_id);

  try {
    const res = await fetch(`${WEB_APP_URL}/api/raid/spawn-global`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        maxHp,
        bossName,
        rewardPool,
        guildIds,
        secret: process.env.WEBHOOK_SECRET || "",
      }),
    });
    if (!res.ok) {
      logError("raid_spawn_global_failed", null, new Error(`HTTP ${res.status}: ${await res.text()}`));
      return;
    }
  } catch (e) {
    logError("raid_spawn_global_network", null, e);
    return;
  }

  const kstTime = new Date(Date.now() + 9 * 60 * 60 * 1000)
    .toLocaleString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });

  const embed = {
    color: 0x5ce4ff,
    title: "⚔️ 오늘의 레이드 보스가 출현했습니다!",
    description:
      `**${bossName}**이(가) 나타났다!\n\n` +
      `> HP: ${maxHp.toLocaleString()}\n` +
      `> 참여 서버: ${configs.length}개\n` +
      `> 총 유저 수 기반 HP\n\n` +
      `🌐 홈페이지에서 공격하세요!\n${WEB_APP_URL}/raid`,
    timestamp: new Date().toISOString(),
    footer: { text: "FLUX 레이드 시스템" },
  };

  for (const cfg of configs) {
    try {
      const guild = client.guilds.cache.get(cfg.guild_id);
      if (!guild) continue;
      const channel = guild.channels.cache.get(cfg.channel_id);
      if (!channel || !channel.isTextBased()) continue;
      await channel.send({ content: "@everyone 보스 출현! ⚔️", embeds: [embed] });
    } catch (e) {
      logError("raid_announce_failed", cfg.guild_id, e);
    }
  }

  logInfo("raid_daily_spawned", {
    bossName,
    maxHp,
    totalMembers,
    serverCount: configs.length,
    time: kstTime,
  });
}

function getDailyBossName() {
  const bosses = ["고블린 킹", "어린 드래곤", "에인션트 골렘", "보이드 로드", "그림 리퍼", "마그마 거인"];
  const dayIndex = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
  return bosses[dayIndex % bosses.length];
}

function calculateRewardPool(totalMembers) {
  const basePool = 2000;
  const poolPerUser = 50;
  return basePool + totalMembers * poolPerUser;
}

async function checkRaidDefeated(client) {
  try {
    const res = await fetch(`${WEB_APP_URL}/api/raid/state`, {
      headers: { "X-Secret": process.env.WEBHOOK_SECRET || "" },
    });
    if (!res.ok) return;
    lastHomepageStatus = true;
    homepageDownSince = null;
    const state = await res.json();

    if (state.active && state.id) {
      lastTrackedRaidSessionId = state.id;
      return;
    }

    if (!state.active && lastTrackedRaidSessionId) {
      const sessionId = lastTrackedRaidSessionId;
      lastTrackedRaidSessionId = null;

      if (notifiedRaidSessions.has(sessionId)) return;

      const statusRes = await fetch(`${WEB_APP_URL}/api/raid/status?session_id=${sessionId}`, {
        headers: { "X-Secret": process.env.WEBHOOK_SECRET || "" },
      });
      if (!statusRes.ok) return;
      const statusData = await statusRes.json();
      if (!statusData.raid) return;

      const defeatedRaid = statusData.raid;

      const contribsRes = await fetch(`${WEB_APP_URL}/api/raid/contributions?session_id=${sessionId}`, {
        headers: { "X-Secret": process.env.WEBHOOK_SECRET || "" },
      });
      const contribs = contribsRes.ok ? await contribsRes.json() : [];
      if (!Array.isArray(contribs)) return;

      const guildContribs = new Map();
      for (const c of contribs) {
        let userGuildId = null;
        for (const [gid] of client.guilds.cache) {
          const guild = client.guilds.cache.get(gid);
          if (guild && guild.members.cache.has(c.user_id)) {
            userGuildId = gid;
            break;
          }
        }
        if (!userGuildId) continue;
        const existing = guildContribs.get(userGuildId) || { totalDamage: 0, users: [] };
        existing.totalDamage += c.damage_dealt;
        existing.users.push(c);
        guildContribs.set(userGuildId, existing);
      }

      let winningGuildId = null;
      let maxDamage = 0;
      for (const [gid, gc] of guildContribs) {
        if (gc.totalDamage > maxDamage) {
          maxDamage = gc.totalDamage;
          winningGuildId = gid;
        }
      }

      for (const [gid, gc] of guildContribs) {
        const cfg = await db.get("SELECT channel_id FROM raid_config WHERE guild_id = $1", [gid]);
        if (!cfg) continue;
        const guild = client.guilds.cache.get(gid);
        if (!guild) continue;
        const channel = guild.channels.cache.get(cfg.channel_id);
        if (!channel || !channel.isTextBased()) continue;

        const isWinner = gid === winningGuildId;
        const sortedUsers = gc.users.sort((a, b) => b.damage_dealt - a.damage_dealt);
        const topLines = sortedUsers.slice(0, 10).map((u, i) =>
          `${["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"][i] || `${i + 1}.`} <@${u.user_id}> — ${u.damage_dealt.toLocaleString()}`
        ).join("\n");

        const embed = {
          color: isWinner ? 0xffd700 : 0x888888,
          title: isWinner
            ? `🏆 ${guild.name} 서버가 레이드에서 승리했습니다!`
            : `📊 ${guild.name} 서버 레이드 결과`,
          description:
            `${isWinner ? "🎉 **승리 서버**" : ""}\n` +
            `> 보스: ${defeatedRaid.boss_name}\n` +
            `> 서버 기여도: ${gc.totalDamage.toLocaleString()} 대미지\n\n` +
            `**유저별 기여도 TOP 10**\n${topLines || "참여자가 없습니다."}`,
          timestamp: new Date().toISOString(),
          footer: { text: "FLUX 레이드 시스템" },
        };

        try {
          await channel.send({ embeds: [embed] });
        } catch (e) {
          logError("raid_result_send_failed", gid, e);
        }
      }

      notifiedRaidSessions.add(sessionId);
      logInfo("raid_result_sent", { sessionId, winningGuildId, serverCount: guildContribs.size });
    }
  } catch (e) {
    const now = Date.now();
    if (lastHomepageStatus || !homepageDownSince || (now - homepageDownSince) >= 300_000) {
      logError("check_raid_defeated", null, e);
      homepageDownSince = now;
    }
    lastHomepageStatus = false;
  }
}

const TIER_LABELS = { free: "Free", basic: "Basic", premium: "Premium", platinum: "Platinum" };

async function checkExpiringSubscriptions(client) {
  const now = new Date();
  const kstNow = formatKstDateTime(now);

  const lowerBound = formatKstDateTime(new Date(now.getTime() + 2 * 86400000 + 23 * 3600000));
  const upperBound = formatKstDateTime(new Date(now.getTime() + 3 * 86400000 + 1 * 3600000));

  const expiringUsers = await db.all(
    `SELECT user_id, tier, expires_at
     FROM user_subscriptions
     WHERE expires_at IS NOT NULL
       AND reminder_sent = 0
       AND expires_at BETWEEN $1 AND $2`,
    [lowerBound, upperBound],
  );

  for (const sub of expiringUsers) {
    try {
      const user = await client.users.fetch(sub.user_id).catch(() => null);
      if (!user) continue;

      const tierName = TIER_LABELS[sub.tier] || sub.tier.toUpperCase();
      await user.send(
        `🔔 **FLUX봇 등급 만료 안내**\n\n` +
        `안녕하세요, **${user.username}**님!\n` +
        `현재 사용 중인 **${tierName}** 등급이 **3일 후** 만료될 예정입니다.\n` +
        `- **만료일**: \`${sub.expires_at} (KST)\`\n\n` +
        `등급이 만료되면 Free 등급으로 자동 전환되며, 일부 제한이 적용됩니다.\n` +
        `계속해서 혜택을 이용하려면 \`!FLUX 등급 구매\` 명령어로 갱신해주세요! 💛`,
      );

      await db.run("UPDATE user_subscriptions SET reminder_sent = 1 WHERE user_id = $1", [sub.user_id]);
      logInfo("subscription_expiry_reminder_sent", { userId: sub.user_id, tier: sub.tier, expiresAt: sub.expires_at });
    } catch (error) {
      logError("subscription_expiry_reminder_failed", null, error, { userId: sub.user_id, tier: sub.tier });
    }
  }

  const expiringServers = await db.all(
    `SELECT guild_id, tier, expires_at
     FROM server_subscriptions
     WHERE expires_at IS NOT NULL
       AND reminder_sent = 0
       AND expires_at BETWEEN $1 AND $2`,
    [lowerBound, upperBound],
  );

  for (const sub of expiringServers) {
    try {
      const guild = await client.guilds.fetch(sub.guild_id).catch(() => null);
      if (!guild) continue;

      const owner = await client.users.fetch(guild.ownerId).catch(() => null);
      if (!owner) continue;

      const tierName = TIER_LABELS[sub.tier] || sub.tier.toUpperCase();
      await owner.send(
        `🔔 **FLUX봇 서버 등급 만료 안내**\n\n` +
        `안녕하세요, **${owner.username}**님!\n` +
        `**${guild.name}** 서버의 **${tierName}** 등급이 **3일 후** 만료될 예정입니다.\n` +
        `- **만료일**: \`${sub.expires_at} (KST)\`\n\n` +
        `등급이 만료되면 Free 등급으로 자동 전환됩니다.\n` +
        `계속해서 플래티넘 혜택을 이용하려면 \`!FLUX 플래티넘 서버 구매\` 명령어로 갱신해주세요! 💛`,
      );

      await db.run("UPDATE server_subscriptions SET reminder_sent = 1 WHERE guild_id = $1", [sub.guild_id]);
      logInfo("server_subscription_expiry_reminder_sent", { guildId: sub.guild_id, tier: sub.tier, expiresAt: sub.expires_at });
    } catch (error) {
      logError("server_subscription_expiry_reminder_failed", null, error, { guildId: sub.guild_id, tier: sub.tier });
    }
  }
}

export async function createScheduledMessage({ guildId, channelId, userId, content, executeAt }) {
  const result = await db.run(
    `INSERT INTO scheduled_tasks (guild_id, channel_id, user_id, task_type, content, execute_at)
     VALUES ($1, $2, $3, 'send_message', $4, $5)
     RETURNING id`,
    [guildId, channelId, userId, content, executeAt],
  );

  return getScheduledTaskById(result.lastInsertRowid);
}

export async function listScheduledMessages({ guildId, userId, includeAllUsers = false }) {
  if (includeAllUsers) {
    return db.all(
      `SELECT id, guild_id, channel_id, user_id, content, execute_at, created_at
       FROM scheduled_tasks
       WHERE guild_id = $1 AND is_executed = 0
       ORDER BY execute_at ASC, id ASC
       LIMIT 20`,
      [guildId],
    );
  }

  return db.all(
    `SELECT id, guild_id, channel_id, user_id, content, execute_at, created_at
     FROM scheduled_tasks
     WHERE guild_id = $1 AND user_id = $2 AND is_executed = 0
     ORDER BY execute_at ASC, id ASC
     LIMIT 20`,
    [guildId, userId],
  );
}

export async function cancelScheduledMessage({ guildId, userId, id, isAdmin = false }) {
  const task = await getScheduledTaskById(id);
  if (!task || task.guild_id !== guildId || task.is_executed) return null;
  if (!isAdmin && task.user_id !== userId) return null;

  await db.run(
    "UPDATE scheduled_tasks SET is_executed = 1, updated_at = TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = $1",
    [id],
  );

  return task;
}

export async function rescheduleMessage({ guildId, userId, id, executeAt, isAdmin = false }) {
  const task = await getScheduledTaskById(id);
  if (!task || task.guild_id !== guildId || task.is_executed) return null;
  if (!isAdmin && task.user_id !== userId) return null;

  await db.run(
    "UPDATE scheduled_tasks SET execute_at = $1, updated_at = TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = $2",
    [executeAt, id],
  );

  return getScheduledTaskById(id);
}

async function getScheduledTaskById(id) {
  const row = await db.get(
    "SELECT id, guild_id, channel_id, user_id, task_type, content, execute_at, is_executed, created_at FROM scheduled_tasks WHERE id = $1",
    [id],
  );
  return row ?? null;
}

async function runDueScheduledTasks(client) {
  const now = formatKstDateTime(new Date());
  const tasks = await db.all(
    `SELECT id, guild_id, channel_id, user_id, task_type, content, execute_at
     FROM scheduled_tasks
     WHERE execute_at <= $1 AND is_executed = 0
     ORDER BY execute_at ASC, id ASC
     LIMIT 25`,
    [now],
  );

  for (const task of tasks) {
    await db.run(
      "UPDATE scheduled_tasks SET is_executed = 1, updated_at = TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = $1 AND is_executed = 0",
      [task.id],
    );

    try {
      await executeScheduledTask(client, task);
    } catch (error) {
      logError("scheduler_task_execution_failed", task.guild_id, error, {
        taskId: task.id,
        channelId: task.channel_id,
      });
    }
  }
}

async function executeScheduledTask(client, task) {
  if (task.task_type !== "send_message") return;

  const guild = await client.guilds.fetch(task.guild_id).catch(() => null);
  if (!guild) {
    throw new Error(`Guild not found: ${task.guild_id}`);
  }

  const channel = await guild.channels.fetch(task.channel_id).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    throw new Error(`Text channel not found: ${task.channel_id}`);
  }

  await channel.send({
    content: task.content,
    allowedMentions: { parse: ["users", "roles"] },
  });

  logInfo("scheduler_task_executed", {
    taskId: task.id,
    guildId: task.guild_id,
    channelId: task.channel_id,
    userId: task.user_id,
  });
}

export function formatKstDateTime(date) {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().replace("T", " ").slice(0, 19);
}
