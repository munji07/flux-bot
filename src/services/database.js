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
    PRIMARY KEY (user_id, usage_date)
  );

  CREATE INDEX IF NOT EXISTS idx_user_daily_usage_user_date
    ON user_daily_usage (user_id, usage_date);
`);
