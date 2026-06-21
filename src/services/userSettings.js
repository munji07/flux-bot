import { db } from "./database.js";

export function getUserDisplayName(userId) {
  const row = db.prepare("SELECT display_name FROM user_settings WHERE user_id = ?").get(userId);
  return sanitizeDisplayName(row?.display_name);
}

export function setUserDisplayName(userId, displayName) {
  const sanitized = sanitizeDisplayName(displayName);
  if (!sanitized) return null;

  db.prepare(`
    INSERT INTO user_settings (user_id, display_name, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      display_name = excluded.display_name,
      updated_at = excluded.updated_at
  `).run(userId, sanitized);

  return sanitized;
}

export function clearUserDisplayName(userId) {
  db.prepare(`
    INSERT INTO user_settings (user_id, display_name, updated_at)
    VALUES (?, NULL, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      display_name = NULL,
      updated_at = excluded.updated_at
  `).run(userId);
}

function sanitizeDisplayName(value) {
  const text = String(value ?? "").replace(/[\r\n[\]]/g, " ").trim();
  return text.slice(0, 40) || null;
}
