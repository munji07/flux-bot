import { ADMIN_USER_ID } from "../config/config.js";
import { logError, logInfo } from "../logger.js";

/**
 * 건의/피드백을 개발자에게 DM으로 전송합니다.
 * @param {import("discord.js").Client} client
 * @param {import("discord.js").Message} message
 * @param {string} feedbackText
 */
export async function handleFeedback(client, message, feedbackText) {
  const serverName = message.guild?.name || "DM";
  const serverId = message.guildId || "N/A";
  const channelName = message.channel?.name || "N/A";

  const feedbackMsg = [
    "💬 **새로운 건의/피드백이 도착했습니다**",
    "",
    `**보낸 사람**: <@${message.author.id}> (${message.author.tag})`,
    `**서버**: ${serverName} (\`${serverId}\`)`,
    `**채널**: #${channelName} (\`${message.channelId}\`)`,
    `**시간**: <t:${Math.floor(Date.now() / 1000)}:F>`,
    "",
    `**내용**:`,
    feedbackText,
  ].join("\n");

  try {
    const developer = await client.users.fetch(ADMIN_USER_ID);
    await developer.send(feedbackMsg);

    logInfo("feedback_sent", {
      guildId: message.guildId,
      userId: message.author.id,
      userTag: message.author.tag,
      feedbackLength: feedbackText.length,
    });

    return true;
  } catch (error) {
    logError("feedback_send_failed", message.guildId, error, {
      userId: message.author.id,
    });
    return false;
  }
}
