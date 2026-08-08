import { db } from "./database.js";
import { TIER_ROLE_CONFIG } from "../config.js";
import { logError } from "../logger.js";

export const TIER_BENEFITS = {
  free: { miningMult: 1, growthMult: 1 },
  basic: { miningMult: 1.25, growthMult: 1.25 },
  premium: { miningMult: 1.5, growthMult: 1.5 },
};

export const TIER_LIMITS = {
  free: {
    name: "Free",
    ai_calls: 10,
    image_generations: 3,
    image_readings: 5,
    video_analysis: 0,
  },
  basic: {
    name: "Basic",
    ai_calls: 30,
    image_generations: 6,
    image_readings: 10,
    video_analysis: 0,
  },
  premium: {
    name: "Premium",
    ai_calls: Infinity,
    image_generations: 15,
    image_readings: 30,
    video_analysis: 3,
  },
};

export function getKstNow() {
  const utc = Date.now();
  const kstOffset = 9 * 60 * 60 * 1000;
  return new Date(utc + kstOffset);
}

export function getKstDateString(date = null) {
  const d = date || getKstNow();
  return d.toISOString().substring(0, 10);
}

export function getKstDateTimeString(date = null) {
  const d = date || getKstNow();
  return d.toISOString().replace("T", " ").substring(0, 19);
}

export function getExpiryKstDateTimeString(days = 30) {
  const utc = Date.now();
  const kstOffset = 9 * 60 * 60 * 1000;
  const daysMs = days * 24 * 60 * 60 * 1000;
  const expiryDate = new Date(utc + kstOffset + daysMs);
  return expiryDate.toISOString().replace("T", " ").substring(0, 19);
}

export async function getUserSubscription(userId) {
  const row = await db.get("SELECT tier, expires_at FROM user_subscriptions WHERE user_id = $1", [userId]);

  if (!row) {
    return { tier: "free", expires_at: null };
  }

  if (row.expires_at) {
    const nowStr = getKstDateTimeString();
    if (row.expires_at < nowStr) {
      await db.run(
        "UPDATE user_subscriptions SET tier = 'free', expires_at = NULL, updated_at = $1 WHERE user_id = $2",
        [getKstDateTimeString(), userId],
      );
      return { tier: "free", expires_at: null };
    }
  }

  return { tier: row.tier, expires_at: row.expires_at };
}

export async function getUserSubscriptionTier(userId) {
  const sub = await getUserSubscription(userId);
  return sub.tier;
}

export async function updateUserSubscription(userId, tier, days = 30) {
  const kstNow = getKstDateTimeString();
  const expiresAt = tier === "free" ? null : getExpiryKstDateTimeString(days);

  await db.run(
    `INSERT INTO user_subscriptions (user_id, tier, expires_at, reminder_sent, created_at, updated_at)
     VALUES ($1, $2, $3, 0, $4, $5)
     ON CONFLICT(user_id) DO UPDATE SET
       tier = EXCLUDED.tier,
       expires_at = EXCLUDED.expires_at,
       reminder_sent = 0,
       updated_at = EXCLUDED.updated_at`,
    [userId, tier, expiresAt, kstNow, kstNow],
  );

  return { tier, expiresAt };
}

export async function extendUserSubscription(userId, tier, days = 30) {
  const kstNow = getKstDateTimeString();
  const sub = await getUserSubscription(userId);
  const baseStr = sub.expires_at && sub.expires_at > kstNow ? sub.expires_at : kstNow;
  const kstOffset = 9 * 60 * 60 * 1000;
  const baseUtc = new Date(baseStr.replace(" ", "T") + "+09:00").getTime();
  const expiresAt = new Date(baseUtc + days * 24 * 60 * 60 * 1000 + kstOffset)
    .toISOString()
    .replace("T", " ")
    .substring(0, 19);

  await db.run(
    `INSERT INTO user_subscriptions (user_id, tier, expires_at, reminder_sent, created_at, updated_at)
     VALUES ($1, $2, $3, 0, $4, $5)
     ON CONFLICT(user_id) DO UPDATE SET
       tier = EXCLUDED.tier,
       expires_at = EXCLUDED.expires_at,
       reminder_sent = 0,
       updated_at = EXCLUDED.updated_at`,
    [userId, tier, expiresAt, kstNow, kstNow],
  );

  return { tier, expiresAt };
}

export async function updateDonationAmount(userId, amount) {
  const kstNow = getKstDateTimeString();
  const result = await db.get(
    `INSERT INTO user_subscriptions (user_id, tier, donation_amount, created_at, updated_at)
     VALUES ($1, 'free', GREATEST($2, 0), $3, $3)
     ON CONFLICT(user_id) DO UPDATE SET donation_amount = GREATEST(user_subscriptions.donation_amount + $2, 0), updated_at = EXCLUDED.updated_at
     RETURNING donation_amount`,
    [userId, amount, kstNow],
  );
  return Number(result.donation_amount);
}

export async function getDailyUsage(userId) {
  const todayStr = getKstDateString();

  const row = await db.get(
    "SELECT ai_calls, image_generations, image_readings, video_analysis FROM user_daily_usage WHERE user_id = $1 AND usage_date = $2",
    [userId, todayStr],
  );

  if (!row) {
    return { ai_calls: 0, image_generations: 0, image_readings: 0, video_analysis: 0 };
  }

  return row;
}

const USAGE_COLUMNS = {
  ai_calls: 'ai_calls',
  image_generations: 'image_generations',
  image_readings: 'image_readings',
  video_analysis: 'video_analysis',
};

export async function checkAndIncrementUsage(userId, type, guildId = null) {
  const sub = await getUserSubscription(userId);
  const limits = TIER_LIMITS[sub.tier];
  const todayStr = getKstDateString();

  if (!USAGE_COLUMNS[type]) {
    throw new Error(`Invalid usage type: ${type}`);
  }

  const maxLimit = limits[type];

  await db.run(
    `INSERT INTO user_daily_usage (user_id, usage_date, ai_calls, image_generations, image_readings, video_analysis)
     VALUES ($1, $2, 0, 0, 0, 0)
     ON CONFLICT(user_id, usage_date) DO NOTHING`,
    [userId, todayStr],
  );

  if (maxLimit === Infinity) {
    await db.run(
      `UPDATE user_daily_usage
       SET ai_calls = ai_calls + CASE WHEN $1 = 'ai_calls' THEN 1 ELSE 0 END,
           image_generations = image_generations + CASE WHEN $2 = 'image_generations' THEN 1 ELSE 0 END,
           image_readings = image_readings + CASE WHEN $3 = 'image_readings' THEN 1 ELSE 0 END,
           video_analysis = video_analysis + CASE WHEN $4 = 'video_analysis' THEN 1 ELSE 0 END
       WHERE user_id = $5 AND usage_date = $6`,
      [type, type, type, type, userId, todayStr],
    );
    const usage = await db.get(
      "SELECT ai_calls, image_generations, image_readings, video_analysis FROM user_daily_usage WHERE user_id = $1 AND usage_date = $2",
      [userId, todayStr],
    );
    return {
      allowed: true,
      current: usage[type],
      limit: maxLimit,
      tier: sub.tier,
      usedServerToken: false,
    };
  }

  const result = await db.run(
    `UPDATE user_daily_usage
     SET ai_calls = ai_calls + CASE WHEN $1 = 'ai_calls' THEN 1 ELSE 0 END,
         image_generations = image_generations + CASE WHEN $2 = 'image_generations' THEN 1 ELSE 0 END,
         image_readings = image_readings + CASE WHEN $3 = 'image_readings' THEN 1 ELSE 0 END,
         video_analysis = video_analysis + CASE WHEN $4 = 'video_analysis' THEN 1 ELSE 0 END
     WHERE user_id = $5 AND usage_date = $6
       AND (
         ($7 = 'ai_calls' AND ai_calls < $8) OR
         ($9 = 'image_generations' AND image_generations < $10) OR
         ($11 = 'image_readings' AND image_readings < $12) OR
         ($13 = 'video_analysis' AND video_analysis < $14)
       )`,
    [type, type, type, type, userId, todayStr, type, maxLimit, type, maxLimit, type, maxLimit, type, maxLimit],
  );

  if (result.changes > 0) {
    const usage = await db.get(
      "SELECT ai_calls, image_generations, image_readings, video_analysis FROM user_daily_usage WHERE user_id = $1 AND usage_date = $2",
      [userId, todayStr],
    );
    return {
      allowed: true,
      current: usage[type],
      limit: maxLimit,
      tier: sub.tier,
      usedServerToken: false,
    };
  }

  const usage = await db.get(
    "SELECT ai_calls, image_generations, image_readings, video_analysis FROM user_daily_usage WHERE user_id = $1 AND usage_date = $2",
    [userId, todayStr],
  );
  const currentCount = usage?.[type] ?? 0;

  if (currentCount >= maxLimit) {
    if (guildId && await consumeServerImageToken(guildId, type)) {
      return {
        allowed: true,
        current: currentCount,
        limit: maxLimit,
        tier: sub.tier,
        usedServerToken: true,
      };
    }

    return {
      allowed: false,
      current: currentCount,
      limit: maxLimit,
      tier: sub.tier,
    };
  }

  return {
    allowed: true,
    current: currentCount + 1,
    limit: maxLimit,
    tier: sub.tier,
    usedServerToken: false,
  };
}

export async function decrementUsage(userId, type) {
  const todayStr = getKstDateString();

  if (!USAGE_COLUMNS[type]) return;

  await db.run(
    `UPDATE user_daily_usage
     SET ai_calls = CASE WHEN $1 = 'ai_calls' AND ai_calls > 0 THEN ai_calls - 1 ELSE ai_calls END,
         image_generations = CASE WHEN $2 = 'image_generations' AND image_generations > 0 THEN image_generations - 1 ELSE image_generations END,
         image_readings = CASE WHEN $3 = 'image_readings' AND image_readings > 0 THEN image_readings - 1 ELSE image_readings END,
         video_analysis = CASE WHEN $4 = 'video_analysis' AND video_analysis > 0 THEN video_analysis - 1 ELSE video_analysis END
     WHERE user_id = $5 AND usage_date = $6`,
    [type, type, type, type, userId, todayStr],
  );
}

export async function getServerImageTokens(guildId) {
  const row = await db.get(
    "SELECT image_generations, image_readings, video_analysis FROM server_image_tokens WHERE guild_id = $1",
    [guildId],
  );

  if (!row) {
    return { image_generations: 0, image_readings: 0, video_analysis: 0 };
  }

  return row;
}

const SERVER_TOKEN_COLUMNS = {
  image_generations: 'image_generations',
  image_readings: 'image_readings',
  video_analysis: 'video_analysis',
};

export async function addServerImageToken(guildId, type, amount = 1) {
  if (!SERVER_TOKEN_COLUMNS[type]) {
    throw new Error(`Unsupported server image token type: ${type}`);
  }

  const kstNow = getKstDateTimeString();

  await db.run(
    `INSERT INTO server_image_tokens (guild_id, image_generations, image_readings, video_analysis, created_at, updated_at)
     VALUES ($1, 0, 0, 0, $2, $3)
     ON CONFLICT(guild_id) DO UPDATE SET
       image_generations = image_generations + CASE WHEN $4 = 'image_generations' THEN $5 ELSE 0 END,
       image_readings = image_readings + CASE WHEN $6 = 'image_readings' THEN $7 ELSE 0 END,
       video_analysis = video_analysis + CASE WHEN $8 = 'video_analysis' THEN $9 ELSE 0 END,
       updated_at = EXCLUDED.updated_at`,
    [guildId, kstNow, kstNow, type, amount, type, amount, type, amount],
  );

  return getServerImageTokens(guildId);
}

export async function consumeServerImageToken(guildId, type) {
  if (!SERVER_TOKEN_COLUMNS[type]) {
    return false;
  }

  const kstNow = getKstDateTimeString();
  const result = await db.run(
    `UPDATE server_image_tokens
     SET image_generations = CASE WHEN $1 = 'image_generations' AND image_generations > 0 THEN image_generations - 1 ELSE image_generations END,
         image_readings = CASE WHEN $2 = 'image_readings' AND image_readings > 0 THEN image_readings - 1 ELSE image_readings END,
         video_analysis = CASE WHEN $3 = 'video_analysis' AND video_analysis > 0 THEN video_analysis - 1 ELSE video_analysis END,
         updated_at = $4
     WHERE guild_id = $5 AND (
       ($6 = 'image_generations' AND image_generations > 0) OR
       ($7 = 'image_readings' AND image_readings > 0) OR
       ($8 = 'video_analysis' AND video_analysis > 0)
     )`,
    [type, type, type, kstNow, guildId, type, type, type],
  );

  return result.changes > 0;
}

export async function getServerSubscription(guildId) {
  if (!guildId) return { tier: "free", expires_at: null };
  const row = await db.get("SELECT tier, expires_at FROM server_subscriptions WHERE guild_id = $1", [guildId]);

  if (!row) {
    return { tier: "free", expires_at: null };
  }

  if (row.expires_at) {
    const nowStr = getKstDateTimeString();
    if (row.expires_at < nowStr) {
      await db.run(
        "UPDATE server_subscriptions SET tier = 'free', expires_at = NULL, updated_at = $1 WHERE guild_id = $2",
        [getKstDateTimeString(), guildId],
      );
      return { tier: "free", expires_at: null };
    }
  }

  return { tier: row.tier, expires_at: row.expires_at };
}

export async function getServerSubscriptionTier(guildId) {
  const sub = await getServerSubscription(guildId);
  return sub.tier;
}

export async function updateServerSubscription(guildId, tier, days = 30) {
  const kstNow = getKstDateTimeString();
  const expiresAt = tier === "free" ? null : getExpiryKstDateTimeString(days);

  await db.run(
    `INSERT INTO server_subscriptions (guild_id, tier, expires_at, reminder_sent, created_at, updated_at)
     VALUES ($1, $2, $3, 0, $4, $5)
     ON CONFLICT(guild_id) DO UPDATE SET
       tier = EXCLUDED.tier,
       expires_at = EXCLUDED.expires_at,
       reminder_sent = 0,
       updated_at = EXCLUDED.updated_at`,
    [guildId, tier, expiresAt, kstNow, kstNow],
  );

  return { tier, expiresAt };
}

export async function syncTierRole(client, userId, tier) {
  for (const [guildId, roleMap] of Object.entries(TIER_ROLE_CONFIG)) {
    try {
      const guild = await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) continue;
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) continue;

      for (const roleId of Object.values(roleMap)) {
        if (member.roles.cache.has(roleId)) {
          await member.roles.remove(roleId, "FLUX 등급 변경").catch(() => {});
        }
      }

      const newRoleId = roleMap[tier];
      if (newRoleId && tier !== "free") {
        await member.roles.add(newRoleId, "FLUX 등급 부여").catch(() => {});
      }
    } catch (e) {
      logError("sync_tier_role", guildId, e, { userId, tier });
    }
  }
}
