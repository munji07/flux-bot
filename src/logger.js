import { appendFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const LOG_DIR = new URL("../logs/", import.meta.url);
const LOG_FILE = new URL("../logs/bot.log", import.meta.url);
const ERROR_LOG_FILE = new URL("../logs/error.log", import.meta.url);

await mkdir(LOG_DIR, { recursive: true });

export function logInfo(event, details = {}) {
  const record = {
    level: "info",
    occurredAt: new Date().toISOString(),
    event,
    shardId: process.env.SHARD_ID ?? "manager",
    ...details,
  };

  writeLogFile(record);
  writeConsoleInfo(record);
}

export function logError(step, guildId, error, details = {}) {
  const record = {
    level: "error",
    occurredAt: new Date().toISOString(),
    step,
    shardId: process.env.SHARD_ID ?? "manager",
    guildId: guildId ?? "unknown",
    error: serializeError(error),
    ...details,
  };

  errorLogFile(record);
  writeConsoleError(record);
}

function writeLogFile(record) {
  appendFile(LOG_FILE, `${JSON.stringify(record)}\n`, "utf8").catch(() => {});
}

function errorLogFile(record) {
  appendFile(ERROR_LOG_FILE, `${JSON.stringify(record)}\n`, "utf8").catch(() => {});
}

function writeConsoleInfo(record) {
  switch (record.event) {
    case "ai_call":
      console.log(formatCommandLine(record, record.model ?? "unknown"));
      break;
    case "management_command_detected":
      console.log(formatCommandLine(record, "none"));
      break;
    case "bot_ready":
      console.log(`[${formatTime(record.occurredAt)}] 봇 로그인 완료: ${record.botTag}`);
      break;
    case "shard_create":
      console.log(`[${formatTime(record.occurredAt)}] 샤드 생성: #${record.shardId}`);
      break;
    case "shard_ready":
      console.log(`[${formatTime(record.occurredAt)}] 샤드 준비 완료: #${record.shardId}`);
      break;
    case "shard_disconnect":
      console.log(`[${formatTime(record.occurredAt)}] 샤드 연결 끊김: #${record.shardId}`);
      break;
    case "shard_reconnecting":
      console.log(`[${formatTime(record.occurredAt)}] 샤드 재연결 중: #${record.shardId}`);
      break;
    default:
      break;
  }
}

function writeConsoleError(record) {
  const server = record.guildName ?? record.guildId ?? "알 수 없는 서버";
  const message = record.error?.message ?? "알 수 없는 오류";

  console.error(`[${formatTime(record.occurredAt)}] ${server} 서버에서 오류 발생(${record.step}): ${message}`);
}

function formatCommandLine(record, aiModel) {
  const server = record.guildName ?? record.guildId ?? "알 수 없는 서버";
  const user = record.userName ?? record.userTag ?? record.userId ?? "알 수 없는 유저";
  const command = record.commandText ?? record.command ?? "알 수 없는 명령";
  const taskLabel = record.task ? ` ${record.task}` : "";

  return `[${formatTime(record.occurredAt)}] ${server} 서버에서 ${user} 유저가 "!먼지야 ${command}" 명령을 함(처리 ai: ${aiModel}${taskLabel})`;
}

function formatTime(isoDate) {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(isoDate));
}

function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      code: error.code,
      status: error.status,
    };
  }

  return {
    message: String(error),
  };
}
