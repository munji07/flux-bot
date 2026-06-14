import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { ADMIN_USER_ID } from "../config.js";
import { UserFacingError } from "../errors.js";
import { createLogSearchAnswer } from "./ai.js";
import { decrementUsage } from "./subscription.js";

const LOG_FILES = [
  new URL("../../logs/bot.log", import.meta.url),
  new URL("../../logs/error.log", import.meta.url),
];
const DEFAULT_LOOKBACK_DAYS = 7;
const MAX_CANDIDATE_RECORDS = 250;
const MAX_LOG_SEARCH_PAYLOAD_CHARS = 4000;
const TIME_ZONE = "Asia/Seoul";

export async function handleLogSearchRequest(message, userPrompt, loadingMessage) {
  if (message.author.id !== ADMIN_USER_ID) {
    throw new UserFacingError("로그 조회는 최고 관리자만 사용할 수 있어요.");
  }

  const timeRange = resolveTimeRange(userPrompt);
  const records = findLogRecords({
    guildId: message.guildId,
    timeRange,
  });

  if (records.length === 0) {
    await loadingMessage.edit(`${timeRange.label}에 해당하는 로그를 찾지 못했어요.`);
    return true;
  }

  const request = {
    userPrompt,
    records,
    timeRangeLabel: timeRange.label,
    requester: {
      userId: message.author.id,
      userName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
      userTag: message.author.tag,
    },
    logContext: {
      guildId: message.guildId,
      guildName: message.guild.name,
      channelId: message.channelId,
      userId: message.author.id,
      userTag: message.author.tag,
      commandText: userPrompt,
    },
  };

  let answer;
  try {
    answer = await createLogSearchAnswer(request);
  } catch (error) {
    if (isPayloadTooLargeError(error)) {
      decrementUsage(message.author.id, "ai_calls");
      await loadingMessage.edit("조회하려는 로그 데이터가 너무 많아 AI가 분석할 수 없습니다. 특정 서버 ID나 더 좁은 시간 범위(예: '10분 전', '오늘 오후 2시')를 지정해서 다시 질문해 주세요.");
      return true;
    }
    throw error;
  }

  await loadingMessage.edit(answer || "로그는 찾았는데 요약 답변을 만들지 못했어요.");
  return true;
}

function findLogRecords({ guildId, timeRange }) {
  const records = readLogRecords()
    .filter((record) => record.guildId === guildId)
    .filter((record) => isWithinTimeRange(record.occurredAt, timeRange))
    .sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt))
    .slice(0, MAX_CANDIDATE_RECORDS)
    .map((record) => simplifyRecord(record))
    .sort((a, b) => {
      const priorityDiff = getRecordPriority(b) - getRecordPriority(a);
      if (priorityDiff !== 0) return priorityDiff;
      return new Date(b.occurredAtRaw) - new Date(a.occurredAtRaw);
    });

  return fitRecordsToPayloadBudget(records)
    .sort((a, b) => new Date(a.occurredAtRaw) - new Date(b.occurredAtRaw))
    .map(({ occurredAtRaw, ...record }) => record);
}

function getRecordPriority(record) {
  const action = record.cls?.action;
  if (record.level === "error") return 4;
  if (action === "timeout_member_error" || action === "management_error" || action === "log_search_error") return 4;
  if (record.cls?.target) return 3;
  if (record.command) return 2;
  if (record.event?.startsWith("management_")) return 2;
  return 1;
}

function readLogRecords() {
  const records = [];

  for (const file of LOG_FILES) {
    if (!existsSync(file)) continue;

    // 전체 파일을 읽는 대신 마지막 1MB만 읽도록 개선 (DoS 방지)
    const stats = statSync(file);
    const fileSize = stats.size;
    const bufferSize = Math.min(fileSize, 1024 * 1024); // Max 1MB
    const buffer = Buffer.alloc(bufferSize);
    
    const fd = openSync(file, 'r');
    readSync(fd, buffer, 0, bufferSize, Math.max(0, fileSize - bufferSize));
    closeSync(fd);

    const lines = buffer.toString('utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        records.push(JSON.parse(line));
      } catch {
        // Ignore partial log lines from an interrupted write.
      }
    }
  }

  return records;
}

function splitLines(text) {
  const lines = [];
  let current = "";

  for (const char of text) {
    if (char === "\n") {
      lines.push(current.endsWith("\r") ? current.slice(0, -1) : current);
      current = "";
      continue;
    }

    current += char;
  }

  if (current) lines.push(current.endsWith("\r") ? current.slice(0, -1) : current);
  return lines;
}

function simplifyRecord(record) {
  const classification = classifyRecord(record);

  return removeEmptyFields({
    occurredAtRaw: record.occurredAt,
    t: formatKoreanDateTime(record.occurredAt),
    cls: classification,
    level: record.level,
    event: record.event,
    step: record.step,
    task: record.task,
    model: record.model,
    command: record.command,
    text: truncateText(record.commandText, 220),
    actorId: record.userId,
    actorName: record.userName,
    actorTag: record.userTag,
    targetId: record.targetUserId,
    targetName: record.targetUserName,
    targetTag: record.targetUserTag,
    oldNick: truncateText(record.oldNickname, 120),
    newNick: truncateText(record.newNickname, 120),
    answerLength: record.answerLength,
    error: truncateText(record.error?.message, 260),
  });
}

function classifyRecord(record) {
  const command = record.command ?? "";
  const event = record.event ?? "";
  const step = record.step ?? "";
  const text = record.commandText ?? "";

  const action =
    getActionFromCommand(command) ??
    getActionFromEvent(event) ??
    getActionFromStep(step) ??
    getActionFromTask(record.task) ??
    "unknown";

  return removeEmptyFields({
    action,
    actor: removeEmptyFields({
      id: record.userId,
      name: record.userName,
      tag: record.userTag,
    }),
    target: removeEmptyFields({
      id: record.targetUserId,
      name: record.targetUserName,
      tag: record.targetUserTag,
      hint: getTargetHint(command, text, event),
    }),
    object: getActionObject(record, action),
    source: event || step || command || record.task,
  });
}

function getActionFromEvent(event) {
  return {
    nickname_changed: "change_nickname",
    member_timed_out: "timeout_member",
    management_command_completed: "management_command_completed",
    management_command_detected: "management_command_detected",
    management_confirmation_requested: "management_confirmation_requested",
    ai_call: "ai_call",
    answer_sent: "answer_sent",
    image_generation_detected: "image_generation_detected",
    image_generation_completed: "image_generation_completed",
  }[event];
}

function getActionFromCommand(command) {
  return {
    timeoutMember: "timeout_member",
    kickMember: "kick_member",
    banMember: "ban_member",
    changeNickname: "change_nickname",
    deleteMessage: "delete_message",
    purgeMessages: "purge_messages",
    addRole: "add_role",
    removeRole: "remove_role",
    addRolePermission: "add_role_permission",
    removeRolePermission: "remove_role_permission",
    muteMember: "server_mute_member",
    deafenMember: "server_deafen_member",
    moveMember: "move_member",
    disconnectMember: "disconnect_member",
    setSlowMode: "set_slow_mode",
    setVerificationLevel: "set_verification_level",
    autoMod: "configure_automod",
    auditLog: "read_audit_log",
  }[command];
}

function getActionFromStep(step) {
  if (!step) return null;
  if (step.startsWith("management_timeoutMember")) return "timeout_member_error";
  if (step.startsWith("management_")) return "management_error";
  if (step === "log_search") return "log_search_error";
  return null;
}

function getActionFromTask(task) {
  return {
    intent_classification: "classify_intent",
    log_search_summary: "summarize_logs",
    chat: "chat_completion",
    chat_stream: "chat_completion",
    image_generation: "generate_image",
  }[task];
}

function getActionObject(record, action) {
  if (action === "change_nickname") {
    return removeEmptyFields({
      oldNickname: truncateText(record.oldNickname, 80),
      newNickname: truncateText(record.newNickname, 80),
    });
  }

  if (action === "timeout_member") {
    return removeEmptyFields({
      durationMs: record.durationMs,
      reason: truncateText(record.reason, 120),
    });
  }

  return undefined;
}

function getTargetHint(command, text, event) {
  if (!command || !text) return undefined;
  const tokens = splitWhitespace(text);
  if (tokens.length === 0) return undefined;
  const likelyTarget = event?.startsWith("management_") ? tokens[1] : tokens[0];

  if (!likelyTarget) return undefined;

  if (likelyTarget.startsWith("<@") || isLongNumericId(likelyTarget)) {
    return truncateText(likelyTarget, 80);
  }

  if (command === "timeoutMember" || command === "kickMember" || command === "changeNickname") {
    return truncateText(likelyTarget, 80);
  }

  return undefined;
}

function fitRecordsToPayloadBudget(records) {
  const selected = [];
  let size = 2;

  for (const record of records) {
    const json = JSON.stringify(record);
    const nextSize = size + json.length + (selected.length > 0 ? 1 : 0);
    if (nextSize > MAX_LOG_SEARCH_PAYLOAD_CHARS) break;

    selected.push(record);
    size = nextSize;
  }

  return selected;
}

function removeEmptyFields(record) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined && value !== null && value !== "" && !isEmptyObject(value)),
  );
}

function isEmptyObject(value) {
  return typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
}

function truncateText(value, maxLength) {
  if (typeof value !== "string") return value;
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}

export function isPayloadTooLargeError(error) {
  return error?.status === 413;
}

function resolveTimeRange(prompt, now = new Date()) {
  return {
    start: new Date(now.getTime() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000),
    end: now,
    label: `최근 ${DEFAULT_LOOKBACK_DAYS}일`,
  };
}

function splitWhitespace(text) {
  const tokens = [];
  let current = "";

  for (const char of text.trim()) {
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) tokens.push(current);
  return tokens;
}

function isLongNumericId(value) {
  if (value.length < 10) return false;

  for (const char of value) {
    if (char < "0" || char > "9") return false;
  }

  return true;
}

function isWithinTimeRange(occurredAt, timeRange) {
  const occurred = new Date(occurredAt);
  return occurred >= timeRange.start && occurred < timeRange.end;
}

function formatKoreanDateTime(isoDate) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(isoDate));
}
