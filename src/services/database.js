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
`);
