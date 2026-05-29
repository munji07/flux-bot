import {
  HISTORY_BATCH_SIZE,
  MAX_HISTORY_CONTENT_LENGTH,
  MAX_STORED_HISTORY_MESSAGES,
} from "../config.js";

const conversationHistories = new Map();

export function getHistoryKey(message) {
  return `${message.guildId}:${message.channelId}`;
}

export function getConversationHistory(historyKey, shouldUseHistory = false) {
  if (!shouldUseHistory) return [];

  return (conversationHistories.get(historyKey) ?? []).slice(-HISTORY_BATCH_SIZE);
}

export function getStoredHistoryLength(historyKey) {
  return conversationHistories.get(historyKey)?.length ?? 0;
}

export function appendConversationHistory(historyKey, ...messages) {
  const history = conversationHistories.get(historyKey) ?? [];

  for (const message of messages) {
    history.push({
      role: message.role,
      content: trimHistoryContent(message.content),
    });
  }

  while (history.length > MAX_STORED_HISTORY_MESSAGES) {
    history.shift();
  }

  conversationHistories.set(historyKey, history);
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
  if (content.length <= MAX_HISTORY_CONTENT_LENGTH) return content;

  return `${content.slice(0, MAX_HISTORY_CONTENT_LENGTH)}\n...`;
}
