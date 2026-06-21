import { AttachmentBuilder } from "discord.js";
import { generateImage } from "../services/ai.js";
import { logError, logInfo } from "../logger.js";
import { getDisplayName } from "../utils/message.js";


export async function handleImageGenerationRequest(client, message, imagePrompt, loadingMessage = null) {
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
      model: "gptimage",
      promptLength: imagePrompt.length,
    });

    await message.channel.sendTyping();
    if (loadingMessage) {
      await loadingMessage.edit(`-# <a:load:1516064965751214110> 이미지를 그리고 있어요...`);
    } else {
      loadingMessage = await message.reply(`-# <a:load:1516064965751214110> 이미지를 그리고 있어요...`);
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

    // generateImage는 Buffer를 담은 imageBuffer 프로퍼티를 반환
    const { imageBuffer } = await generateImage(imagePrompt, {
      guildId: message.guildId,
      guildName: message.guild.name,
      channelId: message.channelId,
      userId: message.author.id,
      userName: getDisplayName(message),
      userTag: message.author.tag,
      commandText: imagePrompt,
    });

    if (imageBuffer) {
      const attachment = new AttachmentBuilder(imageBuffer, { name: "generated.png" });

      await loadingMessage.edit({
        content: "✨ 이미지를 완성했어요!",
        files: [attachment],
      });
    } else {
      await loadingMessage.edit("이미지 생성 결과를 받지 못했어요. 잠시 뒤 다시 시도해주세요.");
    }

    logInfo("image_generation_completed", {
      guildId: message.guildId,
      guildName: message.guild.name,
      channelId: message.channelId,
      userId: message.author.id,
      userName: getDisplayName(message),
      userTag: message.author.tag,
      commandText: imagePrompt,
      hasBuffer: !!imageBuffer,
    });
  } catch (error) {
    logError("image_generation", message.guildId, error, {
      channelId: message.channelId,
      userId: message.author.id,
      guildName: message.guild.name,
      userTag: message.author.tag,
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
