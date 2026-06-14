import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extname, relative, resolve, sep } from "node:path";
import { ADMIN_USER_ID } from "../config.js";
import { groqClient, stripReasoningTags } from "./ai.js";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const LOG_FILES = [
  { label: "bot.log", url: new URL("../../logs/bot.log", import.meta.url) },
  { label: "error.log", url: new URL("../../logs/error.log", import.meta.url) },
];
const DEFAULT_SOURCE_FILES = [
  "src/handlers/messageCreate.js",
  "src/services/ai.js",
  "src/services/logSearch.js",
  "src/commands/management.js",
  "src/commands/subscription.js",
  "src/handlers/googleSearch.js",
];
const ALLOWED_SOURCE_EXTENSIONS = new Set([".js", ".json", ".md"]);
const BLOCKED_PATH_PARTS = new Set([".env", "node_modules", ".git", "logs", "data"]);
const MAX_LOG_LINES_PER_FILE = 25;
const MAX_SOURCE_CHARS_PER_FILE = 1200;
const MAX_TOTAL_SOURCE_CHARS = 5000;
const MAX_DISCORD_EDIT_CHARS = 1900;

export async function handleDeveloperDiagnosticsRequest(message, intent, loadingMessage) {
  if (message.author.id !== ADMIN_USER_ID) {
    await loadingMessage.edit("이 진단 도구는 최고 개발자만 사용할 수 있어요.");
    return true;
  }

  const args = intent?.arguments ?? {};
  const query = String(args.query || "최근 오류를 분석해줘").trim();
  const includeSource = args.includeSource !== false;
  const requestedFiles = Array.isArray(args.files) ? args.files : [];
  const sourceFiles = includeSource ? readSourceFiles(requestedFiles) : [];
  const logs = readRecentLogs();

  const answer = await createDeveloperDiagnosticsAnswer({
    query,
    logs,
    sourceFiles,
  });

  await loadingMessage.edit(truncate(answer || "진단 결과를 만들지 못했어요.", MAX_DISCORD_EDIT_CHARS));
  return true;
}

function readRecentLogs() {
  return LOG_FILES.map((file) => {
    if (!existsSync(file.url)) {
      return { file: file.label, lines: [] };
    }

    const lines = readFileSync(file.url, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-MAX_LOG_LINES_PER_FILE)
      .map((line) => {
        try {
          const record = JSON.parse(line);
          return JSON.stringify({
            level: record.level,
            occurredAt: record.occurredAt,
            event: record.event,
            step: record.step,
            task: record.task,
            model: record.model,
            guildId: record.guildId,
            channelId: record.channelId,
            userId: record.userId,
            commandText: record.commandText,
            error: record.error
              ? {
                  name: record.error.name,
                  message: record.error.message,
                  stack: truncate(record.error.stack, 1600),
                  code: record.error.code,
                  status: record.error.status,
                }
              : undefined,
          });
        } catch {
          return truncate(line, 1800);
        }
      });

    return { file: file.label, lines };
  });
}

function readSourceFiles(requestedFiles) {
  const files = requestedFiles.length > 0 ? requestedFiles : DEFAULT_SOURCE_FILES;
  const selected = [];
  let totalChars = 0;

  for (const filePath of files) {
    const resolved = resolve(PROJECT_ROOT, String(filePath));
    if (!isAllowedSourcePath(resolved)) continue;
    if (!existsSync(resolved)) continue;

    const content = truncate(readFileSync(resolved, "utf8"), MAX_SOURCE_CHARS_PER_FILE);
    if (totalChars + content.length > MAX_TOTAL_SOURCE_CHARS) break;

    selected.push({
      path: normalizeRelativePath(relative(PROJECT_ROOT, resolved)),
      content,
    });
    totalChars += content.length;
  }

  return selected;
}

function isAllowedSourcePath(resolvedPath) {
  const relativePath = relative(PROJECT_ROOT, resolvedPath);
  if (!relativePath || relativePath.startsWith("..") || relativePath.includes(`..${sep}`)) return false;

  const normalized = normalizeRelativePath(relativePath);
  const parts = normalized.split("/");
  if (parts.some((part) => BLOCKED_PATH_PARTS.has(part))) return false;

  return ALLOWED_SOURCE_EXTENSIONS.has(extname(normalized));
}

function normalizeRelativePath(path) {
  return path.split(sep).join("/");
}

async function createDeveloperDiagnosticsAnswer({ query, logs, sourceFiles }) {
  const completion = await groqClient.chat.completions.create({
    model: "qwen/qwen3-32b",
    messages: [
      {
        role: "system",
        content: [
          "You are a senior Node.js Discord bot debugging assistant.",
          "Analyze only the provided logs and source snippets.",
          "Answer in Korean, concise but actionable.",
          "Prioritize likely root causes, exact files/functions, and next fixes.",
          "Never ask for secrets and never print environment variable values.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          query,
          recentLogs: logs,
          sourceFiles,
        }),
      },
    ],
    temperature: 0.2,
    max_completion_tokens: 1200,
  });

  return stripReasoningTags(completion.choices?.[0]?.message?.content ?? "");
}

function truncate(value, maxLength) {
  const text = String(value ?? "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}
