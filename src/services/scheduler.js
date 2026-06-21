import { db } from "./database.js";
import { logError, logInfo } from "../logger.js";

const SCHEDULER_INTERVAL_MS = 60_000;

let schedulerTimer = null;

export function startScheduler(client) {
  if (schedulerTimer) return;

  logInfo("scheduler_started", { intervalMs: SCHEDULER_INTERVAL_MS });

  runDueScheduledTasks(client).catch((error) => {
    logError("scheduler_initial_tick_failed", null, error);
  });

  schedulerTimer = setInterval(() => {
    runDueScheduledTasks(client).catch((error) => {
      logError("scheduler_tick_failed", null, error);
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

export function createScheduledMessage({ guildId, channelId, userId, content, executeAt }) {
  const result = db.prepare(`
    INSERT INTO scheduled_tasks (guild_id, channel_id, user_id, task_type, content, execute_at)
    VALUES (?, ?, ?, 'send_message', ?, ?)
  `).run(guildId, channelId, userId, content, executeAt);

  return getScheduledTaskById(result.lastInsertRowid);
}

export function listScheduledMessages({ guildId, userId, includeAllUsers = false }) {
  if (includeAllUsers) {
    return db.prepare(`
      SELECT id, guild_id, channel_id, user_id, content, execute_at, created_at
      FROM scheduled_tasks
      WHERE guild_id = ? AND is_executed = 0
      ORDER BY execute_at ASC, id ASC
      LIMIT 20
    `).all(guildId);
  }

  return db.prepare(`
    SELECT id, guild_id, channel_id, user_id, content, execute_at, created_at
    FROM scheduled_tasks
    WHERE guild_id = ? AND user_id = ? AND is_executed = 0
    ORDER BY execute_at ASC, id ASC
    LIMIT 20
  `).all(guildId, userId);
}

export function cancelScheduledMessage({ guildId, userId, id, isAdmin = false }) {
  const task = getScheduledTaskById(id);
  if (!task || task.guild_id !== guildId || task.is_executed) return null;
  if (!isAdmin && task.user_id !== userId) return null;

  db.prepare(`
    UPDATE scheduled_tasks
    SET is_executed = 1, updated_at = datetime('now')
    WHERE id = ?
  `).run(id);

  return task;
}

export function rescheduleMessage({ guildId, userId, id, executeAt, isAdmin = false }) {
  const task = getScheduledTaskById(id);
  if (!task || task.guild_id !== guildId || task.is_executed) return null;
  if (!isAdmin && task.user_id !== userId) return null;

  db.prepare(`
    UPDATE scheduled_tasks
    SET execute_at = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(executeAt, id);

  return getScheduledTaskById(id);
}

function getScheduledTaskById(id) {
  return db.prepare(`
    SELECT id, guild_id, channel_id, user_id, task_type, content, execute_at, is_executed, created_at
    FROM scheduled_tasks
    WHERE id = ?
  `).get(id) ?? null;
}

async function runDueScheduledTasks(client) {
  const now = formatKstDateTime(new Date());
  const tasks = db.prepare(`
    SELECT id, guild_id, channel_id, user_id, task_type, content, execute_at
    FROM scheduled_tasks
    WHERE execute_at <= ? AND is_executed = 0
    ORDER BY execute_at ASC, id ASC
    LIMIT 25
  `).all(now);

  for (const task of tasks) {
    db.prepare(`
      UPDATE scheduled_tasks
      SET is_executed = 1, updated_at = datetime('now')
      WHERE id = ? AND is_executed = 0
    `).run(task.id);

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
