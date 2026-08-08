import { ADMIN_USER_ID } from "../config.js";
import { logError, logInfo } from "../logger.js";

const recentRequests = [];
const MAX_RECENT_REQUESTS = 100;
let consecutiveApiFailures = 0;
let lastAlertAt = 0;
const ALERT_COOLDOWN_MS = 15 * 60 * 1000;

export function recordAiRequest({ task, model, durationMs, success, error = null }) {
  const record = { task, model, durationMs, success, occurredAt: new Date().toISOString() };
  recentRequests.push(record);
  if (recentRequests.length > MAX_RECENT_REQUESTS) recentRequests.shift();

  if (success) consecutiveApiFailures = 0;
  else consecutiveApiFailures += 1;

  logInfo("ai_request_metric", record);
  if (error) logError("ai_request_failed", "unknown", error, record);
}

export function getRuntimeStatus() {
  const successful = recentRequests.filter((request) => request.success);
  const failed = recentRequests.length - successful.length;
  const averageDurationMs = successful.length === 0
    ? 0
    : Math.round(successful.reduce((sum, request) => sum + request.durationMs, 0) / successful.length);

  return {
    recentRequestCount: recentRequests.length,
    failedRequestCount: failed,
    averageDurationMs,
    consecutiveApiFailures,
    lastRequestAt: recentRequests.at(-1)?.occurredAt ?? null,
  };
}

export async function notifyApiFailure(client, error, context = {}) {
  const now = Date.now();
  if (consecutiveApiFailures < 3 || now - lastAlertAt < ALERT_COOLDOWN_MS) return;
  lastAlertAt = now;

  try {
    const admin = await client.users.fetch(ADMIN_USER_ID);
    await admin.send([
      "⚠️ FLUX API 장애 알림",
      `최근 API 요청이 ${consecutiveApiFailures}회 연속 실패했어요.`,
      `작업: ${context.task ?? "알 수 없음"}`,
      `오류: ${error?.message ?? "알 수 없는 오류"}`,
    ].join("\n"));
  } catch (notifyError) {
    logError("api_failure_notification", "unknown", notifyError, context);
  }
}
