import { OpenAI } from "openai";
import {
  CHAT_MODEL,
  HF_BASE_URL,
  IMAGE_GENERATION_MODEL,
  IMAGE_MODEL,
  SYSTEM_PROMPT,
} from "../config.js";
import { logInfo } from "../logger.js";
import { createUserMessageContent } from "../utils/message.js";
import { InferenceClient } from "@huggingface/inference";
const hfClient = new InferenceClient(process.env.HF_TOKEN);

export const aiClient = new OpenAI({
  baseURL: HF_BASE_URL,
  apiKey: process.env.HF_TOKEN,
});

export function getChatModel(imageUrls) {
  return imageUrls.length > 0 ? IMAGE_MODEL : CHAT_MODEL;
}

export function getChatTask(imageUrls) {
  return imageUrls.length > 0 ? "image_read" : "chat";
}

export function createApiUserMessage(userName, userPrompt, imageUrls) {
  const text = createUserMessageContent(userName, userPrompt, imageUrls);

  if (imageUrls.length === 0) {
    return {
      role: "user",
      content: text,
    };
  }

  return {
    role: "user",
    content: [
      {
        type: "text",
        text,
      },
      ...imageUrls.map((url) => ({
        type: "image_url",
        image_url: {
          url,
        },
      })),
    ],
  };
}

export async function classifyRequestIntent({ userPrompt, hasImageAttachment, logContext = {} }) {
  logInfo("ai_call", {
    ...logContext,
    task: "intent_classification",
    model: CHAT_MODEL,
    hasImageAttachment,
    promptLength: userPrompt.length,
  });
  const completion = await aiClient.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      {
        role: "system",
        content: [
          "너는 디스코드 봇 요청 라우터야.",
          "상황을 묘사하는 말을 사용하지 말고 이모지를 필요할때만 사용해. 사람과 대화할때는 존뎃말을 사용해.",
          "사용자 메시지를 보고 아래 셋 중 하나로만 분류해.",
          "- chat: 일반 대화, 질문, 서버 관리가 아닌 텍스트 요청",
          "- image_read: 사용자가 이미지, 사진, 스크린샷, 첨부물을 읽거나 설명하거나 분석해 달라는 요청",
          "- image_generation: 사용자가 새 이미지, 그림, 사진, 일러스트, 아이콘, 배너, 프로필 이미지, 썸네일 등을 만들어 달라는 요청",
          "자연스러운 표현도 의도로 판단해. 예를 들어 '몽환적인 배너 하나 만들어줄래', '프로필에 쓸 그림 부탁해'는 image_generation이야.",
          "반드시 JSON만 출력해. 마크다운, 설명, 코드블록은 쓰지 마.",
          '형식: {"type":"chat|image_read|image_generation","imagePrompt":"이미지 생성용 프롬프트 또는 빈 문자열"}',
          
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          userPrompt,
          hasImageAttachment,
        }),
      },
    ],
  });

  const content = completion.choices?.[0]?.message?.content?.trim() ?? "";
  return normalizeIntentResult(content, userPrompt);
}

export async function createChatCompletion({
  userName,
  historyMessages,
  currentApiUserMessage,
  imageUrls,
  logContext = {},
}) {
  const model = getChatModel(imageUrls);
  const task = getChatTask(imageUrls);

  logInfo("ai_call", {
    ...logContext,
    task,
    model,
    imageCount: imageUrls.length,
    historyMessageCount: historyMessages.length,
  });

  return aiClient.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content: SYSTEM_PROMPT,
      },
      {
        role: "system",
        content: `현재 응답해야 하는 유저 이름 변수 userName은 "${userName}"입니다. 답변에서 반드시 "${userName}님"이라고 불러주세요.`,
      },
      ...historyMessages,
      {
        role: currentApiUserMessage.role,
        content: currentApiUserMessage.content,
      },
    ],
  });
}

export async function generateImage(prompt, logContext = {}) {
  logInfo("ai_call", {
    ...logContext,
    task: "image_generation",
    model: IMAGE_GENERATION_MODEL,
    promptLength: prompt.length,
  });

  const imageBlob = await hfClient.textToImage({
    provider: "auto",
    model: IMAGE_GENERATION_MODEL,
    inputs: prompt,
    parameters: { num_inference_steps: 5 },
  });

  // 디스코드 핸들러가 인식할 수 있도록 Blob을 Base64 문자열로 변환
  const arrayBuffer = await imageBlob.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const base64Json = buffer.toString("base64");

  return {
    data: [
      {
        b64_json: base64Json
      },
    ],
  }
}

function normalizeIntentResult(content, userPrompt) {
  const parsed = parseJsonObject(content);
  const allowedTypes = new Set(["chat", "image_read", "image_generation"]);
  const type = allowedTypes.has(parsed?.type) ? parsed.type : "chat";
  const imagePrompt =
    type === "image_generation"
      ? String(parsed?.imagePrompt || userPrompt).trim()
      : "";

  return {
    type,
    imagePrompt: imagePrompt || userPrompt.trim(),
    raw: content,
  };
}

function parseJsonObject(content) {
  try {
    return JSON.parse(content);
  } catch {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");

    if (start < 0 || end <= start) return null;

    try {
      return JSON.parse(content.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}
