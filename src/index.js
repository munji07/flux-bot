import { ShardingManager } from "discord.js";
import { validateEnv } from "./config/config.js";
import { logError, logInfo } from "./logger.js";

validateEnv();

const manager = new ShardingManager("./src/bot.js", {
  token: process.env.DISCORD_TOKEN,
  totalShards: "auto",
  respawn: true,
});

manager.on("shardCreate", (shard) => {
  logInfo("shard_create", {
    shardId: shard.id,
  });

  shard.on("ready", () => {
    logInfo("shard_ready", {
      shardId: shard.id,
    });
  });

  shard.on("disconnect", () => {
    logInfo("shard_disconnect", {
      shardId: shard.id,
    });
  });

  shard.on("reconnecting", () => {
    logInfo("shard_reconnecting", {
      shardId: shard.id,
    });
  });

  shard.on("death", (process) => {
    logError("shard_death", "unknown", new Error(`Shard exited with code ${process.exitCode}`), {
      shardId: shard.id,
      exitCode: process.exitCode,
    });
  });

  shard.on("error", (error) => {
    logError("shard_error", "unknown", error, {
      shardId: shard.id,
    });
  });
});

manager.spawn().catch((error) => {
  logError("shard_spawn", "unknown", error);
  process.exit(1);
});
