import { ShardingManager } from "discord.js";
import { validateEnv } from "./config/config.js";
import { logError, logInfo } from "./logger.js";
import { db } from "./services/database.js";

validateEnv();

const manager = new ShardingManager("./src/bot.js", {
  token: process.env.DISCORD_TOKEN,
  totalShards: "auto",
  respawn: true,
});

async function shutdown(signal) {
  logInfo("shutdown_start", { signal });

  try {
    // ShardingManager에는 shutdown() 메서드가 없으므로 각 shard를 개별 종료
    const shards = manager.shards ? Array.from(manager.shards.values()) : [];
    for (const shard of shards) {
      try {
        await shard.kill();
      } catch (shardErr) {
        logError("shard_kill", "unknown", shardErr);
      }
    }
    logInfo("shard_shutdown", { signal });
  } catch (err) {
    logError("shard_shutdown", "unknown", err);
  }

  try {
    await db.end();
    logInfo("database_closed");
  } catch (err) {
    logError("database_close", "unknown", err);
  }

  logInfo("shutdown_complete");
  process.exit(0);
}

manager.on("shardCreate", (shard) => {
  logInfo("shard_create", {
    shardId: shard.id,
  });
});

manager.spawn();

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
