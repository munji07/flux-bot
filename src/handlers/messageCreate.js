import { PREFIX, SAFE_MESSAGE_LIMIT } from "../config.js";
import { UserFacingError } from "../errors.js";
import { handleManagementCommand } from "../commands/management.js";
import { handleSubscriptionCommand } from "../commands/subscription.js";
import { handleImageGenerationRequest } from "./imageGeneration.js";
import { handleLogSearchRequest } from "../services/logSearch.js";
import { checkAndIncrementUsage, decrementUsage, TIER_LIMITS } from "../services/subscription.js";
import { handleGoogleSearch } from "./googleSearch.js";
import {
  classifyRequestIntent,
  createApiUserMessage,
  createChatCompletion,
  createChatCompletionStream,
  stripReasoningTags,
  shouldUseWebSearch,
} from "../services/ai.js";
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
import { getPronunciationReply, isPronunciationRequest } from "../utils/phonetics.js";

const activeUsers = new Set();

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

  const subscriptionHandled = await handleSubscriptionCommand(message, userPrompt);
  if (subscriptionHandled) return;

  if (isPronunciationRequest(userPrompt)) {
    try {
      const replyText = getPronunciationReply(userPrompt);
      await message.reply(replyText);
    } catch (error) {
      const errorMessage = error instanceof UserFacingError ? error.message : "발음 변환 중 문제가 발생했어요.";
      await message.reply(errorMessage);
    }
    return;
  }
  if (activeUsers.has(message.author.id)) {
    await message.reply("먼지가 이미 답변을 작성하고 있어요. 답변이 완료된 후 다시 질문해주세요!");
    return;
  }

  activeUsers.add(message.author.id);

  try {
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

    if (attachedImageUrls.length === 0) {
      intent = {
        type: "chat",
        imagePrompt: "",
        raw: "",
      };
      logInfo("intent_classification_fallback", {
        guildId: message.guildId,
        guildName: message.guild.name,
        channelId: message.channelId,
        userId: message.author.id,
        userName,
      });
    } else {
      if (loadingMessage) {
        await loadingMessage.edit("요청 의도를 확인하는 중 문제가 발생했어요. 잠시 뒤 다시 시도해주세요.");
      } else {
        await message.reply("요청 의도를 확인하는 중 문제가 발생했어요. 잠시 뒤 다시 시도해주세요.");
      }
      return;
    }
  }

  if (intent.type === "log_search") {
    const usageCheck = checkAndIncrementUsage(message.author.id, "ai_calls");
    if (!usageCheck.allowed) {
      const limits = TIER_LIMITS[usageCheck.tier];
      const limitExceededMessage = `❌ **AI 호출 한도 초과**\n` +
        `현재 ${message.author.username}님의 등급은 \`${limits.name}\`이며, 하루 AI 호출 제한량은 **${limits.ai_calls === Infinity ? "무제한" : `${limits.ai_calls}회`}**입니다.\n` +
        `오늘 제한량을 모두 소모하셨습니다. 내일 다시 시도하시거나, \`${PREFIX} 등급 구매\`를 통해 한도를 늘려보세요!`;
      await loadingMessage.edit(limitExceededMessage);
      return;
    }

    try {
      await handleLogSearchRequest(message, userPrompt, loadingMessage);
    } catch (error) {
      logError("log_search", message.guildId, error, {
        guildName: message.guild.name,
        channelId: message.channelId,
        userId: message.author.id,
        userTag: message.author.tag,
        commandText: userPrompt,
      });

      await loadingMessage.edit("로그를 검색하는 중 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.");
      decrementUsage(message.author.id, "ai_calls");
    }
    return;
  }

  if (intent.type === "image_generation") {
    const usageCheck = checkAndIncrementUsage(message.author.id, "image_generations");
    if (!usageCheck.allowed) {
      const limits = TIER_LIMITS[usageCheck.tier];
      const limitExceededMessage = `❌ **이미지 생성 한도 초과**\n` +
        `현재 ${message.author.username}님의 등급은 \`${limits.name}\`이며, 하루 이미지 생성 제한량은 **${limits.image_generations}회**입니다.\n` +
        `오늘 제한량을 모두 소모하셨습니다. 내일 다시 시도하시거나, \`${PREFIX} 등급 구매\`를 통해 한도를 늘려보세요!`;
      await loadingMessage.edit(limitExceededMessage);
      return;
    }

    const success = await handleImageGenerationRequest(client, message, intent.imagePrompt, loadingMessage);
    if (!success) {
      decrementUsage(message.author.id, "image_generations");
    }
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

  const isImageRead = intent.type === "image_read" || attachedImageUrls.length > 0;
  const usageType = isImageRead ? "image_readings" : "ai_calls";
  const usageTypeName = isImageRead ? "이미지 판독" : "AI 호출";

  const usageCheck = checkAndIncrementUsage(message.author.id, usageType);
  if (!usageCheck.allowed) {
    const limits = TIER_LIMITS[usageCheck.tier];
    const limitVal = limits[usageType] === Infinity ? "무제한" : `${limits[usageType]}회`;
    const limitExceededMessage = `❌ **${usageTypeName} 한도 초과**\n` +
      `현재 ${message.author.username}님의 등급은 \`${limits.name}\`이며, 하루 ${usageTypeName} 제한량은 **${limitVal}**입니다.\n` +
      `오늘 제한량을 모두 소모하셨습니다. 내일 다시 시도하시거나, \`${PREFIX} 등급 구매\`를 통해 한도를 늘려보세요!`;
    
    if (loadingMessage) {
      await loadingMessage.edit(limitExceededMessage);
    } else {
      await message.reply(limitExceededMessage);
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

    const logContext = {
      guildId: message.guildId,
      guildName: message.guild.name,
      channelId: message.channelId,
      userId: message.author.id,
      userName,
      userTag: message.author.tag,
      commandText: userPrompt,
      historyNeeded,
    };

    if (intent.type === "chat" && imageUrls.length === 0) {
      try {
        currentStep = "web_search_classification";
        const needWebSearch = await shouldUseWebSearch({ userPrompt, logContext });

        if (needWebSearch) {
          currentStep = "web_search";
          const searchResult = await handleGoogleSearch(userPrompt);

          if (searchResult) {
            await sendChunkedAnswer(message, loadingMessage, searchResult);
            appendConversationHistory(
              historyKey,
              {
                guildId: message.guildId,
                channelId: message.channelId,
                userId: message.author.id,
                userTag: message.author.tag,
                userName,
              },
              currentUserMessage,
              {
                role: "assistant",
                content: searchResult,
              },
            );

            logInfo("web_search_answer_sent", {
              ...logContext,
              answerLength: searchResult.length,
            });
            return;
          }
        }
      } catch (error) {
        logError("web_search", message.guildId, error, {
          ...logContext,
          step: currentStep,
        });
      }
    }

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
    let answer;
    let answerAlreadySent = false;

    if (imageUrls.length === 0) {
      try {
        const chatCompletion = await createChatCompletion({
          userName,
          historyMessages,
          currentApiUserMessage,
          imageUrls,
          logContext,
        });

        currentStep = "parse_ai_answer";
        answer = stripReasoningTags(chatCompletion.choices?.[0]?.message?.content ?? "");
      } catch (primaryError) {
        logError("primary_ai_completion_failed", message.guildId, primaryError, {
          guildName: message.guild.name,
          channelId: message.channelId,
          userId: message.author.id,
          userTag: message.author.tag,
        });

        currentStep = "request_groq_fallback_stream";
        await loadingMessage.edit("-# <a:loading:1495336917326368829> DUST봇이 다른 모델로 답변을 이어서 준비하고 있어요...");

        const chatCompletion = await createChatCompletionStream({
          userName,
          historyMessages,
          currentApiUserMessage,
          logContext: {
            ...logContext,
            fallbackFrom: "deepseek",
          },
        });

        currentStep = "stream_groq_fallback_answer";
        answer = await sendStreamingAnswer(message, loadingMessage, chatCompletion);
        answerAlreadySent = true;
      }
    } else {
      const chatCompletion = await createChatCompletion({
        userName,
        historyMessages,
        currentApiUserMessage,
        imageUrls,
        logContext,
      });

      currentStep = "parse_ai_answer";
      answer = stripReasoningTags(chatCompletion.choices?.[0]?.message?.content ?? "");
    }

    if (!answer) {
      logInfo("empty_ai_answer", {
        guildId: message.guildId,
        guildName: message.guild.name,
        channelId: message.channelId,
        userId: message.author.id,
        userName,
      });
      await loadingMessage.edit("AI가 빈 답변을 반환했어요. 잠시 뒤 다시 시도해주세요.");
      decrementUsage(message.author.id, usageType);
      return;
    }

    currentStep = "send_ai_answer";
    if (!answerAlreadySent) {
      await sendChunkedAnswer(message, loadingMessage, answer);
    }

    appendConversationHistory(
      historyKey,
      {
        guildId: message.guildId,
        channelId: message.channelId,
        userId: message.author.id,
        userTag: message.author.tag,
        userName,
      },
      currentUserMessage,
      {
        role: "assistant",
        content: answer,
      },
    );

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
    decrementUsage(message.author.id, usageType);

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
  } finally {
    activeUsers.delete(message.author.id);
  }
}

async function sendStreamingAnswer(message, loadingMessage, stream) {
  let answer = "";
  let sentText = "";
  let currentMessage = loadingMessage;
  let lastEditAt = 0;

  async function editOrSend(text) {
    if (!text.trim()) return;

    if (currentMessage) {
      await currentMessage.edit(text).catch(async () => {
        currentMessage = await message.channel.send(text);
      });
    } else {
      currentMessage = await message.channel.send(text);
    }

    lastEditAt = Date.now();
  }

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content ?? "";
    if (!delta) continue;

    answer += delta;
    const visible = stripReasoningTags(answer);
    let currentChunk = visible.slice(sentText.length);

    while (currentChunk.length > SAFE_MESSAGE_LIMIT) {
      const chunkToSend = currentChunk.slice(0, SAFE_MESSAGE_LIMIT).trimEnd();
      await editOrSend(chunkToSend);
      sentText += currentChunk.slice(0, SAFE_MESSAGE_LIMIT);
      currentChunk = visible.slice(sentText.length);
      currentMessage = null;
      lastEditAt = Date.now();
    }

    if (currentChunk.trim() && Date.now() - lastEditAt >= 1200) {
      await editOrSend(currentChunk);
    }
  }

  const finalChunk = stripReasoningTags(answer).slice(sentText.length).trimEnd();
  if (finalChunk) {
    await editOrSend(finalChunk);
  }

  return stripReasoningTags(answer);
}
