import { Groq } from "groq-sdk";
import { OpenAI } from "openai";
import {
  CHAT_MODEL,
  GROQ_CHAT_MODEL,
  GROQ_WEB_SEARCH_MODEL,
  HF_BASE_URL,
  IMAGE_GENERATION_MODEL,
  IMAGE_MODEL,
  SYSTEM_PROMPT,
} from "../config.js";
import { logInfo } from "../logger.js";
import { createUserMessageContent } from "../utils/message.js";
import { InferenceClient } from "@huggingface/inference";

const hfClient = new InferenceClient(process.env.HF_TOKEN);
const groqClient = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

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
        content: SYSTEM_PROMPT,
      },
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

export async function createChatCompletionStream({
  userName,
  historyMessages,
  currentApiUserMessage,
  imageUrls,
  logContext = {},
}) {
  if (imageUrls.length > 0) {
    throw new Error("Groq streaming chat only supports text messages.");
  }

  logInfo("ai_call", {
    ...logContext,
    task: "chat_stream",
    model: GROQ_CHAT_MODEL,
    imageCount: 0,
    historyMessageCount: historyMessages.length,
  });

  return groqClient.chat.completions.create({
    model: GROQ_CHAT_MODEL,
    messages: createTextChatMessages(userName, historyMessages, currentApiUserMessage),
    temperature: 0.6,
    max_completion_tokens: 4096,
    top_p: 0.95,
    stream: true,
    reasoning_effort: "default",
    stop: null,
  });
}

export async function createWebSearchCompletionStream({
  userName,
  historyMessages,
  currentApiUserMessage,
  imageUrls,
  logContext = {},
}) {
  if (imageUrls.length > 0) {
    throw new Error("Groq web search chat only supports text messages.");
  }

  logInfo("ai_call", {
    ...logContext,
    task: "web_search_chat_stream",
    model: GROQ_WEB_SEARCH_MODEL,
    imageCount: 0,
    historyMessageCount: historyMessages.length,
  });

  return groqClient.chat.completions.create({
    model: GROQ_WEB_SEARCH_MODEL,
    messages: [
      {
        role: "system",
        content: "Use web search for current facts, cite sources naturally, and answer in Korean unless the user asks otherwise.",
      },
      ...createTextChatMessages(userName, historyMessages, currentApiUserMessage),
    ],
    citation_options: "enabled",
    compound_custom: {
      tools: {
        enabled_tools: ["web_search"],
      },
    },
    stream: true,
  });
}

export async function shouldUseWebSearch({ userPrompt, logContext = {} }) {
  logInfo("ai_call", {
    ...logContext,
    task: "web_search_need_classification",
    model: GROQ_CHAT_MODEL,
    promptLength: userPrompt.length,
  });

  try {
    const completion = await groqClient.chat.completions.create({
      model: GROQ_CHAT_MODEL,
      messages: [
        {
          role: "system",
          content: [
            "Decide whether answering the user's message requires web search.",
            "Return JSON only: {\"webSearch\":true} or {\"webSearch\":false}.",
            "Use true for latest/current/recent facts, news, prices, schedules, weather, laws, versions, releases, live status, or explicit search requests.",
            "Use false for timeless conversation, reasoning, translation, writing, coding help, or questions answerable from conversation context.",
          ].join("\n"),
        },
        {
          role: "user",
          content: userPrompt,
        },
      ],
      temperature: 0,
      max_completion_tokens: 64,
      response_format: { type: "json_object" },
      reasoning_effort: "none",
    });

    const content = completion.choices?.[0]?.message?.content?.trim() ?? "";
    const parsed = parseJsonObject(content);
    if (typeof parsed?.webSearch === "boolean") {
      return parsed.webSearch;
    }
  } catch {
    return looksLikeWebSearchRequest(userPrompt);
  }

  return looksLikeWebSearchRequest(userPrompt);
}

function createTextChatMessages(userName, historyMessages, currentApiUserMessage) {
  return [
    {
      role: "system",
      content: SYSTEM_PROMPT,
    },
    {
      role: "system",
      content: `The current user's display name is "${userName}". Address the user by that name in your answer.`,
    },
    ...historyMessages,
    {
      role: currentApiUserMessage.role,
      content:
        typeof currentApiUserMessage.content === "string"
          ? currentApiUserMessage.content
          : JSON.stringify(currentApiUserMessage.content),
    },
  ];
}

function looksLikeWebSearchRequest(userPrompt) {
  return /(?:검색|찾아봐|찾아줘|알아봐|알려줘.*(?:최신|최근|현재|오늘|지금)|최신|최근|현재|오늘|내일|어제|실시간|뉴스|날씨|주가|환율|가격|일정|버전|릴리즈|업데이트|근황|발표|web|search|latest|recent|current|today|news|weather|price|schedule|release|update)/i.test(userPrompt);
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

export async function matchServerMember({ guildName, targetText, candidates, logContext = {} }) {
  logInfo("ai_call", {
    ...logContext,
    task: "member_matching",
    model: CHAT_MODEL,
    targetText,
    candidateCount: candidates.length,
  });

  const candidateData = candidates.map((member) => ({
    id: member.id,
    username: member.user.username,
    displayName: member.displayName,
    tag: member.user.tag,
  }));

  const completion = await aiClient.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      {
        role: "system",
        content: SYSTEM_PROMPT,
      },
      {
        role: "system",
        content: [
          "너는 디스코드 서버에서 대상 멤버를 찾는 관리자 보조 도구야.",
          "사용자가 입력한 대상 텍스트를 보고, 후보 목록에서 가장 적합한 멤버를 선택해.",
          "후보 중에서 잘 맞는 멤버가 없으면 memberId를 null로 반환해.",
          "항상 JSON만 출력해야 해. 마크다운, 코드블록, 추가 설명은 쓰지 마.",
          "출력 형식: {\"memberId\":\"123456789012345678\"} 또는 {\"memberId\":null}",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          guildName,
          targetText,
          candidates: candidateData,
        }),
      },
    ],
  });

  const content = completion.choices?.[0]?.message?.content?.trim() ?? "";
  return parseMemberMatchResult(content);
}

function parseMemberMatchResult(content) {
  const parsed = parseJsonObject(content);
  if (!parsed || typeof parsed.memberId !== "string") {
    return { memberId: null };
  }

  return { memberId: parsed.memberId };
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
