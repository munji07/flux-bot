import {
  HISTORY_BATCH_SIZE,
  MAX_HISTORY_CONTENT_LENGTH,
  MAX_STORED_HISTORY_MESSAGES,
} from "../config/config.js";
import { db } from "./database.js";

const selectRecentHistory = db.prepare(`
  SELECT role, content
  FROM conversation_messages
  WHERE history_key = ?
  ORDER BY id DESC
  LIMIT ?
`);

const countHistory = db.prepare(`
  SELECT COUNT(*) AS count
  FROM conversation_messages
  WHERE history_key = ?
`);

const insertMessage = db.prepare(`
  INSERT INTO conversation_messages (
    history_key,
    guild_id,
    channel_id,
    user_id,
    user_tag,
    user_name,
    role,
    content
  )
  VALUES (
    @historyKey,
    @guildId,
    @channelId,
    @userId,
    @userTag,
    @userName,
    @role,
    @content
  )
`);

const trimOldHistory = db.prepare(`
  DELETE FROM conversation_messages
  WHERE history_key = ?
    AND id NOT IN (
      SELECT id
      FROM conversation_messages
      WHERE history_key = ?
      ORDER BY id DESC
      LIMIT ?
    )
`);

const appendMessagesTransaction = db.transaction((historyKey, metadata, messages) => {
  for (const message of messages) {
    insertMessage.run({
      historyKey,
      guildId: metadata.guildId,
      channelId: metadata.channelId ?? null,
      userId: metadata.userId,
      userTag: metadata.userTag ?? null,
      userName: metadata.userName ?? null,
      role: message.role,
      content: trimHistoryContent(message.content),
    });
  }

  trimOldHistory.run(historyKey, historyKey, MAX_STORED_HISTORY_MESSAGES);
});

export function getHistoryKey(message) {
  return `${message.guildId}:${message.author.id}`;
}

export function getConversationHistory(historyKey, shouldUseHistory = false) {
  if (!shouldUseHistory) return [];

  return selectRecentHistory
    .all(historyKey, HISTORY_BATCH_SIZE)
    .reverse()
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));
}

export function getStoredHistoryLength(historyKey) {
  return countHistory.get(historyKey)?.count ?? 0;
}

export function appendConversationHistory(historyKey, metadata, ...messages) {
  appendMessagesTransaction(historyKey, metadata, messages);
}

export function shouldUseConversationHistory(userPrompt) {
  const normalizedPrompt = userPrompt.trim().toLowerCase();

  if (normalizedPrompt.length <= 20) return true;

  const contextHints = [
    "아까",
    "방금",
    "이전",
    "전에",
    "위에",
    "그거",
    "그건",
    "그게",
    "그걸",
    "그 내용",
    "이어서",
    "계속",
    "더 설명",
    "다시",
    "요약",
    "정리해",
    "그 사람",
    "그 유저",
    "저거",
    "이거",
    "it",
    "that",
    "this",
    "continue",
    "again",
  ];

  return contextHints.some((hint) => normalizedPrompt.includes(hint));
}

function trimHistoryContent(content) {
  // content가 string이 아닌 경우(배열 등) JSON으로 변환하여 Groq API 오류 방지
  const str = typeof content === "string" ? content : JSON.stringify(content ?? "");
  if (str.length <= MAX_HISTORY_CONTENT_LENGTH) return str;

  return `${str.slice(0, MAX_HISTORY_CONTENT_LENGTH)}\n...`;
}
