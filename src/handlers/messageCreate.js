import { PREFIX } from "../config.js";
import { UserFacingError } from "../errors.js";
import { handleManagementCommand } from "../commands/management.js";
import { handleImageGenerationRequest } from "./imageGeneration.js";
import { classifyRequestIntent, createApiUserMessage, createChatCompletion } from "../services/ai.js";
import {
  appendConversationHistory,
  getConversationHistory,
  getHistoryKey,
  getStoredHistoryLength,
  shouldUseConversationHistory,
} from "../services/history.js";
import { logError, logInfo } from "../logger.js";
import {
  createUserMessageContent,
  getDisplayName,
  getImageAttachmentUrls,
  sendChunkedAnswer,
} from "../utils/message.js";

export async function handleMessageCreate(client, message) {
  if (message.author.bot || !message.inGuild()) return;
  if (!message.content.startsWith(PREFIX)) return;

  const userPrompt = message.content.slice(PREFIX.length).trim();

  if (!userPrompt) {
    await message.reply(`질문을 함께 입력해주세요. 예: \`${PREFIX} 오늘 저녁 메뉴 추천해줘\``);
    return;
  }

  const managementHandled = await handleManagementCommand(message, userPrompt);
  if (managementHandled) return;

  let loadingMessage = await message.reply("-# <a:loading:1495336917326368829> DUST봇이 요청을 확인하고 있어요...");
  const attachedImageUrls = getImageAttachmentUrls(message);
  const userName = getDisplayName(message);
  let intent;

  try {
    intent = await classifyRequestIntent({
      userPrompt,
      hasImageAttachment: attachedImageUrls.length > 0,
      logContext: {
        guildId: message.guildId,
        guildName: message.guild.name,
        channelId: message.channelId,
        userId: message.author.id,
        userName,
        userTag: message.author.tag,
        commandText: userPrompt,
      },
    });
  } catch (error) {
    logError("classify_request_intent", message.guildId, error, {
      guildName: message.guild.name,
      channelId: message.channelId,
      userId: message.author.id,
      userTag: message.author.tag,
    });

    if (loadingMessage) {
      await loadingMessage.edit("요청 의도를 확인하는 중 문제가 발생했어요. 잠시 뒤 다시 시도해주세요.");
    } else {
      await message.reply("요청 의도를 확인하는 중 문제가 발생했어요. 잠시 뒤 다시 시도해주세요.");
    }
    return;
  }

  if (intent.type === "image_generation") {
    await handleImageGenerationRequest(client, message, intent.imagePrompt, loadingMessage);
    return;
  }

  if (intent.type === "image_read" && attachedImageUrls.length === 0) {
    if (loadingMessage) {
      await loadingMessage.edit("이미지 판독을 원하시면 분석할 이미지를 함께 첨부해주세요.");
    } else {
      await message.reply("이미지 판독을 원하시면 분석할 이미지를 함께 첨부해주세요.");
    }
    return;
  }

  let typingInterval;
  let currentStep = "command_detected";

  try {
    const historyKey = getHistoryKey(message);
    const historyNeeded = shouldUseConversationHistory(userPrompt);
    const historyMessages = getConversationHistory(historyKey, historyNeeded);
    const imageUrls = attachedImageUrls;
    const currentUserMessage = {
      role: "user",
      content: createUserMessageContent(userName, userPrompt, imageUrls),
    };
    const currentApiUserMessage = createApiUserMessage(userName, userPrompt, imageUrls);

    logInfo("command_detected", {
      guildId: message.guildId,
      guildName: message.guild.name,
      channelId: message.channelId,
      userId: message.author.id,
      userName,
      userTag: message.author.tag,
      commandText: userPrompt,
      promptLength: userPrompt.length,
      historyMessageCount: historyMessages.length,
      historyNeeded,
      imageCount: imageUrls.length,
    });

    currentStep = "send_typing";
    await message.channel.sendTyping();

    currentStep = "send_loading_message";
    if (loadingMessage) {
      await loadingMessage.edit(`-# <a:loading:1495336917326368829>DUST봇이 답변을 준비하고 있어요...`);
    } else {
      loadingMessage = await message.reply(`-# <a:loading:1495336917326368829> DUST봇이 답변을 준비하고 있어요...`);
    }

    typingInterval = setInterval(() => {
      message.channel.sendTyping().catch((error) => {
        logError("refresh_typing", message.guildId, error, {
          channelId: message.channelId,
        });
      });
    }, 8000);

    currentStep = "request_ai_completion";
    const chatCompletion = await createChatCompletion({
      userName,
      historyMessages,
      currentApiUserMessage,
      imageUrls,
      logContext: {
        guildId: message.guildId,
        guildName: message.guild.name,
        channelId: message.channelId,
        userId: message.author.id,
        userName,
        userTag: message.author.tag,
        commandText: userPrompt,
        historyNeeded,
      },
    });

    currentStep = "parse_ai_answer";
    const answer = chatCompletion.choices?.[0]?.message?.content?.trim();

    if (!answer) {
      logInfo("empty_ai_answer", {
        guildId: message.guildId,
        guildName: message.guild.name,
        channelId: message.channelId,
        userId: message.author.id,
        userName,
      });
      await loadingMessage.edit("AI가 빈 답변을 반환했어요. 잠시 뒤 다시 시도해주세요.");
      return;
    }

    currentStep = "send_ai_answer";
    await sendChunkedAnswer(message, loadingMessage, answer);
    appendConversationHistory(historyKey, currentUserMessage, {
      role: "assistant",
      content: answer,
    });

    logInfo("answer_sent", {
      guildId: message.guildId,
      guildName: message.guild.name,
      channelId: message.channelId,
      userId: message.author.id,
      userName,
      answerLength: answer.length,
      storedHistoryMessageCount: getStoredHistoryLength(historyKey),
    });
  } catch (error) {
    logError(currentStep, message.guildId, error, {
      guildName: message.guild.name,
      channelId: message.channelId,
      userId: message.author.id,
      userTag: message.author.tag,
    });

    const errorMessage =
      error instanceof UserFacingError
        ? error.message
        : "답변을 생성하는 중 문제가 발생했어요. 잠시 뒤 다시 시도해주세요.";

    if (loadingMessage) {
      await loadingMessage.edit(errorMessage).catch((editError) => {
        logError("edit_error_message", message.guildId, editError, {
          guildName: message.guild.name,
          channelId: message.channelId,
          userId: message.author.id,
          userTag: message.author.tag,
        });

        return message.reply(errorMessage).catch((replyError) => {
          logError("reply_error_message", message.guildId, replyError, {
            guildName: message.guild.name,
            channelId: message.channelId,
            userId: message.author.id,
            userTag: message.author.tag,
          });
        });
      });
    } else {
      await message.reply(errorMessage).catch((replyError) => {
        logError("reply_error_message", message.guildId, replyError, {
          guildName: message.guild.name,
          channelId: message.channelId,
          userId: message.author.id,
          userTag: message.author.tag,
        });
      });
    }
  } finally {
    if (typingInterval) clearInterval(typingInterval);
  }
}
