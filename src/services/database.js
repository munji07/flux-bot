import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const DATA_DIR = new URL("../../data/", import.meta.url);
const DB_FILE = new URL("../../data/conversations.sqlite", import.meta.url);

mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(fileURLToPath(DB_FILE));

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS conversation_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    history_key TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    channel_id TEXT,
    user_id TEXT NOT NULL,
    user_tag TEXT,
    user_name TEXT,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_conversation_messages_history_id
    ON conversation_messages (history_key, id);

  CREATE INDEX IF NOT EXISTS idx_conversation_messages_user_created
    ON conversation_messages (guild_id, user_id, created_at);

  CREATE TABLE IF NOT EXISTS user_subscriptions (
    user_id TEXT PRIMARY KEY,
    tier TEXT NOT NULL DEFAULT 'free',
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_daily_usage (
    user_id TEXT NOT NULL,
    usage_date TEXT NOT NULL DEFAULT (date('now', 'localtime')),
    ai_calls INTEGER NOT NULL DEFAULT 0,
    image_generations INTEGER NOT NULL DEFAULT 0,
    image_readings INTEGER NOT NULL DEFAULT 0,
    video_analysis INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, usage_date)
  );

  CREATE INDEX IF NOT EXISTS idx_user_daily_usage_user_date
    ON user_daily_usage (user_id, usage_date);

  CREATE TABLE IF NOT EXISTS server_image_tokens (
    guild_id TEXT PRIMARY KEY,
    image_generations INTEGER NOT NULL DEFAULT 0,
    image_readings INTEGER NOT NULL DEFAULT 0,
    video_analysis INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    task_type TEXT NOT NULL CHECK (task_type IN ('send_message')),
    content TEXT NOT NULL,
    execute_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS server_subscriptions (
    guild_id TEXT PRIMARY KEY,
    tier TEXT NOT NULL DEFAULT 'free',
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_settings (
    user_id TEXT PRIMARY KEY,
    display_name TEXT,
    chat_model TEXT DEFAULT 'qwen/qwen3-32b',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS channel_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL UNIQUE,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    user_tag TEXT,
    user_name TEXT,
    is_bot INTEGER NOT NULL DEFAULT 0,
    content TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_channel_messages_channel
    ON channel_messages (guild_id, channel_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_channel_messages_user
    ON channel_messages (guild_id, channel_id, user_id);
`);

const userSettingsColumns = db.prepare("PRAGMA table_info(user_settings)").all().map((column) => column.name);
if (!userSettingsColumns.includes("display_name")) {
  db.prepare("ALTER TABLE user_settings ADD COLUMN display_name TEXT").run();
}

const scheduledTaskColumns = db.prepare("PRAGMA table_info(scheduled_tasks)").all().map((column) => column.name);
const scheduledTaskMigrations = [
  ["guild_id", "TEXT DEFAULT ''"],
  ["channel_id", "TEXT DEFAULT ''"],
  ["user_id", "TEXT DEFAULT ''"],
  ["task_type", "TEXT DEFAULT 'send_message'"],
  ["content", "TEXT DEFAULT ''"],
  ["execute_at", "TEXT DEFAULT ''"],
  ["is_executed", "INTEGER NOT NULL DEFAULT 0"],
  ["created_at", "TEXT"],
  ["updated_at", "TEXT"],
];

for (const [columnName, definition] of scheduledTaskMigrations) {
  if (!scheduledTaskColumns.includes(columnName)) {
    db.prepare(`ALTER TABLE scheduled_tasks ADD COLUMN ${columnName} ${definition}`).run();
  }
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due
    ON scheduled_tasks (is_executed, execute_at);

  CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_owner
    ON scheduled_tasks (guild_id, user_id, is_executed, execute_at);
`);
