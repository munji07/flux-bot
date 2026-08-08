import { createVideoAnalysis } from "../services/ai.js";
import { addServerImageToken, checkAndIncrementUsage, decrementUsage } from "../services/subscription.js";
import { logError, logInfo } from "../logger.js";
import { getDisplayName } from "../utils.js";
import { LOADING_EMOJI } from "../config.js";

export async function handleVideoAnalysis(message, userPrompt, loadingMessage) {
  const videoAttachment = message.attachments.find(a => 
    a.contentType?.startsWith('video/')
  );

  if (!videoAttachment) {
    await loadingMessage.edit("분석할 영상을 첨부해주세요.");
    return;
  }

  const prompt = userPrompt || "이 영상의 내용을 아주 상세하게 분석해줘. 영상의 흐름을 시간대별로 나누어 각 부분에서 어떤 일이 일어나는지 요약하고, 영상 전체에서 전달하고자 하는 핵심 주제나 결론을 포함해서 아주 자세하게 설명해줘.";
  const userName = await getDisplayName(message);
  
  let usageCheck = null;
  await loadingMessage.edit(`-# ${LOADING_EMOJI} FLUX봇이 영상을 분석 중이에요... 잠시만 기다려 주세요!`);

  try {
    // 사용량 체크
    usageCheck = await checkAndIncrementUsage(message.author.id, "video_analysis", message.guildId);
    if (!usageCheck.allowed) {
      await loadingMessage.edit("죄송해요! 영상 분석은 프리미엄 등급에게 하루 3회까지만 제공돼요. `!FLUX 후원`을 통해 프리미엄 등급을 이용해보세요!");
      return true;
    }

    const response = await createVideoAnalysis({
      logContext: {
        guildName: message.guild.name,
        channelId: message.channelId,
        userId: message.author.id,
        userName,
        userTag: message.author.tag,
        commandText: prompt,
      },
      videoUrl: videoAttachment.url,
      prompt,
      userName,
      guildName: message.guild.name,
    });

    await loadingMessage.edit(response.choices[0].message.content);

    logInfo("answer_sent", {
      guildId: message.guildId,
      guildName: message.guild.name,
      channelId: message.channelId,
      userId: message.author.id,
      userName,
      answerLength: response.choices[0].message.content.length,
    });
    return true;
  } catch (error) {
    if (usageCheck?.usedServerToken) {
      // 서버 토큰을 사용했다면 토큰을 다시 돌려줌
      addServerImageToken(message.guildId, "video_analysis");
    } else {
      decrementUsage(message.author.id, "video_analysis");
    }

    logError("video_analysis_failed", message.guildId, error, {
      userId: message.author.id,
      channelId: message.channelId,
      userName,
      userTag: message.author.tag,
      commandText: prompt,
    });
    await loadingMessage.edit("영상 분석 중 오류가 발생했어요. 다시 시도해 주세요.").catch(() => {});
    return false;
  }
}

