import { db } from "./database.js";

const upsertName = db.prepare(`
  INSERT INTO user_names (user_id, guild_id, username, display_name, global_name, updated_at)
  VALUES (?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(user_id, guild_id) DO UPDATE SET
    username = excluded.username,
    display_name = excluded.display_name,
    global_name = excluded.global_name,
    updated_at = excluded.updated_at
`);

const getNameByUser = db.prepare(`
  SELECT user_id, guild_id, username, display_name, global_name
  FROM user_names
  WHERE user_id = ?
  ORDER BY updated_at DESC
  LIMIT 1
`);

const getNameByUserInGuild = db.prepare(`
  SELECT user_id, guild_id, username, display_name, global_name
  FROM user_names
  WHERE user_id = ? AND guild_id = ?
`);

const getAllNamesByGuild = db.prepare(`
  SELECT user_id, username, display_name, global_name, updated_at
  FROM user_names
  WHERE guild_id = ?
  ORDER BY updated_at DESC
`);

const getAllNames = db.prepare(`
  SELECT user_id, username, display_name, global_name, updated_at
  FROM user_names
  ORDER BY updated_at DESC
`);

const searchNames = db.prepare(`
  SELECT DISTINCT user_id, username, display_name, global_name, updated_at
  FROM user_names
  WHERE user_id = ? OR username LIKE ? OR display_name LIKE ? OR global_name LIKE ?
  ORDER BY updated_at DESC
  LIMIT 20
`);

export function saveUserName(userId, guildId, username, displayName, globalName = "") {
  upsertName.run(userId, guildId, username || "", displayName || username || "", globalName || "");
}

export function getUserName(userId) {
  return getNameByUser.get(userId) || null;
}

export function getUserNameInGuild(userId, guildId) {
  return getNameByUserInGuild.get(userId, guildId) || null;
}

export function getGuildNames(guildId) {
  return getAllNamesByGuild.all(guildId);
}

export function getAllUserNames() {
  return getAllNames.all();
}

export function searchUserNames(query) {
  const pattern = `%${query}%`;
  return searchNames.all(query, pattern, pattern, pattern);
}

export function formatUserNameRecord(row) {
  if (!row) return "알 수 없는 사용자";
  const name = row.display_name || row.username || row.global_name || "";
  return name ? `${name} (ID: \`${row.user_id}\`)` : `ID: \`${row.user_id}\``;
}
