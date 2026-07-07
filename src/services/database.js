import "dotenv/config";
import pg from "pg";

function getDatabaseUrl() {
  let rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) return null;

  rawUrl = rawUrl.trim();
  if ((rawUrl.startsWith("'") && rawUrl.endsWith("'")) || (rawUrl.startsWith('"') && rawUrl.endsWith('"'))) {
    rawUrl = rawUrl.slice(1, -1);
  }

  const url = new URL(rawUrl);
  url.searchParams.delete("sslmode");
  url.searchParams.delete("channel_binding");
  return url.toString();
}

const pool = new pg.Pool({
  connectionString: getDatabaseUrl(),
  ssl: { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error:", err);
});

function toArray(params) {
  if (params == null) return [];
  if (Array.isArray(params)) return params;
  return [params];
}

function prepare(sql, params) {
  if (params && typeof params === "object" && !Array.isArray(params)) {
    const keys = Object.keys(params);
    const values = keys.map((k) => params[k]);
    const text = sql.replace(/@(\w+)/g, (_, name) => {
      const idx = keys.indexOf(name);
      if (idx === -1) return `@${name}`;
      return `$${idx + 1}`;
    });
    return { text, values };
  }
  const arr = toArray(params);
  let i = 0;
  const text = sql.replace(/\?/g, () => `$${++i}`);
  return { text, values: arr };
}

function makeQuery(clientOrPool) {
  return {
    async get(sql, ...params) {
      const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
      const { text, values } = prepare(sql, flat);
      const result = await clientOrPool.query(text, values);
      return result.rows[0] ?? null;
    },
    async all(sql, ...params) {
      const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
      const { text, values } = prepare(sql, flat);
      const result = await clientOrPool.query(text, values);
      return result.rows;
    },
    async run(sql, ...params) {
      const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
      const { text, values } = prepare(sql, flat);
      const result = await clientOrPool.query(text, values);
      return { changes: result.rowCount, lastInsertRowid: result.rows?.[0]?.id ?? null };
    },
  };
}

export const db = {
  ...makeQuery(pool),
  async exec(sql) {
    await pool.query(sql);
  },
  async transact(callback) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const tx = makeQuery(client);
      const result = await callback(tx);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
  async end() {
    await pool.end();
  },
};

async function ensureSchema() {
  await db.exec(`

    CREATE TABLE IF NOT EXISTS conversation_messages (
      id SERIAL PRIMARY KEY,
      history_key TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      channel_id TEXT,
      user_id TEXT NOT NULL,
      user_tag TEXT,
      user_name TEXT,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE INDEX IF NOT EXISTS idx_conversation_messages_history_id
      ON conversation_messages (history_key, id);

    CREATE INDEX IF NOT EXISTS idx_conversation_messages_user_created
      ON conversation_messages (guild_id, user_id, created_at);

    CREATE TABLE IF NOT EXISTS user_subscriptions (
      user_id TEXT PRIMARY KEY,
      tier TEXT NOT NULL DEFAULT 'free',
      expires_at TEXT,
      reminder_sent INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT NOT NULL DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS user_daily_usage (
      user_id TEXT NOT NULL,
      usage_date TEXT NOT NULL DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD'),
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
      created_at TEXT NOT NULL DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT NOT NULL DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL DEFAULT '',
      channel_id TEXT NOT NULL DEFAULT '',
      user_id TEXT NOT NULL DEFAULT '',
      task_type TEXT NOT NULL DEFAULT 'send_message' CHECK (task_type IN ('send_message')),
      content TEXT NOT NULL DEFAULT '',
      execute_at TEXT NOT NULL DEFAULT '',
      is_executed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due
      ON scheduled_tasks (is_executed, execute_at);

    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_owner
      ON scheduled_tasks (guild_id, user_id, is_executed, execute_at);

    CREATE TABLE IF NOT EXISTS server_subscriptions (
      guild_id TEXT PRIMARY KEY,
      tier TEXT NOT NULL DEFAULT 'free',
      expires_at TEXT,
      reminder_sent INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT NOT NULL DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY,
      display_name TEXT,
      chat_model TEXT DEFAULT 'qwen/qwen3-32b',
      updated_at TEXT NOT NULL DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS channel_messages (
      id SERIAL PRIMARY KEY,
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

    CREATE TABLE IF NOT EXISTS user_names (
      user_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      username TEXT NOT NULL DEFAULT '',
      display_name TEXT NOT NULL DEFAULT '',
      global_name TEXT DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS'),
      PRIMARY KEY (user_id, guild_id)
    );

    CREATE INDEX IF NOT EXISTS idx_user_names_user
      ON user_names (user_id);

    CREATE INDEX IF NOT EXISTS idx_user_names_guild
      ON user_names (guild_id);

    CREATE TABLE IF NOT EXISTS ai_channels (
      channel_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS eco_users (
      user_id TEXT PRIMARY KEY,
      coins INTEGER NOT NULL DEFAULT 0,
      last_fishing TEXT,
      last_mining TEXT,
      last_farming TEXT,
      last_daily TEXT,
      display_name TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT NOT NULL DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS eco_inventory (
      user_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, item_id)
    );

    CREATE TABLE IF NOT EXISTS eco_quests (
      user_id TEXT NOT NULL,
      quest_id TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0,
      quest_date TEXT NOT NULL DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD'),
      PRIMARY KEY (user_id, quest_id, quest_date)
    );

    CREATE TABLE IF NOT EXISTS eco_achievements (
      user_id TEXT NOT NULL,
      achievement_id TEXT NOT NULL,
      unlocked_at TEXT NOT NULL DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS'),
      PRIMARY KEY (user_id, achievement_id)
    );

    CREATE TABLE IF NOT EXISTS raid_config (
      guild_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS crop_notification_settings (
      user_id TEXT NOT NULL,
      crop_id TEXT NOT NULL DEFAULT 'all',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS'),
      PRIMARY KEY (user_id, crop_id)
    );

  `);

  try { await db.exec("ALTER TABLE eco_users ADD COLUMN display_name TEXT DEFAULT ''"); } catch (e) { /* already exists */ }
  try { await db.exec("ALTER TABLE eco_users ADD COLUMN fishing_streak INTEGER DEFAULT 0"); } catch (e) { /* already exists */ }
  try { await db.exec("ALTER TABLE eco_users ADD COLUMN game_streak INTEGER DEFAULT 0"); } catch (e) { /* already exists */ }
  try { await db.exec("ALTER TABLE eco_users ADD COLUMN highest_roulette_win INTEGER DEFAULT 0"); } catch (e) { /* already exists */ }
}

await ensureSchema();
