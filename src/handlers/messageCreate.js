import { ADMIN_USER_ID, PREFIX, SAFE_MESSAGE_LIMIT, HISTORY_BATCH_SIZE, GEMINI_SEARCH_MODEL, DEEPSEEK_CHAT_MODEL, LOADING_EMOJI } from "../config/config.js";
import { UserFacingError } from "../errors.js";
import { handleManagementToolCall, getManagementHelpText } from "../commands/management.js";
import { handleScheduleFromIntent } from "../commands/scheduler.js";
import { handleSubscriptionToolCall, handleSubscriptionCommand } from "../commands/subscription.js";
import { handleImageGenerationRequest } from "./imageGeneration.js";
import { handleUserSettingsCommand } from "../commands/userSettings.js";
import { handleBotFeatureInfoRequest } from "../services/botFeatureInfo.js";
import { handleDeveloperDiagnosticsRequest } from "../services/developerDiagnostics.js";
import { handleLogSearchRequest, isPayloadTooLargeError } from "../services/logSearch.js";
import { addServerImageToken, checkAndIncrementUsage, decrementUsage, TIER_LIMITS } from "../services/subscription.js";
import { handleGoogleSearch } from "./googleSearch.js";
import { handleVideoAnalysis } from "./video.js";
import { generateChannelSummary } from "../services/summary.js";
import { handleFeedback } from "../services/feedback.js";
import { saveUserName, searchUserNames, getUserName, formatUserNameRecord, getAllUserNames } from "../services/userNames.js";
import { db } from '../services/database.js';
import {
  classifyRequestIntent,
  createApiUserMessage,
  createChatCompletion,
  createChatCompletionStream,
  fetchChannelContext,
  isGroqModel,
  isGroqRateLimitError,
  stripReasoningTags,
  stripCodeBlocks,
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
  stripFancyUnicode,
} from "../utils/message.js";
import { getPronunciationReply } from "../utils/phonetics.js";

function createLimitExceededMessage(username, tierName, usageTypeName, limit, prefix) {
  const limitText = limit === Infinity ? "무제한" : `${limit}회`;
  return `❌ **${usageTypeName} 한도 초과**\n` +
    `현재 ${username}님의 등급은 \`${tierName}\`이며, 하루 ${usageTypeName} 제한량은 **${limitText}**입니다.\n` +
    `오늘 제한량을 모두 소모하셨습니다. 내일 다시 시도하시거나, \`${prefix} 등급 구매\`를 통해 한도를 늘려보세요!`;
}

const activeUsers = new Map();
const ACTIVE_USER_TIMEOUT_MS = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [userId, timestamp] of activeUsers.entries()) {
    if (now - timestamp > ACTIVE_USER_TIMEOUT_MS) {
      activeUsers.delete(userId);
    }
  }
}, 60_000);

export async function handleMessageCreate(client, message) {
  if (message.inGuild()) {
    try {
      await db.run(
        `INSERT INTO channel_messages (message_id, guild_id, channel_id, user_id, user_tag, user_name, is_bot, content, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT(message_id) DO NOTHING`,
        [
          message.id,
          message.guildId,
          message.channelId,
          message.author.id,
          message.author.tag,
          message.member?.displayName || message.author.displayName,
          message.author.bot ? 1 : 0,
          message.content || null,
          new Date(message.createdTimestamp).toISOString(),
        ],
      );
    } catch (e) {
      logError("store_channel_message", message.guildId, e);
    }

    try {
      await saveUserName(
        message.author.id,
        message.guildId,
        message.author.username,
        message.member?.displayName || message.author.displayName,
        message.author.globalName || "",
      );
    } catch (e) {
      logError("save_user_name", message.guildId, e);
    }
  }

  if (message.author.bot || !message.inGuild()) return;
  if (message.content && message.content.trim().startsWith('&')) return;

  let isAiChannel = false;
  try {
    const row = await db.get("SELECT 1 FROM ai_channels WHERE channel_id = $1", [message.channelId]);
    if (row) isAiChannel = true;
  } catch (e) {
    logError("check_ai_channel", message.guildId, e);
  }

  const prefixMatch = message.content.match(/^!(?:FLUX|FL)\b/i);
  if (!prefixMatch && !isAiChannel) return;

  const userPrompt = prefixMatch
    ? message.content.slice(prefixMatch[0].length).trim()
    : message.content.trim();
    const attachedImageUrls = getImageAttachmentUrls(message);
  const videoAttachment = message.attachments.find(a => a.contentType?.startsWith('video/'));

  if (!userPrompt) {
    await message.reply(`질문을 함께 입력해주세요. 예: \`${PREFIX} 오늘 저녁 메뉴 추천해줘\``);
    return;
  }

  const now = Date.now();
  if (activeUsers.has(message.author.id)) {
    await message.reply("FLUX가 이미 답변을 작성하고 있어요. 답변이 완료된 후 다시 질문해주세요!");
    return;
  }

  // 도움말은 AI 분류 없이 바로 응답
  if (userPrompt === "도움말") {
    await message.reply(getManagementHelpText());
    return;
  }

  activeUsers.set(message.author.id, now);
  try {
    let usageCheck = null;
    let usageType = null;
    let loadingMessage = await message.reply(`-# ${LOADING_EMOJI} FLUX봇이 요청을 확인하고 있어요...`);

    // 유저 이름 설정 여부 체크 및 자동 저장 (첫 대화)
    let isFirstConversation = false;
    let displayName = null;
    const userSettingsRow = await db.get("SELECT display_name FROM user_settings WHERE user_id = $1", [message.author.id]);
    if (!userSettingsRow || !userSettingsRow.display_name) {
      displayName = message.member?.displayName ?? message.author.username;
      await db.run(
        `INSERT INTO user_settings (user_id, display_name, updated_at)
         VALUES ($1, $2, TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
         ON CONFLICT(user_id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           updated_at = EXCLUDED.updated_at`,
        [message.author.id, displayName],
      );
      isFirstConversation = true;
    } else {
      displayName = userSettingsRow.display_name;
    }
    const userName = displayName;
    let intent;

    // 이름변경은 AI 분류 없이 바로 처리
    if (userPrompt.startsWith("이름변경") || /^이름(?:초기화|삭제|리셋)$/i.test(userPrompt)) {
      const handled = await handleUserSettingsCommand(message, userPrompt, loadingMessage);
      if (handled) return;
    }

    // 이름찾기 — DB에 저장된 모든 사용자 이름 검색 (AI 분류 없이 바로 처리)
    const nameSearchMatch = userPrompt.match(/^이름(?:찾기|검색|조회|보기|목록|리스트)\s*(.*)$/i);
    if (nameSearchMatch) {
      const query = nameSearchMatch[1].trim();
      if (query) {
        const results = await searchUserNames(query);
        if (results.length === 0) {
          await loadingMessage.edit(`\`${query}\`(와)과 일치하는 사용자를 찾지 못했어요.`);
        } else {
          const lines = results.slice(0, 15).map((r, i) =>
            `${i + 1}. **${r.display_name || r.username || "알 수 없음"}** (ID: \`${r.user_id}\`)${r.global_name ? ` / ${r.global_name}` : ""}`
          );
          const text = [`## 🔍 이름 검색 결과: \`${query}\``, "", ...lines].join("\n");
          await loadingMessage.edit(text);
        }
      } else {
        const allNames = await getAllUserNames();
        if (allNames.length === 0) {
          await loadingMessage.edit("아직 저장된 사용자 이름이 없어요.");
        } else {
          const lines = allNames.slice(0, 20).map((r, i) =>
            `${i + 1}. **${r.display_name || r.username || "알 수 없음"}** (ID: \`${r.user_id}\`)`
          );
          const text = [`## 📋 저장된 사용자 이름 목록 (최근 ${Math.min(allNames.length, 20)}명)`, "", ...lines].join("\n");
          await loadingMessage.edit(text);
        }
      }
      return;
    }

    // 등록된 구독 명령어 (AI 분류 없이 직접 처리)
    const subHandled = await handleSubscriptionCommand(message, userPrompt, loadingMessage);
    if (subHandled) return;

    try {
      intent = await classifyRequestIntent({
        userPrompt,
        hasImageAttachment: attachedImageUrls.length > 0,
        hasVideoAttachment: !!videoAttachment,
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

      if (attachedImageUrls.length === 0 && !videoAttachment) {
        intent = { type: "chat", tool: "chat", arguments: {} };
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
        await decrementUsage(message.author.id, "ai_calls");
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
  } else if (intent.tool === "video_analysis") {
    usageType = "video_analysis";
  } else {
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

  if (intent.tool === "summary") {
    try {
      usageCheck = await checkAndIncrementUsage(message.author.id, "ai_calls", message.guildId);
      if (!usageCheck.allowed) {
        const limits = TIER_LIMITS[usageCheck.tier];
        await loadingMessage.edit(createLimitExceededMessage(message.author.username, limits.name, "AI 호출", limits.ai_calls, PREFIX));
        return;
      }

      const count = Math.min(Math.max(Number(intent.arguments?.count) || 50, 5), 200);
      await loadingMessage.edit(`-# ${LOADING_EMOJI} 채널 메시지를 요약하고 있어요... (최근 ${count}개)`);

      const summary = await generateChannelSummary(
        message.guildId,
        message.channelId,
        message.channel.name,
        count,
      );

      if (!summary) {
        await loadingMessage.edit("최근 메시지가 충분하지 않아 요약할 수 없어요. 채널에 메시지가 더 쌓인 후에 시도해주세요.");
        return;
      }

      const footer = `\n\n-# 🤖 요약 모델: ${"meta/llama-3.1-8b-instruct"}`;
      await sendChunkedAnswer(message, loadingMessage, summary + footer);
    } catch (error) {
      logError("summary_tool", message.guildId, error, {
        guildName: message.guild.name,
        channelId: message.channelId,
        userId: message.author.id,
        userTag: message.author.tag,
        commandText: userPrompt,
      });
      await loadingMessage.edit("채널 요약 중 문제가 발생했어요. 잠시 뒤 다시 시도해주세요.");
    }
    return;
  }

  if (intent.tool === "feedback") {
    try {
      const feedbackText = String(intent.arguments?.text || userPrompt).trim();
      if (!feedbackText || feedbackText.length < 2) {
        await loadingMessage.edit(`건의 내용을 입력해주세요. 예: \`${PREFIX} 건의: 여기에 내용을 적어주세요\``);
        return;
      }

      const sent = await handleFeedback(client, message, feedbackText);
      if (sent) {
        await loadingMessage.edit("✅ 소중한 의견 감사합니다! 개발자에게 전달했어요.");
      } else {
        await loadingMessage.edit("❌ 건의 전송 중 문제가 발생했어요. 개발자에게 직접 문의해주세요.");
      }
    } catch (error) {
      logError("feedback_tool", message.guildId, error, {
        guildName: message.guild.name,
        channelId: message.channelId,
        userId: message.author.id,
        userTag: message.author.tag,
        commandText: userPrompt,
      });
      await loadingMessage.edit("건의 처리 중 문제가 발생했어요. 잠시 뒤 다시 시도해주세요.");
    }
    return;
  }

  if (intent.tool === "lookup_user") {
    try {
      const query = String(intent.arguments?.query || "").trim();
      if (!query) {
        await loadingMessage.edit("찾을 사용자 이름이나 ID를 입력해주세요.");
        return;
      }
      const results = await searchUserNames(query);
      if (results.length === 0) {
        await loadingMessage.edit(`\`${query}\`(와)과 일치하는 사용자를 찾지 못했어요.`);
      } else {
        const lines = results.slice(0, 10).map((r, i) =>
          `${i + 1}. **${r.display_name || r.username || "알 수 없음"}** (ID: \`${r.user_id}\`)${r.global_name ? ` / ${r.global_name}` : ""}`
        );
        const text = [`## 🔍 사용자 검색 결과`, `검색어: \`${query}\``, "", ...lines].join("\n");
        await loadingMessage.edit(text);
      }
    } catch (error) {
      logError("lookup_user_tool", message.guildId, error, {
        guildName: message.guild.name,
        channelId: message.channelId,
        userId: message.author.id,
        commandText: userPrompt,
      });
      await loadingMessage.edit("사용자 검색 중 문제가 발생했어요.");
    }
    return;
  }

  if (intent.tool === "video_analysis") {
    // handleVideoAnalysis 내부에서 자체적으로 사용량 체크를 하고 답변을 마무리하므로 바로 호출하고 종료합니다.
    await handleVideoAnalysis(message, userPrompt, loadingMessage);
    return;
  }

  if (intent.tool === "google_search") {
  try {
      const query = String(intent.arguments?.query || userPrompt).trim();

      // 사용량 체크
      usageCheck = await checkAndIncrementUsage(message.author.id, "ai_calls", message.guildId);
      if (!usageCheck.allowed) {
        const limits = TIER_LIMITS[usageCheck.tier];
        await loadingMessage.edit(createLimitExceededMessage(message.author.username, limits.name, "AI 호출", limits.ai_calls, PREFIX));
        return;
      }

      // AI 호출 로그 기록 (콘솔 및 파일 로그용)
      logInfo("ai_call", {
        guildId: message.guildId,
        guildName: message.guild.name,
        channelId: message.channelId,
        userId: message.author.id,
        userName,
        userTag: message.author.tag,
        commandText: userPrompt,
        task: "google_search",
        model: GEMINI_SEARCH_MODEL,
      });

      const searchResult = await handleGoogleSearch(query);
      if (searchResult) {
        const answerWithFooter = `${stripModelFooter(searchResult)}\n\n-# 🤖 모델: ${GEMINI_SEARCH_MODEL}`;
        await sendChunkedAnswer(message, loadingMessage, answerWithFooter);

        // 결과 전송 로그 기록
        logInfo("answer_sent", {
          guildId: message.guildId,
          guildName: message.guild.name,
          channelId: message.channelId,
          userId: message.author.id,
          userName,
          answerLength: searchResult.length,
        });
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
      usageCheck = await checkAndIncrementUsage(message.author.id, "ai_calls", message.guildId);
      if (!usageCheck.allowed) {
        const limits = TIER_LIMITS[usageCheck.tier];
        await loadingMessage.edit(createLimitExceededMessage(message.author.username, limits.name, "AI 호출", limits.ai_calls, PREFIX));
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
      usageCheck = await checkAndIncrementUsage(message.author.id, "ai_calls", message.guildId);
      if (!usageCheck.allowed) {
        const limits = TIER_LIMITS[usageCheck.tier];
        await loadingMessage.edit(createLimitExceededMessage(message.author.username, limits.name, "AI 호출", limits.ai_calls, PREFIX));
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
        await decrementUsage(message.author.id, "ai_calls");
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

    usageCheck = await checkAndIncrementUsage(message.author.id, "ai_calls", message.guildId);
    if (!usageCheck.allowed) {
      const limits = TIER_LIMITS[usageCheck.tier];
      await loadingMessage.edit(createLimitExceededMessage(message.author.username, limits.name, "AI 호출", limits.ai_calls, PREFIX));
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
        await decrementUsage(message.author.id, "ai_calls");
        await loadingMessage.edit("조회하려는 로그 데이터가 너무 많아 AI가 분석할 수 없습니다. 특정 서버 ID나 더 좁은 시간 범위를 지정해서 다시 질문해 주세요.");
        return;
      }

      await loadingMessage.edit("로그를 검색하는 중 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.");
      await decrementUsage(message.author.id, "ai_calls");
    }
    return;
  }

  if (intent.type === "image_generation") {
    usageCheck = await checkAndIncrementUsage(message.author.id, "image_generations", message.guildId);
    if (!usageCheck.allowed) {
      const limits = TIER_LIMITS[usageCheck.tier];
      await loadingMessage.edit(createLimitExceededMessage(message.author.username, limits.name, "이미지 생성", limits.image_generations, PREFIX));
      return;
    }

    const success = await handleImageGenerationRequest(client, message, intent.imagePrompt, loadingMessage);
    if (!success) {
      if (usageCheck.usedServerToken) {
        await addServerImageToken(message.guildId, "image_generations");
    } else {
        await decrementUsage(message.author.id, "image_generations");
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

  usageCheck = await checkAndIncrementUsage(message.author.id, usageType, message.guildId);
  if (!usageCheck.allowed) {
    const limits = TIER_LIMITS[usageCheck.tier];
    await loadingMessage.edit(createLimitExceededMessage(message.author.username, limits.name, usageTypeName, limits[usageType], PREFIX)).catch(() => {});
    return;
  }

  let typingInterval;
  let currentStep = "command_detected";

  const usedModel = attachedImageUrls.length > 0 ? "google/diffusiongemma-26b-a4b-it" : "qwen/qwen3-32b";

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

    let serverContext = "";

    currentStep = "send_typing";
    await message.channel.sendTyping();

    currentStep = "send_loading_message";
    await loadingMessage.edit(`-# ${LOADING_EMOJI} FLUX봇이 답변을 준비하고 있어요...`).catch(() => {});

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
          intent: intent.type,
          model: usedModel,
        });

        currentStep = "parse_ai_answer";
        answer = stripCodeBlocks(stripReasoningTags(chatCompletion.choices?.[0]?.message?.content ?? ""));
        answer = stripFancyUnicode(stripModelFooter(answer));

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

        if (isPayloadTooLargeError(primaryError) || isGroqRateLimitError(primaryError)) {
          currentStep = "request_nvidia_fallback";
          await loadingMessage.edit(`-# ${LOADING_EMOJI} FLUX봇이 다른 모델로 답변을 이어서 준비하고 있어요...`);

          try {
            const fallbackCompletion = await createChatCompletion({
              userName,
              historyMessages,
              currentApiUserMessage,
              imageUrls,
              guildName: message.guild.name,
              guildId: message.guildId,
              serverContext,
              logContext: {
                ...logContext,
                fallbackFrom: usedModel,
                fallbackTo: DEEPSEEK_CHAT_MODEL,
              },
              intent: intent.type,
              model: DEEPSEEK_CHAT_MODEL,
            });

            currentStep = "parse_nvidia_fallback_answer";
            answer = stripCodeBlocks(stripReasoningTags(fallbackCompletion.choices?.[0]?.message?.content ?? ""));
            answer = stripFancyUnicode(stripModelFooter(answer));
            if (!answer || answer.trim().length === 0) {
              throw new Error("NVIDIA fallback returned empty content");
            }
          } catch (fallbackError) {
            if (isPayloadTooLargeError(fallbackError) || isGroqRateLimitError(fallbackError)) {
              await decrementUsage(message.author.id, usageType);
              await loadingMessage.edit("대화 내용이 너무 길어 AI가 처리할 수 없어요. 채널 히스토리가 짧은 곳에서 다시 시도하거나 질문을 짧게 입력해 주세요.");
              return;
            }
            throw fallbackError;
          }
        } else {
          await loadingMessage.edit("답변을 생성하는 중 문제가 발생했어요. 잠시 뒤 다시 시도해주세요.");
          await decrementUsage(message.author.id, usageType);
          return;
        }
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
        model: usedModel,
      });

      currentStep = "parse_ai_answer";
      answer = stripCodeBlocks(stripReasoningTags(chatCompletion.choices?.[0]?.message?.content ?? ""));
      answer = stripFancyUnicode(stripModelFooter(answer));
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
      await decrementUsage(message.author.id, usageType);
      return;
    }

    currentStep = "send_ai_answer";
    if (!answerAlreadySent) {
      const modelFooter = `\n\n-# 🤖 모델: ${getModelDisplayName(usedModel)}`;
      const firstTalkFooter = isFirstConversation 
        ? `\n\n-# 👋 처음 대화하시는 것이라 **${displayName}**님이라고 부를게요. 이름을 바꾸고 싶으시다면 \`${PREFIX} 이름변경 [새이름]\`을 입력해주세요!`
        : "";
      await sendChunkedAnswer(message, loadingMessage, `${answer}${modelFooter}${firstTalkFooter}`);
    }

    await appendConversationHistory(
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
      storedHistoryMessageCount: await getStoredHistoryLength(historyKey),
    });
  } catch (error) {
    if (usageCheck && usageType) {
      if (usageCheck.usedServerToken) {
        await addServerImageToken(message.guildId, usageType);
      } else {
        await decrementUsage(message.author.id, usageType);
      }
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
        : isPayloadTooLargeError(error) || isGroqRateLimitError(error)
          ? "대화 내용이 너무 길어 AI가 처리할 수 없어요. 채널 히스토리가 짧은 곳에서 다시 시도하거나 질문을 짧게 입력해 주세요."
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

function stripModelFooter(text) {
  return text.replace(/\n\n-? ?#? ?🤖 모델: .*$/gm, "").trim();
}

function getModelDisplayName(model) {
  const map = {
    "qwen/qwen3-32b": "Qwen3 32B",
    "google/diffusiongemma-26b-a4b-it": "DiffusionGemma 26B",
    "deepseek-ai/deepseek-v4-flash": "DeepSeek V4 Flash",
  };
  return map[model] || "Qwen3 32B";
}

async function sendStreamingAnswer(message, loadingMessage, stream, usedModel, isFirstConversation = false, displayName = "") {
  let fullAnswer = "";
  let sentText = "";
  let currentMessage = loadingMessage;
  let lastEditAt = 0;

  try {
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content ?? "";
      if (!delta) continue;

      fullAnswer += delta;
      const visible = stripFancyUnicode(stripCodeBlocks(stripReasoningTags(stripModelFooter(fullAnswer))));
      let currentChunk = visible.slice(sentText.length);

      while (currentChunk.length > SAFE_MESSAGE_LIMIT) {
        const toSend = currentChunk.slice(0, SAFE_MESSAGE_LIMIT);
        if (currentMessage) {
          await currentMessage.edit(toSend).catch(() => {});
        } else {
          currentMessage = await message.channel.send(toSend);
        }
        sentText += toSend;
        currentChunk = visible.slice(sentText.length);
        currentMessage = null;
        lastEditAt = Date.now();
      }

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

  const finalVisible = stripFancyUnicode(stripCodeBlocks(stripReasoningTags(stripModelFooter(fullAnswer))));
  const finalRemaining = finalVisible.slice(sentText.length).trim();
  const modelFooter = `\n\n-# 🤖 모델: ${getModelDisplayName(usedModel)}`;
  const firstTalkFooter = isFirstConversation
    ? `\n\n-# 👋 처음 대화하시는 것이라 **${displayName}**님이라고 부를게요. 이름을 바꾸고 싶으시다면 \`${PREFIX} 이름변경 [새이름]\`을 입력해주세요!`
    : "";

  if (finalRemaining) {
    const textToSend = finalRemaining + modelFooter + firstTalkFooter;
    if (currentMessage) {
      await currentMessage.edit(textToSend).catch(() => message.channel.send(textToSend));
    } else {
      await message.channel.send(textToSend);
    }
  } else if (currentMessage) {
    const lastContent = (await currentMessage.fetch()).content;
    await currentMessage.edit(lastContent + modelFooter + firstTalkFooter).catch(() => {});
  }

  return finalVisible;
}

