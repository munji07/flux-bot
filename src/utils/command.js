export function splitArgs(input) {
  const text = String(input ?? "");
  return text.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^["']|["']$/g, "")) ?? [];
}

export function normalizeCommand(command) {
  const text = String(command ?? "");
  return text.toLowerCase().replace(/[\s_-]/g, "");
}

export function extractDiscordId(value) {
  if (!value) return null;
  const text = String(value);
  return text.match(/^<[@#&]!?(\d+)>$/)?.[1] ?? text.match(/^\d{16,22}$/)?.[0] ?? null;
}
