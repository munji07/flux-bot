import { createVideoAnalysis } from "../services/ai.js";
import { checkAndIncrementUsage, decrementUsage } from "../services/subscription.js";
import { logError, logInfo } from "../logger.js";
import { getDisplayName } from "../utils/message.js";

export async function handleVideoAnalysis(message, userPrompt) {
  const videoAttachment = message.attachments.find(a => 
    a.contentType?.startsWith('video/')
  );

  if (!videoAttachment) {
    return message.reply("분석할 영상을 첨부해주세요.");
  }

  const prompt = userPrompt || "이 영상을 분석하고 핵심 내용을 요약해줘.";
  const userName = getDisplayName(message);

  logInfo("video_analysis_start", {
    guildId: message.guildId,
      userId: message.author.id,
    userName,
    prompt,
    videoUrl: videoAttachment.url
    });

  try {
    const msg = await message.reply("-# <a:loading:1495336917326368829> DUST봇이 영상을 분석 중이에요... 잠시만 기다려 주세요!");
    console.log(`Video analysis started for user: ${message.author.id}, video: ${videoAttachment.url}`);

    // 사용량 체크
    const usageCheck = checkAndIncrementUsage(message.author.id, "video_analysis", message.guildId);
    if (!usageCheck.allowed) {
      return await msg.edit("죄송해요! 영상 분석은 프리미엄 등급에게 하루 3회까지만 제공돼요. `!먼지야 등급 구매`를 통해 프리미엄 등급을 이용해보세요!");
    }

    const response = await createVideoAnalysis({
      userId: message.author.id,
      videoUrl: videoAttachment.url,
      prompt: prompt,
      userName: userName,
      guildName: message.guild.name
    });

    console.log(`Video analysis success for user: ${message.author.id}`);
    logInfo("video_analysis_success", {
      guildId: message.guildId,
      userId: message.author.id,
      userName,
    });

    await msg.edit(response.choices[0].message.content);
  } catch (error) {
    console.error(`Video analysis failed for user: ${message.author.id}, error:`, error);
    decrementUsage(message.author.id, "video_analysis");

    logError("video_analysis_failed", message.guildId, error, {
      userId: message.author.id,
      channelId: message.channelId,
      prompt
    });
      message.reply("영상 분석 중 오류가 발생했어요. 다시 시도해 주세요.");
    }
  }

