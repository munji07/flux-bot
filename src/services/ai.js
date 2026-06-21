import { Groq } from "groq-sdk";
import { OpenAI } from "openai";
import {
  DEEPSEEK_CHAT_MODEL,
  GEMINI_WEB_SEARCH_MODEL,
  ADMIN_USER_ID,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_LITE,
  GROQ_TPM_BUDGET,
  GROQ_MAX_COMPLETION_TOKENS,
  HISTORY_BATCH_SIZE,
  IMAGE_GENERATION_MODEL,
} from "../config/config.js";
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
        { role: "system", content: SYSTEM_PROMPT },
    { role: "system", content: `현재 유저 이름은 "${userName}"입니다. 답변에서 반드시 "${userName}"님이라고 불러주세요.` },
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
  if (model && model.startsWith("gemini-")) {
    return geminiClient;
  }
  if (isGroqModel(model)) {
    return groqClient;
  }
  // NVIDIA NIM 모델들(DeepSeek, Llama 3.3, Nemotron 등)은 nvidiaClient 사용
  return nvidiaClient;
}

export function isGroqModel(model) {
  return Boolean(model && model.startsWith("qwen/"));
}

export function isGroqRateLimitError(error) {
  if (error?.status === 413) return true;
  const msg = String(error?.message ?? error?.error?.message ?? "");
  return /rate_limit|tokens per minute|\bTPM\b/i.test(msg);
}

function estimateTokens(content) {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  return Math.ceil(text.length / 2.5);
}

function messageContentToString(content) {
  if (typeof content === "string") return content;
  return JSON.stringify(content);
}

function trimHistoryToBudget(historyMessages, maxTokens) {
  const trimmed = [];
  let used = 0;

  for (let i = historyMessages.length - 1; i >= 0; i -= 1) {
    const msg = historyMessages[i];
    const cost = estimateTokens(messageContentToString(msg.content)) + 4;
    if (used + cost > maxTokens) break;
    trimmed.unshift(msg);
    used += cost;
  }

  return trimmed;
}

function buildChatMessages({
  userName,
  guildName,
  guildId,
  serverContext,
  historyMessages,
  currentApiUserMessage,
  useLite,
}) {
  const systemPrompt = useLite
    ? SYSTEM_PROMPT_LITE
    : `${SYSTEM_PROMPT}\nSTRICT RULE: 반드시 오직 한국어로만 답변하십시오. 다른 언어나 알 수 없는 문자를 포함하지 마십시오.`;

  const systemMessages = [
    { role: "system", content: systemPrompt },
    {
      role: "system",
      content: useLite
        ? `유저 이름: "${userName}" (${userName}님으로 불러주세요)`
        : `현재 응답해야 하는 유저 이름은 "${userName}"입니다. 답변에서 반드시 "${userName}"님이라고 불러주세요.`,
    },
  ];

  if (guildName) {
    systemMessages.push({
      role: "system",
      content: useLite
        ? `서버: ${guildName}${guildId ? ` (${guildId})` : ""}`
        : `현재 대화가 진행되는 서버의 이름은 "${guildName}"입니다.`,
    });
  } else if (guildId && !useLite) {
    systemMessages.push({ role: "system", content: `현재 대화가 진행되는 서버의 ID는 "${guildId}"입니다.` });
  } else if (guildId && useLite) {
    systemMessages.push({ role: "system", content: `서버 ID: ${guildId}` });
  }

  if (serverContext) {
    const context = useLite && serverContext.length > 500
      ? `${serverContext.slice(0, 500)}...`
      : serverContext;
    systemMessages.push({ role: "system", content: context });
  }

  let history = historyMessages;
  if (useLite) {
    const systemTokens = systemMessages.reduce((sum, msg) => sum + estimateTokens(msg.content), 0);
    const userTokens = estimateTokens(messageContentToString(currentApiUserMessage.content));
    const historyBudget = GROQ_TPM_BUDGET - systemTokens - userTokens - GROQ_MAX_COMPLETION_TOKENS - 100;
    history = trimHistoryToBudget(historyMessages, Math.max(200, historyBudget));
  }

  return [
    ...systemMessages,
    ...history,
    { role: currentApiUserMessage.role, content: currentApiUserMessage.content },
  ];
}

export function getChatModel(imageUrls) {
  return imageUrls.length > 0 ? "meta/llama-4-maverick-17b-128e-instruct" : "qwen/qwen3-32b";
}

function normalizeChatModel(model) {
  if (!model) return model;

  if (model === "qwen/qwen3-32b" || model === "qwen3" || model === "qwen" || model === "groq/qwen3") {
    return "qwen/qwen3-32b";
  }

  return model;
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
  },
  {
    type: "function",
    function: {
      name: "schedule",
      description: "Schedule a message to be sent later, or manage existing scheduled messages. Use when the user wants to create/list/cancel/reschedule 예약메시지. Also use this when the user asks about '예약된 메시지', '예약한 메시지', '등록된 예약' (they want to see the list). Do NOT use 'chat' for these — always use 'schedule'.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["create", "list", "cancel", "reschedule"],
            description: "\"create\" = make a new reservation, \"list\" = show reserved messages, \"cancel\" = delete a reservation, \"reschedule\" = change time of a reservation.",
          },
          executeAt: {
            type: "string",
            description: "FOR 'create'/'reschedule': The absolute time in KST (Korea Standard Time, UTC+9). Convert relative times to absolute format 'YYYY-MM-DD HH:MM'. e.g. '10분 뒤' → calculate current KST time + 10min, '내일 09:30' → next day 09:30 KST, '2026-06-20 18:30' → '2026-06-20 18:30'. Required for create/reschedule.",
          },
          channel: {
            type: "string",
            description: "Target channel name, mention, or ID. Optional — defaults to current channel.",
          },
          message: {
            type: "string",
            description: "The message content to send (for 'create'). Required for create.",
          },
          id: {
            type: "string",
            description: "Reservation ID number (for 'cancel' or 'reschedule'). e.g. '1', '3'.",
          },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_management",
      description: "Execute a Discord server moderation or management action. Use when the user requests any admin/moderation task in any natural language phrasing.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            enum: [
              "deleteMessage",
              "purgeMessages",
              "setSlowMode",
              "timeoutMember",
              "kickMember",
              "banMember",
              "muteMember",
              "deafenMember",
              "moveMember",
              "disconnectMember",
              "changeNickname",
              "autoMod",
              "auditLog",
              "setVerificationLevel",
              "addRole",
              "removeRole",
              "addRolePermission",
              "removeRolePermission",
              "help",
              "serverAnalysis",
              "channelAnalysis",
            ],
            description: [
              "The management command to execute. Map natural language to the correct enum value:",
              "- deleteMessage  : 메시지 삭제, 지워줘, 삭제해 (specific single message)",
              "- purgeMessages  : 청소, 일괄삭제, 메시지 N개 삭제, 채널 정리, clear N",
              "- setSlowMode    : 저속모드, 슬로우모드, slowmode, 채널 느리게, N초 간격",
              "- timeoutMember  : 타임아웃, 대화금지, 채팅금지, 말 못 하게, timeout @user",
              "- kickMember     : 추방, 킥, 서버에서 내보내, kick @user",
              "- banMember      : 차단, 밴, 영구추방, ban @user, IP차단",
              "- muteMember     : 뮤트, 음소거, 서버뮤트, mute @user",
              "- deafenMember   : 청각차단, 들을 수 없게, deafen @user",
              "- moveMember     : 이동, 음성채널 이동, move @user to channel",
              "- disconnectMember: 연결끊기, 보이스 내보내기, disconnect @user",
              "- changeNickname : 닉네임 변경, 닉변, 이름 바꿔줘 @user newNick",
              "- autoMod        : 오토모드, AutoMod 규칙, 욕설 차단 규칙 추가",
              "- auditLog       : 감사로그, 관리 내역, audit log N개",
              "- setVerificationLevel: 보안수준, 인증단계, verification level",
              "- addRole        : 역할부여, 역할추가, @user에게 @role 줘",
              "- removeRole     : 역할제거, @user @role 빼줘",
              "- addRolePermission  : 권한추가, @role에 권한 줘",
              "- removeRolePermission: 권한제거, @role 권한 빼줘",
               "- help           : 관리 도움말, 도움말, 관리 명령어 알려줘",
              "- serverAnalysis : 서버 분석, 서버 분석 보고서, 서버 활동량, 서버 통계 (Platinum 전용)",
              "- channelAnalysis: 채널 분석, 채널 활동량, 특정 채널 통계, 채널 정보 (Platinum 전용)",
            ].join("\n"),
          },
          args: {
            type: "array",
            items: { type: "string" },
            description: [
              "Arguments for the command extracted from the user message:",
              "- deleteMessage / kickMember / banMember / disconnectMember: [targetUser]",
              "- purgeMessages: [count]  e.g. ['20']",
              "- setSlowMode: [seconds]  e.g. ['5']",
              "- timeoutMember: [targetUser, duration]  e.g. ['@홍길동', '10m']",
              "- changeNickname: [targetUser, newNickname]",
              "- moveMember: [targetUser, channelName]",
              "- muteMember / deafenMember: [targetUser, 'on'|'off']",
              "- addRole / removeRole: [targetUser, roleName]",
              "- addRolePermission / removeRolePermission: [roleName, permissionName]",
              "- setVerificationLevel: [level]  level = none|low|medium|high|highest",
              "- autoMod: ['keyword', ...keywords]",
              "- auditLog: [count]  optional",
              "- serverAnalysis: no arguments needed",
              "- channelAnalysis: [channelNameOrId]  optional, omit for current channel",
            ].join("\n"),
          },
        },
        required: ["command"],
      },
    },
  },
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
  "schedule",
]);

const MANAGEMENT_COMMAND_GUIDE = [
  "run_management command → natural language trigger examples (Korean users speak naturally):",
  "  deleteMessage       : '메시지 삭제해줘', '그 메시지 지워줘'",
  "  purgeMessages       : '청소 20개', '메시지 50개 일괄삭제', '채널 정리해줘', 'clear 30'",
  "  setSlowMode         : '저속모드 5초', '슬로우모드 켜줘', '채널 느리게 해줘', '10초 간격으로 해줘'",
  "  timeoutMember       : '@유저 10분 타임아웃', '대화금지 시켜줘', '채팅 못 하게 해줘', 'timeout @user 30m'",
  "  kickMember          : '@유저 추방해줘', '킥해줘', '서버에서 내보내줘', 'kick @user'",
  "  banMember           : '@유저 차단해줘', '밴해줘', '영구추방', 'ban @user', 'IP차단해줘'",
  "  muteMember          : '@유저 뮤트해줘', '음소거 시켜줘', '말 못 하게 해줘', 'mute @user on'",
  "  deafenMember        : '@유저 청각차단해줘', '들을 수 없게 해줘', 'deafen @user'",
  "  moveMember          : '@유저 일반채널로 이동해줘', '저 방으로 옮겨줘', 'move @user to 채널명'",
  "  disconnectMember    : '@유저 연결 끊어줘', '보이스에서 내보내줘', 'disconnect @user'",
  "  changeNickname      : '@유저 닉네임 바꿔줘', '닉변해줘', '이름 바꿔줘', 'changenickname @user 새닉'",
  "  autoMod             : '욕설 차단 규칙 추가해줘', '오토모드 키워드 설정해줘', 'automod keyword 욕1,욕2'",
  "  auditLog            : '감사로그 5개 보여줘', '최근 관리 내역 알려줘', 'auditlog 10'",
  "  setVerificationLevel: '보안수준 높여줘', '인증단계 변경해줘', 'verification high'",
  "  addRole             : '@유저에게 @역할 줘', '역할 부여해줘', 'addrole @user @role'",
  "  removeRole          : '@유저 @역할 빼줘', '역할 제거해줘', 'removerole @user @role'",
  "  addRolePermission   : '@역할에 메시지 관리 권한 줘', '권한 추가해줘'",
  "  removeRolePermission: '@역할 권한 빼줘', '권한 제거해줘'",
  "  help                : '도움말', '봇 도움말', '명령어 도움말', '관리 도움말', '관리 명령어 뭐 있어?', '뭘 할 수 있어?'",
  "  changeGuildName     : '서버 이름 변경', '서버이름 바꿔줘', 'changeGuildName 새이름'",
  "  changeGuildIcon     : '서버 아이콘 변경', '서버아이콘 등록해줘'",
  "  changeGuildBanner   : '서버 배너 변경', '서버배너 설정해줘'",
  "  changeGuildDescription: '서버 설명 변경', '서버소개 수정해줘'",
  "  setAfkChannel       : 'AFK 채널 설정', '1477917124763844690 채널 AFK', '체널 AFK 모드', '잠수 채널 지정해줘'",
  "  clearAfkChannel     : 'AFK 모드 해제', 'AFK 해제', '잠수 해제', 'AFK 채널 해제'",
  "  setAfkTimeout       : 'AFK 시간 설정', '잠수 시간 설정'",
  "  setSystemChannel    : '시스템 메시지 채널 설정', '웰컴 메시지 채널 설정'",
  "  createChannel       : '채널 생성', '새로운 채팅방 만들어줘', 'createChannel 채널명 [text|voice|category]'",
  "  deleteChannel       : '채널 삭제', '채널 지워줘', 'deleteChannel 채널명/ID'",
  "  createRole          : '역할 생성', '역할 추가해줘', 'createRole 역할명'",
  "  deleteRole          : '역할 삭제', '역할 지워줘', 'deleteRole 역할명/ID'",
  "  unbanMember         : '차단 해제', '밴 풀어줘', 'unbanMember 유저ID'",
  "  untimeoutMember     : '타임아웃 해제', '타임아웃 풀어줘', 'untimeoutMember @user'",
  "  pinMessage          : '메시지 고정', '핀 고정해줘', 'pinMessage 메시지ID'",
  "  unpinMessage        : '메시지 고정 해제', '핀 고정 풀어줘'",
  "  getGuildInfo        : '서버 정보 조회', '서버 어때?', '서버 통계 알려줘'",
  "  getChannelInfo      : '채널 정보 조회', '채널 설정 상태 어때?'",
  "  getMemberInfo       : '멤버 정보 조회', '유저 정보 알려줘'",
  "  serverAnalysis      : '서버 분석', '서버 분석 보고서', '서버 활동량 분석', '서버 통계 알려줘', '서버 리포트', '서버 상태 분석', '서버 정보 분석'",
  "  channelAnalysis     : '채널 분석', '이 채널 분석', '채널 활동량', '채널 통계', '채널 정보 분석', '채널ID 분석', '#채널명 분석', '채널 1464582222009860097 분석', '이 채널 상태 분석'",
].join("\n");

const INTENT_ROUTER_PROMPT = [
  "You are a fast intent classifier for a Discord bot. Return ONLY valid JSON, no markdown, no prose.",
  'Schema: {"tool":"<tool_name>","arguments":{...}}',
  `Tool names: chat | image_read | video_analysis | generate_image | search_logs | google_search | run_management | subscription | bot_feature_info | pronunciation | developer_diagnostics | confirm_management | cancel_management | schedule`,
  "",
  "=== CLASSIFICATION RULES ===",
  "1. Infer intent from MEANING, not exact keywords. Users speak naturally in Korean.",
  "2. If uncertain, default to 'chat'.",
  "3. 'generate_image': strictly for visual art, drawings, pictures. NOT for text/stories/novels/code.",
  `4. 'search_logs': admin history checks only (Owner ID: ${ADMIN_USER_ID}).`,
  "5. 'video_analysis': only when a video file is attached (hasVideoAttachment: true).",
  "6. 'image_read': only when an image file is attached AND the user asks for analysis.",
  "7. 'google_search': when query needs real-time/external info (news, weather, prices, scores, schedules, current events).",
  "8. 'confirm_management': user confirms a pending dangerous action (e.g. '확인', 'ㅇㅇ', 'ok', '응').",
  "9. 'cancel_management': user cancels a pending action (e.g. '취소', 'cancel', '아니', 'ㄴㄴ').",
  "10. 'run_management': ANY server moderation or admin task — set arguments.command to the matching enum value AND arguments.args with extracted targets/params.",
  "11. Creative writing (stories, novels, poems, code writing) must ALWAYS be 'chat'.",
  "12. 'subscription': user wants to buy/upgrade/check a membership tier (등급), buy image/video tokens, or buy/upgrade a Platinum Server license. This is about the BOT's membership system, NOT Discord's own premium. Keywords: 등급, 프리미엄, 프리미엄 구매/사고싶어/살래, Basic, basic, 플래티넘, platinum, 서버 라이선스, 토큰 구매. (e.g. '프리미엄 사고싶어', '프리미엄 살래', 'Basic 사고싶어', '등급 구매', '등급 조회', '나의 등급', '토큰 구매', '이미지 분석 토큰 살래', '플래티넘 서버 구매', '서버 라이선스 살래'). If user mentions '프리미엄' alone without '디스코드' or 'discord', assume they mean the bot's premium. Set arguments.action to 'purchase' (or 'status' for checking) and arguments.type to 'tier' | 'image_generations' | 'image_readings' | 'video_analysis' | 'platinum'.",
  "13. IMPORTANT: 'serverAnalysis' and 'channelAnalysis' are run_management commands (NOT chat). If a user asks to analyze/check a server or channel stats/activity/status, ALWAYS use 'run_management' tool with the appropriate command.",
  "14. CRITICAL: Any user message containing '예약' in the context of bot features (예약메시지, 예약된 메시지, 예약 확인, 등록된 예약, 예약 목록, 예약 리스트, 예약 조회, 예약 취소, 예약 변경) MUST use tool='schedule'. NEVER classify these as 'chat'.",
  "15. 'schedule': user wants to reserve/schedule a message (예약메시지, 예약, 메시지 예약). Set arguments.action accordingly:",
  "    - action='create' when user wants to make a new reservation. Convert the time to executeAt='YYYY-MM-DD HH:MM' KST format. Extract channel and message if present.",
  "    - action='list' when user asks to see/list/check reservations (등록된 예약, 예약 목록, 예약 리스트, 예약 확인, 예약된 메시지, 예약한 메시지, 예약 조회, 저장된 예약).",
  "    - action='cancel' when user wants to cancel/delete a reservation. Extract the reservation id.",
  "    - action='reschedule' when user wants to change a reservation's time. Extract id and convert the new time to executeAt='YYYY-MM-DD HH:MM' KST format.",
  "    IMPORTANT: For executeAt, ALWAYS output absolute KST time in 'YYYY-MM-DD HH:MM' format (Korea Standard Time, UTC+9). Convert relative times yourself. e.g. if user says '10분 뒤' and current time is 11:00, output '2026-06-21 11:10'. For '내일 09:30', output next day's date at 09:30.",
  "    If only partial info is given (e.g. just '예약메시지' with no details), still use action='create' with empty executeAt and message — the handler will ask for missing details.",
  "",
  "",
  "=== run_management COMMAND GUIDE ===",
  MANAGEMENT_COMMAND_GUIDE,
  "",
  "=== run_management ARGUMENT EXTRACTION ===",
  "- Always extract the target user name/mention into args[0] for member-targeting commands.",
  "- timeoutMember  → args: [targetUser, duration]  e.g. ['@홍길동', '10m']",
  "- purgeMessages  → args: [count]                  e.g. ['20']",
  "- setSlowMode    → args: [seconds]                e.g. ['5']",
  "- changeNickname → args: [targetUser, newNickname]",
  "- moveMember     → args: [targetUser, channelName]",
  "- muteMember / deafenMember → args: [targetUser, 'on'|'off']",
  "- addRole / removeRole      → args: [targetUser, roleName]",
  "- addRolePermission / removeRolePermission → args: [roleName, permissionName]",
  "- setVerificationLevel → args: [level]  where level ∈ {none, low, medium, high, highest}",
  "- autoMod  → args: ['keyword', ...keywords]",
  "- auditLog → args: [count]  (optional)",
  "- banMember / kickMember / deleteMessage / disconnectMember → args: [targetUser]",
  "- changeGuildName / changeGuildDescription / createRole / createChannel / deleteRole / deleteChannel / unbanMember / pinMessage / unpinMessage → args: [param]",
  "- setAfkChannel    → args: [channelIdOrName]  e.g. ['1477917124763844690']",
  "- clearAfkChannel  → args: []                 e.g. [] (no arguments needed)",
  "- setAfkTimeout    → args: [seconds]           e.g. ['300']",
  "- setSystemChannel → args: [channelIdOrName]",
  "- serverAnalysis   → args: []  (no arguments needed)",
  "- channelAnalysis  → args: [channelIdOrName]  e.g. ['#일반'], ['1464582222009860097'], or omit for current channel",
].join("\n");

export async function classifyRequestIntent({ userPrompt, hasImageAttachment, hasVideoAttachment, logContext = {} }) {
  logInfo("ai_call", {
    ...logContext,
    task: "Intent Classification",
    model: "meta/llama-3.1-8b-instruct",
    hasImageAttachment,
    hasVideoAttachment,
    promptLength: userPrompt.length,
    });

  const requestClassification = async (modelName) => {
    const client = nvidiaClient; // 항상 nvidiaClient 사용
    const now = new Date();
    const kstTime = now.toLocaleString("en-CA", { timeZone: "Asia/Seoul", hour12: false }).replace(",", "") + ":" + String(now.getSeconds()).padStart(2, "0");
    const completion = await client.chat.completions.create({
      model: modelName,
      temperature: 0.2,
      top_p: 0.7,
      max_tokens: 1024,
      messages: [
      {
        role: "system",
        content: INTENT_ROUTER_PROMPT + `\n\nCurrent KST time: ${kstTime}`,
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
    const content = await requestClassification("meta/llama-3.1-8b-instruct");
    const result = normalizeIntentResult(content, userPrompt);
    
    // 의도 파악 결과를 로그에 기록
    logInfo("intent_classified", {
      ...logContext,
      intent: result.type,
      tool: result.tool,
    });
    
    return result;
  } catch (error) {
    logError("intent_classification_failed", logContext.guildId, error, logContext);
    throw error;
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
  intent = null,
  model: userModel = null,
}) {
  const task = intent || getChatTask(imageUrls);
  const model = normalizeChatModel(userModel) || (imageUrls.length > 0 ? "meta/llama-4-maverick-17b-128e-instruct" : "qwen/qwen3-32b");
  const useLite = isGroqModel(model);

  logInfo("ai_call", {
    ...logContext,
    task,
    model,
    imageCount: imageUrls.length,
    historyMessageCount: historyMessages.length,
    useLitePrompt: useLite,
  });

  const request = ({ requestModel }) => {
    const requestUseLite = isGroqModel(requestModel);
    const options = {
      model: requestModel,
      temperature: 0.4,
      top_p: 0.95,
      max_completion_tokens: requestUseLite ? GROQ_MAX_COMPLETION_TOKENS : 4096,
      stream: false,
    };

    const messages = buildChatMessages({
      userName,
      guildName,
      guildId,
      serverContext,
      historyMessages,
      currentApiUserMessage,
      useLite: requestUseLite,
    });

    const client = getClientForModel(requestModel);
    return client.chat.completions.create({
      ...options,
      messages,
    });
        };

  try {
    return await request({ requestModel: model });
  } catch (error) {
    logError("chat_completion_failed", logContext.guildId, error, {
      ...logContext,
      model,
    });
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
  model: userModel = null,
}) {
  const model = normalizeChatModel(userModel) || "qwen/qwen3-32b";
  const useLite = isGroqModel(model);
  logInfo("ai_call", {
    ...logContext,
    task: "chat_stream",
    model: model,
    imageCount: 0,
    historyMessageCount: historyMessages.length,
    useLitePrompt: useLite,
  });

  const messages = buildChatMessages({
    userName,
    guildName,
    guildId,
    serverContext,
    historyMessages,
    currentApiUserMessage: {
      role: currentApiUserMessage.role,
      content: String(currentApiUserMessage.content),
    },
    useLite,
  });

  const client = getClientForModel(model);
  return client.chat.completions.create({
    model: model,
    messages: messages,
    max_completion_tokens: useLite ? GROQ_MAX_COMPLETION_TOKENS : 4096,
    temperature: 0.4,
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
    model: "meta/llama-3.1-8b-instruct",
    promptLength: prompt.length,
  });

  try {
    const completion = await nvidiaClient.chat.completions.create({
      model: "meta/llama-3.1-8b-instruct",
      messages: [
        {
          role: "system",
          content: [
            "이 디스코드 메시지에 답변하기 위해 실시간 웹 검색이 필요한지 판단하세요.",
            '"반드시 JSON 형식으로만 응답하세요: {"webSearch":true} 또는 {"webSearch":false}.',
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
      max_completion_tokens: 1024,
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
  const model = "qwen/qwen3-32b";
  logInfo("ai_call", {
    ...logContext,
    task: "log_search_summary",
    model: model,
    promptLength: userPrompt.length,
    logRecordCount: records.length,
  });

  const completion = await nvidiaClient.chat.completions.create({
    model: model,
    messages: [
      {
        role: "system",
        content: [
          "당신은 관리자에게 Discord 봇 JSON 로그를 요약해 주는 도우미입니다.",
          "반드시 한국어로만 간결하고 자연스럽게 답변하세요. 다른 언어는 절대 사용하지 마세요.",
          "STRICT RULE: 반드시 제공된 'records' 데이터에만 기반하여 답변하세요. 데이터에 없는 사건, 시간, 인물에 대해 절대 추측하거나 지어내지 마세요.",
          "각 기록에는 actor/action/target/object가 정규화된 cls 필드가 있습니다. 가능하면 원본 텍스트보다 cls 필드를 우선 사용하세요.",
          "사용자 질문과 관련된 기록만 선택하고, 관련 없는 기록은 무시하세요.",
          "제공된 기록 중 관련된 내용이 없다면 검색 범위 내에서 일치하는 로그를 찾지 못했다고 답변하세요.",
          "질문에 '누가', '나', 'me'가 포함되어 있으면 requester 객체를 기준으로 해석하세요.",
          "대상 사용자를 확인할 수 있다면 display name, tag, id를 함께 포함하세요.",
          "근거가 commandText뿐이라면 명령어 텍스트를 바탕으로 추정한 내용임을 명시하세요.",
          "필요한 경우 로그에 기록된 정확한 로컬 시간을 포함하세요"
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
    temperature: 0.2, // 로그 분석은 낮은 온도 유지
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
        Authorization: `Bearer ${process.env.POLLINATIONS_API_KEY}`
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
    model: "meta/llama-3.1-8b-instruct",
    targetText,
    candidateCount: candidates.length,
  });

  const candidateData = candidates.map((member) => ({
    id: member.id,
    username: member.user.username,
    displayName: member.displayName,
    tag: member.user.tag,
  }));

  const completion = await nvidiaClient.chat.completions.create({
    model: "meta/llama-3.1-8b-instruct",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "system",
        content: [
          "너는 디스코드 서버에서 대상 멤버를 찾는 관리자 보조 도구야.",
          "사용자가 입력한 대상 텍스트(targetText)를 보고, 후보 목록(candidates)에서 가장 적합한 멤버를 선택해.",
          "",
          "【매칭 규칙】",
          "- 완전 일치뿐 아니라 약칭, 별명, 닉네임 줄임말, 발음 유사, 초성 등도 고려해.",
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

export async function matchServerChannel({ guildName, targetText, candidates, logContext = {} }) {
  logInfo("ai_call", {
    ...logContext,
    task: "channel_matching",
    model: "meta/llama-3.1-8b-instruct",
    targetText,
    candidateCount: candidates.length,
  });

  const candidateData = candidates.map((channel) => ({
    id: channel.id,
    name: channel.name,
    type: channel.type,
    topic: channel.topic?.slice(0, 200),
  }));

  const completion = await nvidiaClient.chat.completions.create({
    model: "meta/llama-3.1-8b-instruct",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "system",
        content: [
          "너는 디스코드 서버에서 대상 채널을 찾는 관리자 보조 도구야.",
          "사용자가 입력한 대상 텍스트(targetText)를 보고, 후보 목록(candidates)에서 가장 적합한 채널을 선택해.",
          "",
          "【매칭 규칙】",
          "- 완전 일치뿐 아니라 약칭, 줄임말, 발음 유사, 특징 단어 등도 고려해.",
          "- 한국어 채널명의 경우 첫 단어만 부르거나 특징적인 단어 하나만 말해도 매칭 가능.",
          "- 후보 중 가장 가능성 높은 채널 1개만 선택해. 확신할 수 없으면 channelId를 null로 반환해.",
          "",
          "항상 JSON만 출력해야 해. 마크다운, 코드블록, 추가 설명은 쓰지 마.",
          '출력 형식: {"channelId":"123456789012345678"} 또는 {"channelId":null}',
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
  const parsed = parseJsonObject(content);
  return parsed && typeof parsed.channelId === "string" ? { channelId: parsed.channelId } : { channelId: null };
}

export async function matchServerRole({ guildName, targetText, candidates, logContext = {} }) {
  logInfo("ai_call", {
    ...logContext,
    task: "role_matching",
    model: "meta/llama-3.1-8b-instruct",
    targetText,
    candidateCount: candidates.length,
  });

  const candidateData = candidates.map((role) => ({
    id: role.id,
    name: role.name,
    color: role.color,
    memberCount: role.members?.size ?? 0,
  }));

  const completion = await nvidiaClient.chat.completions.create({
    model: "meta/llama-3.1-8b-instruct",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "system",
        content: [
          "너는 디스코드 서버에서 대상 역할을 찾는 관리자 보조 도구야.",
          "사용자가 입력한 대상 텍스트(targetText)를 보고, 후보 목록(candidates)에서 가장 적합한 역할을 선택해.",
          "",
          "【매칭 규칙】",
          "- 완전 일치뿐 아니라 약칭, 줄임말, 발음 유사도 고려해.",
          "- 한국어 역할명의 경우 특징적인 단어로도 매칭 가능.",
          "- 후보 중 가장 가능성 높은 역할 1개만 선택해. 확신할 수 없으면 roleId를 null로 반환해.",
          "",
          "항상 JSON만 출력해야 해. 마크다운, 코드블록, 추가 설명은 쓰지 마.",
          '출력 형식: {"roleId":"123456789012345678"} 또는 {"roleId":null}',
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
  const parsed = parseJsonObject(content);
  return parsed && typeof parsed.roleId === "string" ? { roleId: parsed.roleId } : { roleId: null };
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

export function stripCodeBlocks(content) {
  let result = String(content).trim();

  if (/^```\w*\r?\n/.test(result)) {
    result = result.replace(/^```\w*\r?\n/, "");
  } else if (result.startsWith("```")) {
    result = result.slice(3);
  }

  if (result.endsWith("```")) {
    result = result.slice(0, -3);
  }

  return result.trim();
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

