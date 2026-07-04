import { db } from "./database.js";
import { nvidiaClient } from "./ai.js";
import { logError, logInfo } from "../logger.js";

const DEFAULT_MESSAGE_LIMIT = 50;
const SUMMARY_MODEL = "meta/llama-3.1-8b-instruct";

const SUMMARY_SYSTEM_PROMPT = [
  "You are a Korean Discord chat summarizer. Given a list of channel messages, produce a concise Korean summary.",
  "",
  "Rules:",
  "- 반드시 한국어로만 요약하세요.",
  "- 전체 메시지의 주요 주제와 키워드를 3~5개 불렛포인트로 정리하세요.",
  "- 대화의 전체적인 분위기(진지함, 가벼움, 논쟁 등)를 한 문장으로 언급하세요.",
  "- 특정 유저를 지목하는 발언은 유저명을 포함해도 좋지만, 지나친 개인 언급은 피하세요.",
  "- 메시지가 3개 미만이면 '최근 메시지가 충분하지 않아 요약할 수 없어요.'라고 답변하세요.",
  "- 출력 형식:",
  "  ## 💬 채널 요약",
  "  **📌 주요 주제**",
  "  - ...",
  "  - ...",
  "  **📊 대화 분위기**",
  "  - ...",
  "",
  "Keep it under 500 characters total.",
].join("\n");

export async function generateChannelSummary(guildId, channelId, channelName, limit = DEFAULT_MESSAGE_LIMIT) {
  const messages = await db.all(
    `SELECT user_name, content, created_at
     FROM channel_messages
     WHERE guild_id = $1 AND channel_id = $2 AND content IS NOT NULL AND content != ''
     ORDER BY created_at DESC
     LIMIT $3`,
    [guildId, channelId, limit],
  );

  if (messages.length < 3) {
    return null;
  }

  const messageLog = messages
    .reverse()
    .map((m, i) => `[${i + 1}] ${m.user_name || "알 수 없음"}: ${m.content.slice(0, 300)}`)
    .join("\n");

  try {
    const completion = await nvidiaClient.chat.completions.create({
      model: SUMMARY_MODEL,
      temperature: 0.3,
      max_tokens: 1024,
      messages: [
        { role: "system", content: SUMMARY_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            `채널명: #${channelName}`,
            `메시지 수: ${messages.length}개`,
            "",
            messageLog,
          ].join("\n"),
        },
      ],
    });

    const summary = completion.choices?.[0]?.message?.content?.trim() ?? "";
    return summary;
  } catch (error) {
    logError("summary_failed", guildId, error, { channelId });
    throw error;
  }
}
