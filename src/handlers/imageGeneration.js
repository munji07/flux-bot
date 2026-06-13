import { AttachmentBuilder } from "discord.js";
import { IMAGE_GENERATION_MODEL } from "../config.js";
import { generateImage } from "../services/ai.js";
import { logError, logInfo } from "../logger.js";
import { getDisplayName } from "../utils/message.js";


export async function handleImageGenerationRequest(client, message, imagePrompt, loadingMessage = null, style = "default") {
  let typingInterval;

  try {
    logInfo("image_generation_detected", {
      guildId: message.guildId,
      guildName: message.guild.name,
      channelId: message.channelId,
      userId: message.author.id,
      userName: getDisplayName(message),
      userTag: message.author.tag,
      commandText: imagePrompt,
      model: IMAGE_GENERATION_MODEL,
      promptLength: imagePrompt.length,
      style,
    });

    await message.channel.sendTyping();
    if (loadingMessage) {
      await loadingMessage.edit(`-# <a:loading:1495336917326368829> 이미지를 그리고 있어요...`);
    } else {
      loadingMessage = await message.reply(`-# <a:loading:1495336917326368829> 이미지를 그리고 있어요...`);
    }

    typingInterval = setInterval(() => {
      message.channel.sendTyping().catch((error) => {
        logError("refresh_typing", message.guildId, error, {
          channelId: message.channelId,
          userId: message.author.id,
          guildName: message.guild.name,
          userTag: message.author.tag,
        });
      });
    }, 8000);

    const imageResult = await generateImage(imagePrompt, {
      guildId: message.guildId,
      guildName: message.guild.name,
      channelId: message.channelId,
      userId: message.author.id,
      userName: getDisplayName(message),
      userTag: message.author.tag,
      commandText: imagePrompt,
    }, style);
    const generatedImage = imageResult.data?.[0];
    const imageUrl = generatedImage?.url;
    const imageBase64 = generatedImage?.b64_json;

    if (imageUrl) {
      await loadingMessage.edit(`이미지를 완성했어요 ✨\n${imageUrl}`);
    } else if (imageBase64) {
      const attachment = new AttachmentBuilder(Buffer.from(imageBase64, "base64"), {
        name: "munji-generated-image.png",
      });

      await loadingMessage.edit({
        content: "이미지를 완성했어요 ✨",
        files: [attachment],
      });
    } else {
      await loadingMessage.edit("이미지 생성 결과를 읽지 못했어요. 잠시 뒤 다시 시도해주세요.");
    }

    logInfo("image_generation_completed", {
      guildId: message.guildId,
      guildName: message.guild.name,
      channelId: message.channelId,
      userId: message.author.id,
      userName: getDisplayName(message),
      userTag: message.author.tag,
      commandText: imagePrompt,
      model: IMAGE_GENERATION_MODEL,
      resultType: imageUrl ? "url" : imageBase64 ? "base64" : "unknown",
    });
  } catch (error) {
    logError("image_generation", message.guildId, error, {
      channelId: message.channelId,
      userId: message.author.id,
      guildName: message.guild.name,
      userTag: message.author.tag,
      model: IMAGE_GENERATION_MODEL,
    });

    const errorMessage = "이미지를 생성하는 중 문제가 발생했어요. 잠시 뒤 다시 시도해주세요.";
    if (loadingMessage) {
      await loadingMessage.edit(errorMessage).catch(() => message.reply(errorMessage));
    } else {
      await message.reply(errorMessage);
    }
    return false;
  } finally {
    if (typingInterval) clearInterval(typingInterval);
  }

  return true;
}
