import { Client, Events, ActivityType, Partials } from "discord.js";
import { CLIENT_INTENTS, validateEnv } from "./config.js";
import { handleMessageCreate } from "./handlers/messageCreate.js";
import { handleInteractionCreate } from "./handlers/interactionCreate.js";
import { logError, logInfo } from "./logger.js";
import { startScheduler } from "./services/scheduler.js";
import { preloadWordCache } from "./services/wordCache.js";

validateEnv();
preloadWordCache();

const discordClient = new Client({
  intents: CLIENT_INTENTS,
  partials: [Partials.Channel, Partials.Message],
});

discordClient.once(Events.ClientReady, (client) => {
  logInfo("bot_ready", {
    botTag: client.user.tag,
    botId: client.user.id,
    shardIds: client.shard?.ids ?? [],
  });

  client.user.setPresence({
    status: "online",
    activities: [
      {
        name: "'!FLUX 도움말' 로 기능을 안내해드려요! | 서포트: discord.gg/9bbXkkfcZv",
        type: ActivityType.Listening,
      },
    ],
  });

  startScheduler(client);
});

discordClient.on(Events.MessageCreate, (message) => {
  handleMessageCreate(discordClient, message).catch((error) => {
    logError("message_create_unhandled", message.guildId, error, {
      guildName: message.guild?.name,
      channelId: message.channelId,
      userId: message.author?.id,
      userTag: message.author?.tag,
    });
  });
});

discordClient.on(Events.InteractionCreate, (interaction) => {
  handleInteractionCreate(discordClient, interaction).catch((error) => {
    logError("interaction_create_unhandled", null, error, {
      userId: interaction.user?.id,
      userTag: interaction.user?.tag,
      customId: interaction.customId,
    });
  });
});

discordClient.on(Events.ShardDisconnect, (event, shardId) => {
  logInfo("shard_disconnect", { shardId, eventCode: event?.code });
});

discordClient.on(Events.ShardReconnecting, (shardId) => {
  logInfo("shard_reconnecting", { shardId });
});

discordClient.login(process.env.DISCORD_TOKEN).catch((error) => {
  logError("bot_login_failed", "unknown", error);
  process.exitCode = 1;
});
