export function splitArgs(input) {
  return input.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^["']|["']$/g, "")) ?? [];
}

export function normalizeCommand(command) {
  return command.toLowerCase().replace(/[\s_-]/g, "");
}

export function extractDiscordId(value) {
  if (!value) return null;
  return value.match(/^<[@#&]!?(\d+)>$/)?.[1] ?? value.match(/^\d{16,22}$/)?.[0] ?? null;
}
