import { Groq } from "groq-sdk";
import { OpenAI } from "openai";
import {
  HF_CHAT_MODEL,
  GROQ_CHAT_MODEL,
  GEMINI_CHAT_MODEL,
  GEMINI_WEB_SEARCH_MODEL,
  GEMINI_WEB_SEARCH_MODEL_LITE,
  HF_BASE_URL,
  IMAGE_GENERATION_MODEL,
  IMAGE_MODEL,
  SYSTEM_PROMPT,
} from "../config.js";
import { logError, logInfo } from "../logger.js";
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
  return imageUrls.length > 0 ? IMAGE_MODEL : HF_CHAT_MODEL;
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
    model: HF_CHAT_MODEL,
    hasImageAttachment,
    promptLength: userPrompt.length,
  });
  const completion = await aiClient.chat.completions.create({
    model: HF_CHAT_MODEL,
    messages: [
      {
        role: "system",
        content: SYSTEM_PROMPT,
      },
      {
        role: "system",
        content: [
          "너는 디스코드 봇 요청 라우터야.",
          "상황을 묘사하는 말을 사용하지 말고 이모지를 필요할 때만 사용해. 사람과 대화할 때는 존댓말을 사용해.",
          "사용자 메시지를 보고 아래 네 가지 중 하나로만 분류해.",
          "- chat: 일반 대화, 질문, 서버 관리가 아닌 텍스트 요청",
          "- image_read: 사용자가 이미지, 사진, 스크린샷, 첨부물을 읽거나 설명하거나 분석해달라는 요청",
          "- image_generation: 사용자가 새 이미지, 그림, 사진, 일러스트, 아이콘, 배너, 프로필 이미지, 썸네일 등을 만들어달라는 요청",
          "자연스러운 표현이 되도록 판단해. 예를 들어 '몽환적인 배너 하나 만들어줄래?', '프로필에 쓸 그림 부탁해'는 image_generation이야.",
          "반드시 JSON만 출력해. 마크다운, 설명, 코드블록은 쓰지 마.",
          '형식: {"type":"chat|image_read|image_generation|log_search","imagePrompt":"이미지 생성을 위한 프롬프트 또는 빈 문자열"}',
          
          "분류기 확장: 사용자가 봇/서버 로그, 명령어 기록, 오류, AI 호출 로그 검색, 또는 관리자 작업 수행자 확인을 요청할 때는 log_search 타입을 사용하세요.",
          "log_search 필수 예시: 어제 닉네임 변경한 사람 찾아줘 / 어제 AI 로그 보여줘 / 누가 차단했어?",
          "허용된 JSON type 값: chat, image_read, image_generation, log_search.",
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

  const request = ({ model: requestModel }) => {
    if (imageUrls.length === 0) {
      return aiClient.chat.completions.create({
        model: requestModel,
        messages: createTextChatMessages(userName, historyMessages, currentApiUserMessage),
        temperature: 0.6,
        max_completion_tokens: 4096,
        top_p: 0.95,
        stream: false,
        reasoning_effort: "default",
        stop: null,
      });
    }

    return aiClient.chat.completions.create({
      model: requestModel,
      messages: [
        {
          role: "system",
          content: SYSTEM_PROMPT,
        },
        {
          role: "system",
          content: `현재 응답해야 하는 유저 이름 변수 userName은 "${userName}"입니다. 답변에서 반드시 "${userName}"님이라고 불러주세요.`,
        },
        ...historyMessages,
        {
          role: currentApiUserMessage.role,
          content: currentApiUserMessage.content,
        },
      ],
      temperature: 0.6,
      max_completion_tokens: 4096,
      top_p: 0.95,
      stream: false,
      reasoning_effort: "default",
      stop: null,
    });
  };

  try {
    return await request({ model });
  } catch (error) {
    if (imageUrls.length === 0 && model === HF_CHAT_MODEL) {
      logError("chat_completion_fallback", logContext.guildId, error, {
        ...logContext,
        fallbackModel: GEMINI_CHAT_MODEL,
      });

      return await request({ model: GEMINI_CHAT_MODEL });
    }

    throw error;
  }
}

export async function createChatCompletionStream({
  userName,
  historyMessages,
  currentApiUserMessage,
  imageUrls,
  logContext = {},
}) {
  if (imageUrls.length > 0) {
    throw new Error("Groq 스트리밍 채팅은 텍스트 메시지만 지원합니다.");
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

export async function shouldUseWebSearch({ userPrompt, logContext = {} }) {
  const prompt = userPrompt.trim();
  if (!prompt) return false;

  logInfo("ai_call", {
    ...logContext,
    task: "web_search_classification",
    model: GROQ_CHAT_MODEL,
    promptLength: prompt.length,
  });

  try {
    const completion = await aiClient.chat.completions.create({
      model: GEMINI_WEB_SEARCH_MODEL,
      messages: [
        {
          role: "system",
          content: [
            "이 디스코드 메시지에 답변하기 위해 실시간 웹 검색이 필요한지 판단하세요.",
            '반드시 JSON 형식으로만 응답하세요: {"webSearch":true} 또는 {"webSearch":false}.',
            "최신 뉴스, 오늘의 데이터, 가격, 일정, 날씨, 스포츠 경기 결과, 법률, 제품 재고 상태 또는 최신 버전 정보와 같이 실시간 정보가 필요한 경우 true를 사용하세요.",
            "일반적인 상식, 코딩 도움말, 작문, 번역, 수학 또는 변하지 않는 사실에 대해서는 false를 사용하세요.",
          ].join("\n"),
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0,
      max_completion_tokens: 32,
    });

    const content = completion.choices?.[0]?.message?.content?.trim() ?? "";
    const parsed = parseJsonObject(content);
    return parsed?.webSearch === true;
  } catch (error) {
    logError("web_search_classification_failed", logContext.guildId, error, logContext);
    return false;
  }
}

export async function createLogSearchAnswer({
  userPrompt,
  records,
  timeRangeLabel,
  requester,
  logContext = {},
}) {
  logInfo("ai_call", {
    ...logContext,
    task: "log_search_summary",
    model: GROQ_CHAT_MODEL,
    promptLength: userPrompt.length,
    logRecordCount: records.length,
  });

  const completion = await groqClient.chat.completions.create({
    model: GROQ_CHAT_MODEL,
    messages: [
      {
        role: "system",
        content: [
          "당신은 관리자에게 Discord 봇 JSON 로그를 요약해 주는 도우미입니다.",
          "한국어로 간결하고 자연스럽게 답변하세요.",
          "반드시 제공된 로그 기록만 사용하세요. 없는 내용을 추측하거나 만들어내지 마세요.",
          "각 기록에는 actor/action/target/object가 정규화된 cls 필드가 있습니다. 가능하면 원본 텍스트보다 cls 필드를 우선 사용하세요.",
          "사용자 질문과 관련된 기록만 선택하고, 관련 없는 기록은 무시하세요.",
          "제공된 기록 중 관련된 내용이 없다면 검색 범위 내에서 일치하는 로그를 찾지 못했다고 답변하세요.",
          "질문에 '누가', '나', 'me'가 포함되어 있으면 requester 객체를 기준으로 해석하세요.",
          "대상 사용자를 확인할 수 있다면 display name, tag, id를 함께 포함하세요.",
          "근거가 commandText뿐이라면 명령어 텍스트를 바탕으로 추정한 내용임을 명시하세요.",
          "필요한 경우 로그에 기록된 정확한 로컬 시간을 포함하세요."
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          query: userPrompt,
          timeRange: timeRangeLabel,
          requester,
          records,
        }),
      },
    ],
    temperature: 0.2,
    max_completion_tokens: 600,
  });

  return stripReasoningTags(completion.choices?.[0]?.message?.content ?? "");
}

export async function createWebSearchCompletionStream({
  userName,
  historyMessages,
  currentApiUserMessage,
  imageUrls,
  logContext = {},
}) {
  if (imageUrls.length > 0) {
    throw new Error("Groq 웹 검색 스트리밍은 텍스트 메시지만 지원합니다.");
  }

  const searchModels = [GEMINI_WEB_SEARCH_MODEL, GEMINI_WEB_SEARCH_MODEL_LITE];
  let lastError;

  for (const model of searchModels) {
    logInfo("ai_call", {
      ...logContext,
      task: "web_search_stream",
      model,
      imageCount: 0,
      historyMessageCount: historyMessages.length,
    });

    try {
      return await aiClient.chat.completions.create({
        model,
        messages: [
          {
            role: "system",
            content: [
              "너는 웹 검색 보조원이야.",
              "가급적 한국어로 답변해줘.",
              "가장 최신의 정보를 사용해.",
              "간결하게 답변하고 마지막에 작은 출처 블록을 포함해.",
              "출처 블록은 '출처: [링크]' 또는 간략한 참조 목록과 같은 짧은 푸터 형식으로 작성해.",
              "출처 블록이 답변의 주가 되지 않도록 주의하고, 본문과 명확히 구분하여 최소한으로 유지해.",
            ].join(" "),
          },
          ...createTextChatMessages(userName, historyMessages, currentApiUserMessage),
        ],
        temperature: 0.4,
        max_completion_tokens: 4096,
        stream: true,
      });
    } catch (error) {
      lastError = error;
      logError("web_search_model_attempt_failed", logContext.guildId, error, {
        ...logContext,
        model,
      });
    }
  }

  throw lastError;
}

function createTextChatMessages(userName, historyMessages, currentApiUserMessage) {
  return [
    {
      role: "system",
      content: SYSTEM_PROMPT,
    },
    {
      role: "system",
      content: `현재 사용자의 이름은 "${userName}"입니다. 답변할 때 유저를 이 이름으로 불러주세요.`,
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
  
 // 업스케일 코드가 인식할 수 있도록 Blob을 Base64 문자열로 변환
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
  const allowedTypes = new Set(["chat", "image_read", "image_generation", "log_search"]);
  const type = allowedTypes.has(parsed?.type) ? parsed.type : "chat";
  const imagePrompt =
    type === "image_generation"
      ? String(parsed?.imagePrompt || userPrompt).trim()
      : "";

  return {
    type,
    imagePrompt: type === "image_generation" ? imagePrompt || userPrompt.trim() : "",
    raw: content,
  };
}

export async function matchServerMember({ guildName, targetText, candidates, logContext = {} }) {
  logInfo("ai_call", {
    ...logContext,
    task: "member_matching",
    model: HF_CHAT_MODEL,
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
    model: HF_CHAT_MODEL,
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
          "후보 중에서 딱 맞는 멤버가 없으면 memberId를 null로 반환해.",
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

export function stripReasoningTags(content) {
  let result = String(content);

  while (true) {
    const lowerResult = result.toLowerCase();
    const start = lowerResult.indexOf("<think>");
    if (start < 0) break;

    const end = lowerResult.indexOf("</think>", start + "<think>".length);
    if (end < 0) {
      result = result.slice(0, start);
      break;
    }

    result = result.slice(0, start) + result.slice(end + "</think>".length);
  }

  return result.trim();
}
