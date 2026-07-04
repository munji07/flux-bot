import {
  HISTORY_BATCH_SIZE,
  MAX_HISTORY_CONTENT_LENGTH,
  MAX_STORED_HISTORY_MESSAGES,
} from "../config/config.js";
import { db } from "./database.js";

export function getHistoryKey(message) {
  return `${message.guildId}:${message.author.id}`;
}

export async function getConversationHistory(historyKey, shouldUseHistory = false) {
  if (!shouldUseHistory) return [];

  const rows = await db.all(
    "SELECT role, content FROM conversation_messages WHERE history_key = $1 ORDER BY id DESC LIMIT $2",
    [historyKey, HISTORY_BATCH_SIZE],
  );

  return rows.reverse().map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

export async function getStoredHistoryLength(historyKey) {
  const row = await db.get("SELECT COUNT(*) AS count FROM conversation_messages WHERE history_key = $1", [historyKey]);
  return row?.count ?? 0;
}

export async function appendConversationHistory(historyKey, metadata, ...messages) {
  await db.transact(async (tx) => {
    for (const message of messages) {
      await tx.run(
        `INSERT INTO conversation_messages (history_key, guild_id, channel_id, user_id, user_tag, user_name, role, content)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          historyKey,
          metadata.guildId,
          metadata.channelId ?? null,
          metadata.userId,
          metadata.userTag ?? null,
          metadata.userName ?? null,
          message.role,
          trimHistoryContent(message.content),
        ],
      );
    }

    await tx.run(
      `DELETE FROM conversation_messages
       WHERE history_key = $1
         AND id NOT IN (
           SELECT id FROM conversation_messages
           WHERE history_key = $2
           ORDER BY id DESC
           LIMIT $3
         )`,
      [historyKey, historyKey, MAX_STORED_HISTORY_MESSAGES],
    );
  });
}

export function shouldUseConversationHistory(userPrompt) {
  const normalizedPrompt = userPrompt.trim().toLowerCase();

  if (normalizedPrompt.length <= 20) return true;

  const contextHints = [
    "아까", "방금", "이전", "전에", "위에", "그거", "그건", "그게", "그걸", "그 내용",
    "이어서", "계속", "더 설명", "다시", "요약", "정리해", "그 사람", "그 유저",
    "저거", "이거", "it", "that", "this", "continue", "again",
  ];

  return contextHints.some((hint) => normalizedPrompt.includes(hint));
}

function trimHistoryContent(content) {
  const str = typeof content === "string" ? content : JSON.stringify(content ?? "");
  if (str.length <= MAX_HISTORY_CONTENT_LENGTH) return str;
  return `${str.slice(0, MAX_HISTORY_CONTENT_LENGTH)}\n...`;
}
