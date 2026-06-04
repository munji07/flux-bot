import { Groq } from "groq-sdk";
import { OpenAI } from "openai";
import {
  HF_CHAT_MODEL,
  GROQ_CHAT_MODEL,
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
  return imageUrls.length > 0 ? IMAGE_MODEL : GROQ_CHAT_MODEL;
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
          "?덈뒗 ?붿뒪肄붾뱶 遊??붿껌 ?쇱슦?곗빞.",
          "?곹솴??臾섏궗?섎뒗 留먯쓣 ?ъ슜?섏? 留먭퀬 ?대え吏瑜??꾩슂?좊븣留??ъ슜?? ?щ엺怨???뷀븷?뚮뒗 議대럠留먯쓣 ?ъ슜??",
          "?ъ슜??硫붿떆吏瑜?蹂닿퀬 ?꾨옒 ??以??섎굹濡쒕쭔 遺꾨쪟??",
          "- chat: ?쇰컲 ??? 吏덈Ц, ?쒕쾭 愿由ш? ?꾨땶 ?띿뒪???붿껌",
          "- image_read: ?ъ슜?먭? ?대?吏, ?ъ쭊, ?ㅽ겕由곗꺑, 泥⑤?臾쇱쓣 ?쎄굅???ㅻ챸?섍굅??遺꾩꽍???щ씪???붿껌",
          "- image_generation: ?ъ슜?먭? ???대?吏, 洹몃┝, ?ъ쭊, ?쇰윭?ㅽ듃, ?꾩씠肄? 諛곕꼫, ?꾨줈???대?吏, ?몃꽕???깆쓣 留뚮뱾???щ씪???붿껌",
          "?먯뿰?ㅻ윭???쒗쁽???섎룄濡??먮떒?? ?덈? ?ㅼ뼱 '紐쏀솚?곸씤 諛곕꼫 ?섎굹 留뚮뱾?댁쨪??, '?꾨줈?꾩뿉 ??洹몃┝ 遺?곹빐'??image_generation?댁빞.",
          "諛섎뱶??JSON留?異쒕젰?? 留덊겕?ㅼ슫, ?ㅻ챸, 肄붾뱶釉붾줉? ?곗? 留?",
          '?뺤떇: {"type":"chat|image_read|image_generation|log_search","imagePrompt":"?대?吏 ?앹꽦???꾨＼?꾪듃 ?먮뒗 鍮?臾몄옄??}',
          
          "Classifier extension: use type log_search when the user asks to search, inspect, summarize, or answer from bot/server logs, command history, errors, AI call logs, or who performed an admin action.",
          "Examples that must be log_search: ?댁젣 ?됰꽕??蹂寃쏀븳 ?щ엺 李얠븘以?/ ?댁젣 AI 濡쒓렇 蹂댁뿬以?/ ?꾧? 李⑤떒?덉뼱?",
          "Allowed JSON type values: chat, image_read, image_generation, log_search.",
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

  if (imageUrls.length === 0) {
    return groqClient.chat.completions.create({
      model,
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
    model,
    messages: [
      {
        role: "system",
        content: SYSTEM_PROMPT,
      },
      {
        role: "system",
        content: `?꾩옱 ?묐떟?댁빞 ?섎뒗 ?좎? ?대쫫 蹂??userName? "${userName}"?낅땲?? ?듬??먯꽌 諛섎뱶??"${userName}???대씪怨?遺덈윭二쇱꽭??`,
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
    const completion = await groqClient.chat.completions.create({
      model: GROQ_CHAT_MODEL,
      messages: [
        {
          role: "system",
          content: [
            "Decide whether answering this Discord message requires current web search.",
            'Return only JSON: {"webSearch":true} or {"webSearch":false}.',
            "Use true for recent news, today's data, prices, schedules, weather, live scores, laws, product availability, or current versions.",
            "Use false for general knowledge, coding help, writing, translation, math, or stable facts.",
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
          "You summarize Discord bot JSON logs for an admin.",
          "Answer in Korean, briefly and naturally.",
          "Use only the provided log records. Do not invent missing details.",
          "Each record has a cls field with normalized actor/action/target/object. Prefer cls over raw text.",
          "Decide which records are relevant to the user's query. Ignore unrelated records.",
          "If no provided records are relevant, say that no matching log was found in the searched range.",
          "When the query says '?닿?' or 'me', interpret it as the requester object.",
          "If the target person is visible, include display name/tag/id when available.",
          "If the evidence is only commandText, say it was inferred from the command text.",
          "Include exact local timestamps from the records when useful.",
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
    throw new Error("Groq web search streaming only supports text messages.");
  }

  logInfo("ai_call", {
    ...logContext,
    task: "web_search_stream",
    model: "compound-beta-mini",
    imageCount: 0,
    historyMessageCount: historyMessages.length,
  });

  return groqClient.chat.completions.create({
    model: "compound-beta-mini",
    messages: [
      {
        role: "system",
        content: "Use web search for current facts and include concise source links when useful.",
      },
      ...createTextChatMessages(userName, historyMessages, currentApiUserMessage),
    ],
    citation_options: "enabled",
    search_settings: {
      country: "south korea",
      include_images: false,
    },
    temperature: 0.4,
    max_completion_tokens: 4096,
    stream: true,
  });
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

  // ?붿뒪肄붾뱶 ?몃뱾?ш? ?몄떇?????덈룄濡?Blob??Base64 臾몄옄?대줈 蹂??  const arrayBuffer = await imageBlob.arrayBuffer();
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
          "?덈뒗 ?붿뒪肄붾뱶 ?쒕쾭?먯꽌 ???硫ㅻ쾭瑜?李얜뒗 愿由ъ옄 蹂댁“ ?꾧뎄??",
          "?ъ슜?먭? ?낅젰??????띿뒪?몃? 蹂닿퀬, ?꾨낫 紐⑸줉?먯꽌 媛???곹빀??硫ㅻ쾭瑜??좏깮??",
          "?꾨낫 以묒뿉????留욌뒗 硫ㅻ쾭媛 ?놁쑝硫?memberId瑜?null濡?諛섑솚??",
          "??긽 JSON留?異쒕젰?댁빞 ?? 留덊겕?ㅼ슫, 肄붾뱶釉붾줉, 異붽? ?ㅻ챸? ?곗? 留?",
          "異쒕젰 ?뺤떇: {\"memberId\":\"123456789012345678\"} ?먮뒗 {\"memberId\":null}",
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
