import { Groq } from "groq-sdk";
import { OpenAI } from "openai";
import {
  DEEPSEEK_CHAT_MODEL,
  GROQ_CHAT_MODEL,
  GEMINI_CHAT_MODEL,
  GEMINI_WEB_SEARCH_MODEL,
  ADMIN_USER_ID,
  SYSTEM_PROMPT,
  HISTORY_BATCH_SIZE,
} from "../config.js";
import { logError, logInfo } from "../logger.js";
import { createUserMessageContent } from "../utils/message.js";
import { checkAndIncrementUsage } from "./subscription.js";

export const groqClient = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

export const deepseekClient = new OpenAI({
  baseURL: "https://integrate.api.nvidia.com/v1",
  apiKey: process.env.NVIDIA_API_KEY,
});

export const nvidiaClient = new OpenAI({
  baseURL: "https://integrate.api.nvidia.com/v1",
  apiKey: process.env.NVIDIA_API_KEY,
});

export const geminiClient = new OpenAI({
  baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
  apiKey: process.env.GEMINI_API_KEY,
});

export async function createVideoAnalysis({ videoUrl, prompt, userName, guildName, logContext = {} }) {
  // 사용량 체크는 이미 호출부(handleVideoAnalysis)에서 수행함
  const model = "nvidia/nemotron-nano-12b-v2-vl";
  
  logInfo("ai_call", {
    ...logContext,
    userId: logContext.userId, // 로거에서 인식할 수 있도록 명시
    task: "video_analysis",
    model: model,
    videoUrl: videoUrl,
  });

  const messages = [
    { role: "system", content: "당신은 영상 내용을 분석하는 AI입니다. 영상의 핵심 내용을 요약하고 질문에 답변하세요." },
    { role: "system", content: `현재 유저 이름은 "${userName}"입니다.` },
    { role: "system", content: `현재 서버 이름은 "${guildName}"입니다.` },
    {
      role: "user",
      content: [
        { type: "text", text: prompt },
        {
          type: "video_url",
          video_url: { url: videoUrl },
        },
      ],
    },
  ];

  return await nvidiaClient.chat.completions.create({
    model: model,
    messages: messages,
    max_completion_tokens: 4096,
  });
}

function getClientForModel(model) {
  if (model === "meta/llama-4-maverick-17b-128e-instruct") {
    return nvidiaClient;
  }
  if (model === DEEPSEEK_CHAT_MODEL) {
    return deepseekClient;
  }
  if (model && model.startsWith("gemini-")) {
    return geminiClient;
  }
  return deepseekClient;
}

export function getChatModel(imageUrls) {
  return imageUrls.length > 0 ? "meta/llama-4-maverick-17b-128e-instruct" : DEEPSEEK_CHAT_MODEL;
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

export const AI_TOOLS = [
  {
    type: "function",
    function: {
      name: "generate_image",
      description: "Generates a new image, picture, drawing, illustration, banner, thumbnail, or icon based on the user request. Call this tool when the user asks to draw or create an image.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "The detailed prompt describing the image to generate. Translate to English for better results.",
          },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_logs",
      description: `Owner-only tool. Use only when requester user id is ${ADMIN_USER_ID}. Searches the Discord guild logs, error logs, user commands, timeouts, nickname changes, and other administration history logs.`,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query (e.g. '어제 닉네임 변경한 사람', '오늘 발생한 에러').",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "google_search",
      description: "Search Google for real-time information, weather, news, events, prices, etc. Use this when the user's query requires fresh or external knowledge.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query.",
          },
        },
        required: ["query"],
      },
    },
  }
];

export const INTENT_TOOL_NAMES = new Set([
  "chat",
  "image_read",
  "video_analysis",
  "generate_image",
  "search_logs",
  "google_search",
  "run_management",
  "subscription",
  "bot_feature_info",
  "pronunciation",
  "developer_diagnostics",
  "confirm_management",
  "cancel_management",
]);

const INTENT_ROUTER_PROMPT = [
  "You are the first and only intent router for a Discord bot.",
  "Do not use keyword rules. Infer the user's intent from meaning.",
  "Return JSON only. No markdown, no prose, no code fences.",
  'Schema: {"tool":"chat|image_read|video_analysis|generate_image|search_logs|google_search|run_management|subscription|bot_feature_info|pronunciation|developer_diagnostics|confirm_management|cancel_management","arguments":{...}}',
  "",
  "Tool meanings:",
  "- chat: normal conversation or questions that do not require another tool.",
  "- image_read: the user wants attached images/screenshots/photos analyzed.",
  '- video_analysis: Use when the user attaches a video file and asks to analyze, summarize, or talk about the video content. arguments: {"prompt":"what to ask about the video"}',
  '- generate_image: create a new image/drawing/banner/icon/profile picture/thumbnail. arguments: {"prompt":"detailed image prompt, preferably English"}.',
  `- search_logs: owner-only. Use only when requester user id is ${ADMIN_USER_ID}. Search this bot/guild logs, errors, command history, AI call history, or admin action records. arguments: {"query":"natural language log query"}.`,
  '- google_search: answer needs fresh external information such as current news, prices, schedules, versions, weather, laws, or live facts. arguments: {"query":"search query"}.',
  '- run_management: perform Discord moderation/server-management. arguments: {"command":"help|deleteMessage|purgeMessages|setSlowMode|timeoutMember|kickMember|banMember|muteMember|deafenMember|moveMember|disconnectMember|changeNickname|autoMod|auditLog|setVerificationLevel|addRole|removeRole|addRolePermission|removeRolePermission","args":["..."]}. Put target/user/channel/role/duration/reason values in execution order.',
  '- subscription: plan/tier/usage, purchase (tier or server tokens), or admin assignment. arguments: {"action":"status|purchase|grant","targetUserId":"","tier":"free|basic|premium","type":"tier|image_generations|image_readings","count":number,"days":30}. "type" must be "image_generations" for drawing tokens, or "image_readings" for analysis/reading tokens.',
  '- bot_feature_info: answer questions about what this bot can do, available bot features, usage, limits, subscription, image generation/reading, web search, management commands, or which source file owns a feature. arguments: {"query":"user question about bot features"}.',
  '- pronunciation: convert Korean pronunciation to romanization or English pronunciation to Hangul. arguments: {"text":"text to convert"}.',
  '- developer_diagnostics: only when the requester is owner/developer user id 1269575955626725390 and asks to inspect internal source, console/bot logs, error logs, or recent failures. arguments: {"query":"what to investigate","files":["optional repo-relative source file paths"],"includeSource":true}.',
  "- confirm_management: the user confirms a pending dangerous management action.",
  "- cancel_management: the user cancels a pending dangerous management action.",
  "",
  "Important:",
  "- Simple questions about users or server facts are chat unless the user explicitly asks to search logs/history.",
  "- If an image is attached but the user asks to create a new image, use generate_image.",
  "- For run_management, preserve raw IDs/mentions when present. For natural names, put the spoken target text as the first arg so member matching can resolve it.",
].join("\n");

export async function classifyRequestIntent({ userPrompt, hasImageAttachment, hasVideoAttachment, logContext = {} }) {
  logInfo("ai_call", {
    ...logContext,
    task: "intent_classification",
    model: DEEPSEEK_CHAT_MODEL,
    hasImageAttachment,
    hasVideoAttachment,
    promptLength: userPrompt.length,
  });

  const requestClassification = async (modelName) => {
    const client = getClientForModel(modelName);
    const completion = await client.chat.completions.create({
      model: modelName,
      messages: [
        {
          role: "system",
          content: SYSTEM_PROMPT,
        },
        {
          role: "system",
          content: INTENT_ROUTER_PROMPT,
        },
        {
          role: "user",
          content: JSON.stringify({
            userPrompt,
            hasImageAttachment,
            hasVideoAttachment,
            videoInstructions: "If a video is attached (hasVideoAttachment: true), prefer using the 'video_analysis' tool if the user asks about the content.",
          }),
        },
      ],
    });
    return completion.choices?.[0]?.message?.content?.trim() ?? "";
  };

  try {
    const content = await requestClassification(DEEPSEEK_CHAT_MODEL);
    return normalizeIntentResult(content, userPrompt);
  } catch (error) {
    logError("intent_classification_failed_trying_fallback", logContext.guildId, error, {
      ...logContext,
      fallbackModel: GEMINI_CHAT_MODEL,
    });
    try {
      const content = await requestClassification(GEMINI_CHAT_MODEL);
      return normalizeIntentResult(content, userPrompt);
    } catch (fallbackError) {
      logError("intent_classification_fallback_failed", logContext.guildId, fallbackError, logContext);
      throw fallbackError;
    }
  }
}

export async function createChatCompletion({
  userName,
  historyMessages,
  currentApiUserMessage,
  imageUrls,
  guildName,
  guildId,
  serverContext = "",
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
    const client = getClientForModel(requestModel);
    const options = {
      model: requestModel,
      temperature: 1,
      top_p: 0.95,
      max_completion_tokens: 16384,
      stream: false,
    };

    if (requestModel === DEEPSEEK_CHAT_MODEL) {
      options.chat_template_kwargs = { "thinking": true, "reasoning_effort": "high" };
    }

    if (requestModel !== "meta/llama-4-maverick-17b-128e-instruct" && !requestModel.includes("deepseek")) {
      options.tools = AI_TOOLS;
    }

    if (imageUrls.length === 0) {
      return client.chat.completions.create({
        ...options,
        messages: createTextChatMessages(userName, historyMessages, currentApiUserMessage, guildName, guildId, serverContext),
      });
    }

    return client.chat.completions.create({
      ...options,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "system", content: `현재 응답해야 하는 유저 이름 변수 userName은 "${userName}"입니다. 답변에서 반드시 "${userName}"님이라고 불러주세요.` },
        ...(guildName ? [{ role: "system", content: `현재 대화가 진행되는 서버의 이름은 "${guildName}"입니다.` }] : []),
        ...(guildId ? [{ role: "system", content: `현재 대화가 진행되는 서버의 ID는 "${guildId}"입니다.` }] : []),
        ...(serverContext ? [{ role: "system", content: serverContext }] : []),
        ...historyMessages,
        { role: currentApiUserMessage.role, content: currentApiUserMessage.content },
      ],
    });
  };

  try {
    return await request({ model });
  } catch (error) {
    if (imageUrls.length === 0 && model === DEEPSEEK_CHAT_MODEL) {
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
  guildName,
  guildId,
  serverContext = "",
  logContext = {},
}) {
  logInfo("ai_call", {
    ...logContext,
    task: "chat_stream",
    model: GROQ_CHAT_MODEL,
    imageCount: 0,
    historyMessageCount: historyMessages.length,
  });

  const limitedHistory = historyMessages.slice(-1);

  const groqMessages = [
    { role: "system", content: "당신은 '먼지'라는 이름의 다정한 AI입니다. 한국어로 짧고 친절하게 답변하세요." },
    ...(guildName ? [{ role: "system", content: `서버: ${guildName} (${guildId})` }] : []),
    ...(serverContext ? [{ role: "system", content: serverContext }] : []),
    ...limitedHistory,
    { role: currentApiUserMessage.role, content: String(currentApiUserMessage.content) }
  ];

  return groqClient.chat.completions.create({
    model: GROQ_CHAT_MODEL,
    messages: groqMessages,
    max_completion_tokens: 1024,
    top_p: 0.95,
    stream: true,
  });
}
export async function shouldUseWebSearch({ userPrompt, logContext = {} }) {
  const prompt = userPrompt.trim();
  if (!prompt) return false;

  logInfo("ai_call", {
    ...logContext,
    task: "web_search_classification",
    model: GEMINI_WEB_SEARCH_MODEL,
    promptLength: prompt.length,
  });

  try {
    const client = getClientForModel(GEMINI_WEB_SEARCH_MODEL);
    const completion = await client.chat.completions.create({
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
    model: "qwen/qwen3-32b",
    promptLength: userPrompt.length,
    logRecordCount: records.length,
  });

  const completion = await groqClient.chat.completions.create({
    model: "qwen/qwen3-32b",
    messages: [
      {
        role: "system",
        content: [
          "당신은 관리자에게 Discord 봇 JSON 로그를 요약해 주는 도우미입니다.",
          "한국어로 간결하고 자연스럽게 답변하세요.",
          "STRICT RULE: 반드시 제공된 'records' 데이터에만 기반하여 답변하세요. 데이터에 없는 사건, 시간, 인물에 대해 절대 추측하거나 지어내지 마세요.",
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
    max_completion_tokens: 2048,
  });

  return stripReasoningTags(completion.choices?.[0]?.message?.content ?? "");
}

function createTextChatMessages(userName, historyMessages, currentApiUserMessage, guildName, guildId, serverContext = "") {
  const systemMessages = [
    {
      role: "system",
      content: SYSTEM_PROMPT,
    },
    {
      role: "system",
      content: `현재 사용자의 이름은 "${userName}"입니다. 답변할 때 유저를 이 이름으로 불러주세요.`,
    },
  ];

  if (guildName) {
    systemMessages.push({ role: "system", content: `현재 대화가 진행되는 서버의 이름은 "${guildName}"입니다.` });
  }
  if (guildId) {
    systemMessages.push({ role: "system", content: `현재 대화가 진행되는 서버의 ID는 "${guildId}"입니다.` });
  }
  if (serverContext) {
    systemMessages.push({ role: "system", content: serverContext });
  }

  return [
    ...systemMessages,
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
  const selectedModel = "gptimage";

  logInfo("ai_call", {
    ...logContext,
    task: "image_generation",
    model: selectedModel,
    promptLength: prompt.length,
  });
  const url = `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?model=${encodeURIComponent(selectedModel)}&nologo=true&private=true`;
  let response;
  try {
    response = await fetch(url, {
      headers: {
      }
    });
  } catch (err) {
    logError("pollinations_auth_request_failed", logContext.guildId, err, logContext);
  }

  if (!response || !response.ok) {
    logInfo("pollinations_auth_failed_trying_free_tier", {
      status: response?.status,
      statusText: response?.statusText,
    });

    response = await fetch(url);
  }

  if (!response.ok) {
    throw new Error(`Failed to generate image from pollinations.ai: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const imageBuffer = Buffer.from(arrayBuffer);

  return { imageBuffer };
}

function normalizeIntentResult(content, userPrompt) {
  const parsed = parseJsonObject(content);
  const legacyTool =
    parsed?.type === "image_generation"
      ? "generate_image"
      : parsed?.type === "log_search"
        ? "search_logs"
        : parsed?.type;
  const tool = INTENT_TOOL_NAMES.has(parsed?.tool)
    ? parsed.tool
    : INTENT_TOOL_NAMES.has(legacyTool)
      ? legacyTool
      : "chat";
  const args = parsed?.arguments && typeof parsed.arguments === "object" ? parsed.arguments : {};
  const imagePrompt = tool === "generate_image"
    ? String(args.prompt || parsed?.imagePrompt || userPrompt).trim()
    : "";
  const type =
    tool === "generate_image"
      ? "image_generation"
      : tool === "search_logs"
        ? "log_search"
        : tool;

  return {
    type,
    tool,
    arguments: {
      ...args,
      ...(tool === "generate_image" ? { prompt: imagePrompt || userPrompt.trim() } : {}),
    },
    imagePrompt: type === "image_generation" ? imagePrompt || userPrompt.trim() : "",
    raw: content,
  };
}

export async function matchServerMember({ guildName, targetText, candidates, logContext = {} }) {
  logInfo("ai_call", {
    ...logContext,
    task: "member_matching",
    model: DEEPSEEK_CHAT_MODEL,
    targetText,
    candidateCount: candidates.length,
  });

  const candidateData = candidates.map((member) => ({
    id: member.id,
    username: member.user.username,
    displayName: member.displayName,
    tag: member.user.tag,
  }));

  const completion = await deepseekClient.chat.completions.create({
    model: DEEPSEEK_CHAT_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "system",
        content: [
          "너는 디스코드 서버에서 대상 멤버를 찾는 관리자 보조 도구야.",
          "사용자가 입력한 대상 텍스트(targetText)를 보고, 후보 목록(candidates)에서 가장 적합한 멤버를 선택해.",
          "",
          "【매칭 규칙】",
          "- 완전 일치뿐 아니라 약칭, 별명, 닉네임 줄임말, 발음 유사, 초성 등도 적극 고려해.",
          "- 한국어 닉네임의 경우 첫 단어만 부르거나 특징적인 단어 하나만 말해도 매칭 가능.",
          "- 발음이 비슷하거나, 특징 단어를 포함하면 매칭 가능.",
          "- 후보 중 가장 가능성 높은 멤버 1명만 선택해. 확신할 수 없으면 memberId를 null로 반환해.",
          "",
          "항상 JSON만 출력해야 해. 마크다운, 코드블록, 추가 설명은 쓰지 마.",
          '출력 형식: {"memberId":"123456789012345678"} 또는 {"memberId":null}',
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
  return parsed && typeof parsed.memberId === "string" ? { memberId: parsed.memberId } : { memberId: null };
}

function parseJsonObject(content) {
  try {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    return JSON.parse(content.substring(start, end + 1));
    } catch {
      return null;
  }
}

export function stripReasoningTags(content) {
  let result = String(content);

  while (true) {
    const lowerResult = result.toLowerCase();
    const start = lowerResult.indexOf("<think>");

    const end = lowerResult.indexOf("</think>", start + "<think>".length);
    if (end < 0) {
      result = result.slice(0, start);
      break;
    }

    result = result.slice(0, start) + result.slice(end + "</think>".length);
  }

  return result.trim();
}

export async function fetchChannelContext(message, limit = HISTORY_BATCH_SIZE) {
  try {

    const messages = await message.channel.messages.fetch({
      limit: limit,
      before: message.id,
    });

    return Array.from(messages.values())

      .reverse()
      .filter((msg) => {

        if (msg.system || (!msg.content && msg.attachments.size === 0)) return false;
        return true;
      })
      .map((msg) => {
        const isBot = msg.author.id === message.client.user.id;
        const authorName = msg.member?.displayName ?? msg.author.username;

        return {
          role: isBot ? "assistant" : "user",

          content: isBot ? msg.content : `[${authorName}]: ${msg.content || "(이미지 또는 첨부파일)"}`,
        };
      });
  } catch (error) {
    logError("fetch_channel_context_failed", message.guildId, error, {
      channelId: message.channelId,
      userId: message.author.id,
    });
    return [];
  }
}
