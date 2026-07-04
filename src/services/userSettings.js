import { db } from "./database.js";

export async function getUserDisplayName(userId) {
  const row = await db.get("SELECT display_name FROM user_settings WHERE user_id = $1", [userId]);
  return sanitizeDisplayName(row?.display_name);
}

export async function setUserDisplayName(userId, displayName) {
  const sanitized = sanitizeDisplayName(displayName);
  if (!sanitized) return null;

  await db.run(
    `INSERT INTO user_settings (user_id, display_name, updated_at)
     VALUES ($1, $2, TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
     ON CONFLICT(user_id) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       updated_at = EXCLUDED.updated_at`,
    [userId, sanitized],
  );

  return sanitized;
}

export async function clearUserDisplayName(userId) {
  await db.run(
    `INSERT INTO user_settings (user_id, display_name, updated_at)
     VALUES ($1, NULL, TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
     ON CONFLICT(user_id) DO UPDATE SET
       display_name = NULL,
       updated_at = EXCLUDED.updated_at`,
    [userId],
  );
}

function sanitizeDisplayName(value) {
  const text = String(value ?? "").replace(/[\r\n[\]]/g, " ").trim();
  return text.slice(0, 40) || null;
}
