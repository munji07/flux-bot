import { ADMIN_USER_ID, PREFIX, SAFE_MESSAGE_LIMIT, HISTORY_BATCH_SIZE } from "../config.js";
import { UserFacingError } from "../errors.js";
import { handleManagementToolCall } from "../commands/management.js";
import { handleServerImageTokenPurchaseCommand, handleSubscriptionToolCall, handleSubscriptionCommand } from "../commands/subscription.js";
import { handleImageGenerationRequest } from "./imageGeneration.js";
import { handleBotFeatureInfoRequest, getGeneralHelpText } from "../services/botFeatureInfo.js";
import { handleDeveloperDiagnosticsRequest } from "../services/developerDiagnostics.js";
import { handleLogSearchRequest, isPayloadTooLargeError } from "../services/logSearch.js";
import { addServerImageToken, checkAndIncrementUsage, decrementUsage, TIER_LIMITS } from "../services/subscription.js";
import { handleGoogleSearch } from "./googleSearch.js";
import { handleVideoAnalysis } from "./video.js";
import {
  classifyRequestIntent,
  createApiUserMessage,
  createChatCompletion,
  createChatCompletionStream,
  fetchChannelContext,
  stripReasoningTags,
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
import { getPronunciationReply } from "../utils/phonetics.js";

const activeUsers = new Set();

export async function handleMessageCreate(client, message) {
  if (message.author.bot || !message.inGuild()) return;
  if (!message.content.startsWith(PREFIX)) return;

  const userPrompt = message.content.slice(PREFIX.length).trim();
    const attachedImageUrls = getImageAttachmentUrls(message);
  const videoAttachment = message.attachments.find(a => a.contentType?.startsWith('video/'));

  if (videoAttachment) {
    return await handleVideoAnalysis(message, userPrompt);
  }

  if (!userPrompt) {
    await message.reply(`질문을 함께 입력해주세요. 예: \`${PREFIX} 오늘 저녁 메뉴 추천해줘\``);
    return;
  }

  if (activeUsers.has(message.author.id)) {
    await message.reply("먼지가 이미 답변을 작성하고 있어요. 답변이 완료된 후 다시 질문해주세요!");
    return;
  }

  activeUsers.add(message.author.id);
  try {
    let usageCheck = null;
    let usageType = null;
    let loadingMessage = await message.reply("-# <a:loading:1495336917326368829> DUST봇이 요청을 확인하고 있어요...");
    const userName = getDisplayName(message);
    let intent;

  if (await handleServerImageTokenPurchaseCommand(message, userPrompt, loadingMessage)) {
      return;
    }

  // "도움말"과 정확히 일치하는 경우 AI를 거치지 않고 즉시 반환
  if (userPrompt === "도움말") {
    await loadingMessage.edit(getGeneralHelpText(PREFIX));
        return;
      }

  // "등급" 관련 명령어도 즉시 반환
  if (["등급", "나의 등급", "나의등급", "등급 구매", "구매"].includes(userPrompt)) {
    const handled = await handleSubscriptionCommand(message, userPrompt, loadingMessage);
    if (handled) {
      return;
    }
  }

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
      await loadingMessage.edit("요청 의도를 확인하는 중 문제가 발생했어요. 잠시 뒤 다시 시도해주세요.").catch(() => {});
      return;
    }
  }

  if (["run_management", "confirm_management", "cancel_management"].includes(intent.tool)) {
  try {
      const handled = await handleManagementToolCall(message, intent, userPrompt, loadingMessage);
      if (handled) return;
  } catch (error) {
      logError("management_tool", message.guildId, error, {
        guildName: message.guild.name,
        channelId: message.channelId,
        userId: message.author.id,
        userTag: message.author.tag,
        commandText: userPrompt,
      });

      if (isPayloadTooLargeError(error)) {
        decrementUsage(message.author.id, "ai_calls");
        await loadingMessage.edit("진단하려는 로그나 소스 파일이 너무 큽니다. AI 분석을 위해 특정 서버 ID, 특정 파일 경로, 또는 더 좁은 시간 범위를 명시해서 다시 요청해 주세요.");
        return;
  }

      const replyText =
        error instanceof UserFacingError
          ? error.message
          : "관리 작업을 처리하는 중 문제가 생겼어요. 권한이나 대상 상태를 확인해 주세요.";
      await loadingMessage.edit(replyText).catch(() => message.reply(replyText));
      return;
    }
  }

  // 사용량 타입 결정
  const isImageRead = intent.type === "image_read" || attachedImageUrls.length > 0;
  if (intent.type === "image_generation") {
    usageType = "image_generations";
  } else if (isImageRead) {
    usageType = "image_readings";
  } else if (
    ["chat", "log_search"].includes(intent.type) ||
    ["google_search", "bot_feature_info", "developer_diagnostics", "subscription"].includes(intent.tool)
  ) {
    usageType = "ai_calls";
  }

  // 사용량 타입이 설정되지 않았는데 AI 호출이 필요한 경우 기본값 설정
  if (!usageType && intent.type === "chat") {
    usageType = "ai_calls";
  }

  // --- 도구 및 의도별 처리 시작 ---

  if (intent.tool === "subscription") {
    try {
      const handled = await handleSubscriptionToolCall(message, intent, loadingMessage);
      if (handled) return;
    } catch (error) {
      logError("subscription_tool", message.guildId, error, {
        guildName: message.guild.name,
        channelId: message.channelId,
        userId: message.author.id,
        userTag: message.author.tag,
        commandText: userPrompt,
      });
      await loadingMessage.edit("등급 작업을 처리하는 중 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.");
      return;
    }
  }

  if (intent.tool === "pronunciation") {
    try {
      const text = String(intent.arguments?.text || userPrompt).trim();
      await loadingMessage.edit(getPronunciationReply(`발음 ${text}`));
    } catch (error) {
      const errorMessage = error instanceof UserFacingError ? error.message : "발음 변환 중 문제가 생겼어요.";
      await loadingMessage.edit(errorMessage);
    }
    return;
  }

  if (intent.tool === "google_search") {
    try {
      const query = String(intent.arguments?.query || userPrompt).trim();

      // 사용량 체크
      usageCheck = checkAndIncrementUsage(message.author.id, "ai_calls", message.guildId);
      if (!usageCheck.allowed) {
        const limits = TIER_LIMITS[usageCheck.tier];
        const limitExceededMessage = `❌ **AI 호출 한도 초과**\n` +
          `현재 ${message.author.username}님의 등급은 \`${limits.name}\`이며, 하루 AI 호출 제한량은 **${limits.ai_calls === Infinity ? "무제한" : `${limits.ai_calls}회`}**입니다.\n` +
          `오늘 제한량을 모두 소모하셨습니다. 내일 다시 시도하시거나, \`${PREFIX} 등급 구매\`를 통해 한도를 늘려보세요!`;
        await loadingMessage.edit(limitExceededMessage);
        return;
      }

      const searchResult = await handleGoogleSearch(query);
      if (searchResult) {
        await sendChunkedAnswer(message, loadingMessage, searchResult);
    } else {
        await loadingMessage.edit("검색 결과가 없어요.");
    }
    } catch (error) {
      logError("google_search_tool", message.guildId, error, {
        guildName: message.guild.name,
        channelId: message.channelId,
        userId: message.author.id,
        userTag: message.author.tag,
        commandText: userPrompt,
      });
      await loadingMessage.edit("검색 중 문제가 생겼어요.");
  }
    return;
}

  if (intent.tool === "bot_feature_info") {
    try {
      // 사용량 체크
      usageCheck = checkAndIncrementUsage(message.author.id, "ai_calls", message.guildId);
      if (!usageCheck.allowed) {
        const limits = TIER_LIMITS[usageCheck.tier];
        const limitExceededMessage = `❌ **AI 호출 한도 초과**\n` +
          `현재 ${message.author.username}님의 등급은 \`${limits.name}\`이며, 하루 AI 호출 제한량은 **${limits.ai_calls === Infinity ? "무제한" : `${limits.ai_calls}회`}**입니다.\n` +
          `오늘 제한량을 모두 소모하셨습니다. 내일 다시 시도하시거나, \`${PREFIX} 등급 구매\`를 통해 한도를 늘려보세요!`;
        await loadingMessage.edit(limitExceededMessage);
        return;
      }

      await handleBotFeatureInfoRequest(message, intent, loadingMessage);
    } catch (error) {
      logError("bot_feature_info", message.guildId, error, {
        guildName: message.guild.name,
        channelId: message.channelId,
        userId: message.author.id,
        userTag: message.author.tag,
        commandText: userPrompt,
      });
      await loadingMessage.edit("봇 기능 정보를 정리하는 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.");
    }
    return;
  }

  if (intent.tool === "developer_diagnostics") {
    try {
      // 사용량 체크
      usageCheck = checkAndIncrementUsage(message.author.id, "ai_calls", message.guildId);
      if (!usageCheck.allowed) {
        const limits = TIER_LIMITS[usageCheck.tier];
        const limitExceededMessage = `❌ **AI 호출 한도 초과**\n` +
          `현재 ${message.author.username}님의 등급은 \`${limits.name}\`이며, 하루 AI 호출 제한량은 **${limits.ai_calls === Infinity ? "무제한" : `${limits.ai_calls}회`}**입니다.\n` +
          `오늘 제한량을 모두 소모하셨습니다. 내일 다시 시도하시거나, \`${PREFIX} 등급 구매\`를 통해 한도를 늘려보세요!`;
        await loadingMessage.edit(limitExceededMessage);
        return;
      }

      await handleDeveloperDiagnosticsRequest(message, intent, loadingMessage);
    } catch (error) {
      logError("developer_diagnostics", message.guildId, error, {
        guildName: message.guild.name,
        channelId: message.channelId,
        userId: message.author.id,
        userTag: message.author.tag,
        commandText: userPrompt,
      });

      if (isPayloadTooLargeError(error)) {
        decrementUsage(message.author.id, "ai_calls");
        await loadingMessage.edit("진단하려는 로그나 소스 파일이 너무 큽니다. AI 분석을 위해 특정 서버 ID, 특정 파일 경로, 또는 더 좁은 시간 범위를 명시해서 다시 요청해 주세요.");
        return;
      }

      const replyText =
        error instanceof UserFacingError
          ? error.message
          : "개발자 진단 중 문제가 생겼어요. 최근 error.log를 확인해 주세요.";
      await loadingMessage.edit(replyText);
    }
    return;
  }

  if (intent.type === "log_search") {
    if (message.author.id !== ADMIN_USER_ID) {
      await loadingMessage.edit("로그 조회는 최고 관리자만 사용할 수 있어요.");
      return;
    }

    usageCheck = checkAndIncrementUsage(message.author.id, "ai_calls", message.guildId);
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

      if (isPayloadTooLargeError(error)) {
        decrementUsage(message.author.id, "ai_calls");
        await loadingMessage.edit("조회하려는 로그 데이터가 너무 많아 AI가 분석할 수 없습니다. 특정 서버 ID나 더 좁은 시간 범위를 지정해서 다시 질문해 주세요.");
        return;
      }

      await loadingMessage.edit("로그를 검색하는 중 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.");
      decrementUsage(message.author.id, "ai_calls");
    }
    return;
  }

  if (intent.type === "image_generation") {
    usageCheck = checkAndIncrementUsage(message.author.id, "image_generations", message.guildId);
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
      if (usageCheck.usedServerToken) {
        addServerImageToken(message.guildId, "image_generations");
      } else {
        decrementUsage(message.author.id, "image_generations");
      }
    }
    return;
  }

  if (intent.type === "image_read" && attachedImageUrls.length === 0) {
    await loadingMessage.edit("이미지 판독을 원하시면 분석할 이미지를 함께 첨부해주세요.").catch(() => {});
    return;
  }

  // 일반 채팅 및 이미지 판독에 대한 사용량 체크
  const usageTypeName = isImageRead ? "이미지 판독" : "AI 호출";

  usageCheck = checkAndIncrementUsage(message.author.id, usageType, message.guildId);
  if (!usageCheck.allowed) {
    const limits = TIER_LIMITS[usageCheck.tier];
    const limitVal = limits[usageType] === Infinity ? "무제한" : `${limits[usageType]}회`;
    const limitExceededMessage = `❌ **${usageTypeName} 한도 초과**\n` +
      `현재 ${message.author.username}님의 등급은 \`${limits.name}\`이며, 하루 ${usageTypeName} 제한량은 **${limitVal}**입니다.\n` +
      `오늘 제한량을 모두 소모하셨습니다. 내일 다시 시도하시거나, \`${PREFIX} 등급 구매\`를 통해 한도를 늘려보세요!`;

    await loadingMessage.edit(limitExceededMessage).catch(() => {});
    return;
  }

  let typingInterval;
  let currentStep = "command_detected";

  try {
    const historyKey = getHistoryKey(message); // 로깅 및 DB 저장을 위해 유지
    const historyNeeded = shouldUseConversationHistory(userPrompt);
    // 채널의 최근 메시지 10개를 실시간으로 가져옵니다.
    const historyMessages = await fetchChannelContext(message, HISTORY_BATCH_SIZE);
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

    // 유저/멤버 관련 질문인 경우 서버 컨텍스트 생성 (토큰 절약을 위해 50명 제한)
    const needsServerInfo = /유저|멤버|누구|사람|명|있어|존재/.test(userPrompt);
    let serverContext = "";
    if (needsServerInfo) {
      const cachedMembers = message.guild.members.cache.first(50).map(m => m.displayName).join(", ");
      serverContext = `현재 서버 멤버 목록(일부): ${cachedMembers}`;
    }

    currentStep = "send_typing";
    await message.channel.sendTyping();

    currentStep = "send_loading_message";
    await loadingMessage.edit(`-# <a:loading:1495336917326368829> DUST봇이 답변을 준비하고 있어요...`).catch(() => {});

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
          guildName: message.guild.name,
          guildId: message.guildId,
          serverContext,
          logContext,
        });

        const toolCalls = chatCompletion.choices?.[0]?.message?.tool_calls;
        if (toolCalls && toolCalls.length > 0) {
          for (const toolCall of toolCalls) {
            if (toolCall.function.name === "generate_image") {
              decrementUsage(message.author.id, "ai_calls");
              const usageCheck = checkAndIncrementUsage(message.author.id, "image_generations", message.guildId);
              if (!usageCheck.allowed) {
                const limits = TIER_LIMITS[usageCheck.tier];
                const limitExceededMessage = `❌ **이미지 생성 한도 초과**\n` +
                  `현재 ${message.author.username}님의 등급은 \`${limits.name}\`이며, 하루 이미지 생성 제한량은 **${limits.image_generations}회**입니다.\n` +
                  `오늘 제한량을 모두 소모하셨습니다. 내일 다시 시도하시거나, \`${PREFIX} 등급 구매\`를 통해 한도를 늘려보세요!`;
                await loadingMessage.edit(limitExceededMessage);
                return;
              }

              const args = JSON.parse(toolCall.function.arguments);
              const success = await handleImageGenerationRequest(client, message, args.prompt, loadingMessage);
              if (!success) {
                if (usageCheck.usedServerToken) {
                  addServerImageToken(message.guildId, "image_generations");
                } else {
                  decrementUsage(message.author.id, "image_generations");
                }
              }
              return;
            }

            if (toolCall.function.name === "search_logs") {
              const args = JSON.parse(toolCall.function.arguments);
              if (message.author.id !== ADMIN_USER_ID) {
                await loadingMessage.edit("로그 조회는 최고 관리자만 사용할 수 있어요.");
                return;
              }
              try {
                await handleLogSearchRequest(message, args.query, loadingMessage);
              } catch (error) {
                logError("log_search_tool", message.guildId, error, {
                  guildName: message.guild.name,
                  channelId: message.channelId,
                  userId: message.author.id,
                  userTag: message.author.tag,
                  commandText: args.query,
                });
                await loadingMessage.edit("로그를 검색하는 중 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.");
              }
              return;
            }

            if (toolCall.function.name === "google_search") {
              const args = JSON.parse(toolCall.function.arguments);
              try {
                const searchResult = await handleGoogleSearch(args.query);
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
                } else {
                  await loadingMessage.edit("웹 검색 결과가 없습니다.");
                }
              } catch (error) {
                logError("google_search_tool", message.guildId, error, {
                  guildName: message.guild.name,
                  channelId: message.channelId,
                  userId: message.author.id,
                  userTag: message.author.tag,
                  commandText: args.query,
                });
                await loadingMessage.edit("웹 검색 중 문제가 발생했습니다.");
              }
              return;
            }
          }
        }

        currentStep = "parse_ai_answer";
        answer = stripReasoningTags(chatCompletion.choices?.[0]?.message?.content ?? "");

        // 답변이 비어있다면 에러를 던져 catch 블록의 폴백(Groq)이 실행되도록 함
        if (!answer || answer.trim().length === 0) {
          throw new Error("Primary model returned empty content");
        }
      } catch (primaryError) {
        logError("primary_ai_completion_failed", message.guildId, primaryError, {
          guildName: message.guild.name,
          channelId: message.channelId,
          userId: message.author.id,
          userTag: message.author.tag,
          errorDetail: primaryError.message
        });

        currentStep = "request_groq_fallback_stream";
        await loadingMessage.edit("-# <a:loading:1495336917326368829> DUST봇이 다른 모델로 답변을 이어서 준비하고 있어요...");

        const chatCompletion = await createChatCompletionStream({
          userName,
          historyMessages,
          currentApiUserMessage,
          guildName: message.guild.name,
          guildId: message.guildId,
          serverContext,
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
        guildName: message.guild.name,
        guildId: message.guildId,
        serverContext,
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
    if (usageCheck?.usedServerToken) {
      addServerImageToken(message.guildId, usageType);
    } else {
      decrementUsage(message.author.id, usageType);
    }

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
  let fullAnswer = "";
  let sentText = "";
  let currentMessage = loadingMessage;
  let lastEditAt = 0;

  try {
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content ?? "";
      if (!delta) continue;

      fullAnswer += delta;
      const visible = stripReasoningTags(fullAnswer);
      let currentChunk = visible.slice(sentText.length);

      // 디스코드 메시지 길이 제한(약 2000자)을 넘는 경우 분할 처리
      while (currentChunk.length > SAFE_MESSAGE_LIMIT) {
        const toSend = currentChunk.slice(0, SAFE_MESSAGE_LIMIT);
        if (currentMessage) {
          await currentMessage.edit(toSend).catch(() => {});
        } else {
          currentMessage = await message.channel.send(toSend);
        }
        sentText += toSend;
        currentChunk = visible.slice(sentText.length);
        currentMessage = null; // 다음 조각은 새 메시지로 전송
        lastEditAt = Date.now();
      }

      // API 레이트 리밋 방지를 위해 1.2초마다 편집 업데이트
      if (currentChunk.trim() && Date.now() - lastEditAt >= 1200) {
        if (currentMessage) {
          await currentMessage.edit(currentChunk).catch(async () => {
            currentMessage = await message.channel.send(currentChunk);
          });
        } else {
          currentMessage = await message.channel.send(currentChunk);
        }
        lastEditAt = Date.now();
      }
    }
  } catch (error) {
    logError("streaming_process_error", message.guildId, error);
  }

  // 스트리밍 종료 후 남은 마지막 텍스트 처리
  const finalVisible = stripReasoningTags(fullAnswer);
  const finalRemaining = finalVisible.slice(sentText.length).trim();
  if (finalRemaining) {
    if (currentMessage) {
      await currentMessage.edit(finalRemaining).catch(() => message.channel.send(finalRemaining));
    } else {
      await message.channel.send(finalRemaining);
    }
  }

  return finalVisible;
}

