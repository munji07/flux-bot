import { db } from "./database.js";

export async function saveUserName(userId, guildId, username, displayName, globalName = "") {
  await db.run(
    `INSERT INTO user_names (user_id, guild_id, username, display_name, global_name, updated_at)
     VALUES ($1, $2, $3, $4, $5, TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
     ON CONFLICT(user_id, guild_id) DO UPDATE SET
       username = EXCLUDED.username,
       display_name = EXCLUDED.display_name,
       global_name = EXCLUDED.global_name,
       updated_at = EXCLUDED.updated_at`,
    [userId, guildId, username || "", displayName || username || "", globalName || ""],
  );
}

export async function getUserName(userId) {
  const row = await db.get(
    "SELECT user_id, guild_id, username, display_name, global_name FROM user_names WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1",
    [userId],
  );
  return row || null;
}

export async function getUserNameInGuild(userId, guildId) {
  const row = await db.get(
    "SELECT user_id, guild_id, username, display_name, global_name FROM user_names WHERE user_id = $1 AND guild_id = $2",
    [userId, guildId],
  );
  return row || null;
}

export async function getGuildNames(guildId) {
  return db.all(
    "SELECT user_id, username, display_name, global_name, updated_at FROM user_names WHERE guild_id = $1 ORDER BY updated_at DESC",
    [guildId],
  );
}

export async function getAllUserNames() {
  return db.all(
    "SELECT user_id, username, display_name, global_name, updated_at FROM user_names ORDER BY updated_at DESC",
  );
}

export async function searchUserNames(query) {
  const pattern = `%${query}%`;
  return db.all(
    `SELECT DISTINCT user_id, username, display_name, global_name, updated_at
     FROM user_names
     WHERE user_id = $1 OR username LIKE $2 OR display_name LIKE $3 OR global_name LIKE $4
     ORDER BY updated_at DESC
     LIMIT 20`,
    [query, pattern, pattern, pattern],
  );
}

export function formatUserNameRecord(row) {
  if (!row) return "알 수 없는 사용자";
  const name = row.display_name || row.username || row.global_name || "";
  return name ? `${name} (ID: \`${row.user_id}\`)` : `ID: \`${row.user_id}\``;
}
