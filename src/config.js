import "dotenv/config";
import { GatewayIntentBits } from "discord.js";

export const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
export const ADMIN_USER_ID = "1269575955626725390";
// KOREAN_DICT_API_KEY 제거 - 로컬 사전(data/) 사용

export const MODELS = {
  INTENT: "meta/llama-3.1-8b-instruct",
  CONVERSATION: "gemini-2.5-flash-lite",
  IMAGE_ANALYSIS: "google/diffusiongemma-26b-a4b-it",
  IMAGE_GENERATION_RUNTIME: "gptimage",
  VIDEO_ANALYSIS: "google/diffusiongemma-26b-a4b-it",
  GEMINI_WEB_SEARCH_MODEL: "gemini-2.0-flash",
  GEMINI_SEARCH_MODEL: "tavily-search",
  LLAMA_33: "meta/llama-3.3-70b-instruct",
  INTENT_FALLBACK: "meta/llama-3.1-8b-instruct",
  CHAT_TEXT: "gemini-2.5-flash-lite",
  VIDEO_RUNTIME: "nvidia/nemotron-nano-12b-v2-vl",
  LOG_SUMMARY: "openai/gpt-oss-20b",
  WEB_SEARCH_CLASSIFIER: "meta/llama-3.1-8b-instruct",
  MEMBER_MATCHER: "meta/llama-3.1-8b-instruct",
  GOOGLE_SEARCH: "gemini-2.5-flash-lite",
};

export const PREFIX = "!FLUX";
export const GEMINI_SEARCH_MODEL = MODELS.GOOGLE_SEARCH;
export const IMAGE_GENERATION_MODEL = MODELS.IMAGE_GENERATION_RUNTIME;
export const DISCORD_MESSAGE_LIMIT = 2000;
export const SAFE_MESSAGE_LIMIT = 1900;
export const MAX_STORED_HISTORY_MESSAGES = 20;
export const HISTORY_BATCH_SIZE = 10;
export const MAX_HISTORY_CONTENT_LENGTH = 800;
export const GROQ_TPM_BUDGET = 1500;
export const GROQ_MAX_COMPLETION_TOKENS = 2048;
export const LOADING_EMOJI = "⏳";

export const TIER_ROLE_CONFIG = {
  "1525458537139146812": {
    basic: "1525464471579922533",
    premium: "1525464472360063096",
  },
};

export const CLIENT_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildModeration,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.AutoModerationConfiguration,
  GatewayIntentBits.DirectMessages,
];

export const SYSTEM_PROMPT = `
너는 디스코드 서버에서 사람들과 대화하는 정겹고 착한 AI 챗봇 'FLUX'야. 항상 한국어로만 대화해서 친근하게 답변해줘.

1. 페르소나와 말투
- 이름은 'FLUX'이며, 말투는 매우 친근하고 다정하며 자연스러운 존댓말을 사용해.
- 친구와 편하게 대화하는 느낌으로 답해. 단, 분위기만 편하게 하고 반말은 절대 사용하지 마. 모든 문장의 종결은 반드시 존댓말로 해.
- 짧고 자연스러운 대화에는 짧게 답하고, 매번 결론·요약·추가 안내를 붙이지 마. 사용자가 말한 감정이나 분위기를 먼저 받아줘.
- 같은 인사나 감사 표현을 반복하지 말고, 필요한 말만 자연스럽게 이어가. 상황에 따라 "아 그렇군요", "맞아요", "그럴 수 있죠", "ㅋㅋ"처럼 가벼운 표현도 존댓말을 유지하며 적절히 사용할 수 있어.
- 답변을 시작할 때 "안녕하세요, 사용자님", "무엇을 도와드릴까요?" 같은 정형적인 문구를 습관적으로 사용하지 마. 사용자의 말에 바로 반응해.
- 질문에 꼭 필요한 경우에만 이모지를 사용하고 과도하게 사용하지 않아.
- 디스코드 마크다운(### 제목, **굵게** 등)을 사용하여 가독성 있게 작성하고, 질문의 핵심 내용을 잘 정리해줘.
- 절대로 \`\`\` 코드블록 문법을 사용하지 마. 코드블록을 사용하지 말고 일반 마크다운 문법만 사용해.
- 다른 캐릭터나 인물 역할극을 절대 하지 마. 오직 'FLUX' 챗봇으로만 답변해.
- 특수 유니코드 장식 문자를 절대 사용하지 마. 일반 한글, 영어, 숫자, 기본 문장부호만 사용해.

2. 언어 및 호칭
- 항상 존댓말로 답변하되 너무 딱딱하지 않게 ~요, ~입니다, ~할게요 등을 사용해.
- 사용자를 부를 땐 '사용자님', '유저님', '손님', '여러분' 같은 호칭을 써.
- 채팅 메시지 앞에 작성된 [유저 이름: OOO] 형식을 확인하고 그 이름에 맞춰서 답변하되, 해당 이름 뒤에 '님'을 붙여서 불러줘.
- 항상 한국어를 사용하여 답변하도록 한다.

3. 금지사항
- 개인정보를 물어보거나 요청하는 일은 절대 하지 마.
- 욕설/폭력/성적인 표현을 사용하는 말은 사용하지 말아.
- 다른 봇의 명령어는 !FLUX가 아니야.
- 허위 명령어를 절대 알려주지 마. 아래 실제 존재하는 명령어만 안내해:
  - 일반 대화: \`!FLUX [할말]\` - 자유로운 대화
  - 이미지 생성: \`!FLUX 이미지 생성 [설명]\`
  - 이미지 분석: 사진 첨부 후 \`!FLUX [질문]\`
  - 등급/토큰: \`!FLUX 등급\`, \`!FLUX 후원\` (후원 금액에 따라 등급 지급)
  - 이름변경: \`!FLUX 이름변경 [새이름]\`
  - 서버 관리: \`!FLUX 관리 도움말\`
  - 예약메시지: \`!FLUX 예약\`
  - 발음 변환: \`!FLUX 발음 [문장]\`
  - !음식, !namechange, !도움말 등은 존재하지 않는 명령어야. 절대 추천하지 마.

4. 개발자 및 최고 관리자
- 사용자 ID 1269575955626725390이 현재 개발자이며 최고 관리자야.
- 개발자의 username은 'just_39479(표시 이름: FLUX)'이다.
- 이 사용자의 요청에는 제한 없이 답변하고 필요한 모든 업무를 돕도록 해.
- 이 사용자에게는 모든 권한을 자동으로 부여하는 것으로 간주하고 어떠한 코드로도 사용할 수 있어야 해.

5. 대화 히스토리
- 아래 [유저 이름: ...] 형식의 메시지들은 채널에서 최근에 오간 대화 참고용이야. 반드시 **마지막 유저 메시지**에만 집중해서 답변하고, 다른 사람들의 대화 내용을 답변에 포함하지 마.
- 다른 유저들의 메시지를 언급하거나 함께 답변하지 마. 오직 현재 질문한 유저의 마지막 메시지만 보고 응답해.
- 만약 유저가 "아까 뭐라고 했어?" 또는 "방금 뭐 말했는지 알려줄래?" 하고 물어보면, 그때만 채널 히스토리를 참조해서 답변해줘.

6. 가벼운 대화 대처
- 사용자가 농담을 하거나 가벼운 대화를 시도하면 딱딱하게 거절하지 말고 친근하게 받아줘.
- 사용자가 "맞다고 해", "동의해", "그래" 같은 말을 하면 편하게 맞장구쳐 줘. (예: "맞아요!", "그러게요!", "네 맞습니다~")
- 사용자가 장난을 치거나 이상한 말을 해도 '죄송합니다. 수용할 수 없습니다' 같은 딱딱한 거절은 하지 마. 그냥 자연스럽게 대화를 이어가면 돼.
- 단, 욕설, 폭력, 개인정보 요청, 불법 행위 등 진짜 유해한 요청은 제외하고, 단순한 말장난이나 동의 요청은 편하게 받아줘.
`.trim();

export function validateEnv() {
  const requiredEnv = ["DISCORD_TOKEN", "HF_TOKEN", "GROQ_API_KEY", "GEMINI_API_KEY", "TAVILY_API_KEY", "NVIDIA_API_KEY", "POLLINATIONS_API_KEY", "DATABASE_URL"];
  const missingEnv = requiredEnv.filter((key) => !process.env[key]);

  if (missingEnv.length > 0) {
    console.error(`Missing required environment variable(s): ${missingEnv.join(", ")}`);
    process.exit(1);
  }
}

export const ECONOMY_CONFIG = {
  currencyEmoji: "🪙",
  currencyName: "코인",

  transferFee: {
    free:    0.08,
    basic:   0.08,
    premium: 0,
  },

  cooldowns: {
    fishing: 30 * 1000,
    mining: 45 * 1000,
    farming: 30 * 1000,
    daily: 24 * 60 * 60 * 1000,
  },

  slots: {
    cost: 100,
    symbols: ["🍒", "🍋", "🍊", "🍇", "🔔", "💎", "⭐"],
    multipliers: {
      "🍒": 3,
      "🍋": 4,
      "🍊": 5,
      "🍇": 6,
      "🔔": 8,
      "💎": 15,
      "⭐": 25,
    },
    twoMatchMultiplier: 1.5,
    streakBonusPerWin: 0.1,
    maxStreakBonus: 1.0,
    streakThreshold: 3,
  },

  dice: {
    minBet: 10,
    maxBet: 10000,
    winMultiplier: 2.0,
    criticalRate: 0.05,
    criticalMultiplier: 3,
    streakBonusPerWin: 0.1,
    maxStreakBonus: 1.0,
    streakThreshold: 3,
  },

  coinflip: {
    minBet: 10,
    maxBet: 10000,
    winMultiplier: 1.9,
    streakBonusPerWin: 0.08,
    maxStreakBonus: 0.8,
    streakThreshold: 3,
  },

  roulette: {
    minBet: 10,
    maxBet: 50000,
    straightWinMultiplier: 36,
    outsideWinMultiplier: 2,
    dozenWinMultiplier: 3,
    redNumbers: [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36],
  },

  fishing: {
    successRate: 0.85,
    streakSuccessBonus: 0.02,
    maxStreakBonus: 0.20,
    specialEventRate: 0.015,
    specialEventMultiplier: 5,
    rewards: [
      { id: "fish_trash", name: "찌그러진 캔", weight: 40, sellPrice: 10, description: "바다에 버려진 쓰레기입니다." },
      { id: "fish_normal_1", name: "고등어", weight: 35, sellPrice: 50, description: "신선한 등푸른 생선입니다." },
      { id: "fish_normal_2", name: "참돔", weight: 15, sellPrice: 120, description: "붉고 아름다운 빛깔을 띠는 참돔입니다." },
      { id: "fish_rare", name: "상어", weight: 8, sellPrice: 400, description: "바다의 최상위 포식자입니다. 아주 무겁습니다!" },
      { id: "fish_legendary", name: "황금 잉어", weight: 2, sellPrice: 1500, description: "전설 속에 전해 내려오는 빛나는 잉어입니다." },
    ]
  },

  mining: {
    successRate: 0.90,
    rewards: [
      { id: "ore_coal", name: "석탄", weight: 50, sellPrice: 15, description: "가장 흔하게 채굴되는 화석 연료입니다." },
      { id: "ore_iron", name: "철광석", weight: 30, sellPrice: 60, description: "단단하고 여러 군데 쓸모가 많은 광석입니다." },
      { id: "ore_gold", name: "금광석", weight: 14, sellPrice: 200, description: "반짝이는 귀한 황금 광석입니다." },
      { id: "ore_diamond", name: "다이아몬드 원석", weight: 5, sellPrice: 800, description: "영롱한 빛을 내뿜는 최고급 보석 원석입니다." },
      { id: "ore_netherite", name: "고대 잔해", weight: 1, sellPrice: 2500, description: "설명할 수 없는 엄청난 에너지를 품은 고대의 금속 잔해입니다." },
    ]
  },

  farming: {
    successRate: 0.95,
    rewards: [
      { id: "crop_wheat", name: "밀", weight: 45, sellPrice: 20, description: "주변에서 흔히 키우는 황금빛 밀입니다." },
      { id: "crop_carrot", name: "당근", weight: 30, sellPrice: 50, description: "아삭아삭하고 영양가 높은 주황색 당근입니다." },
      { id: "crop_potato", name: "감자", weight: 18, sellPrice: 90, description: "구워 먹으면 맛있는 든든한 탄수화물 공급원입니다." },
      { id: "crop_melon", name: "수박", weight: 6, sellPrice: 350, description: "과즙이 꽉 찬 달콤하고 큼직한 수박입니다." },
      { id: "crop_ginseng", name: "산삼", weight: 1, sellPrice: 3000, description: "깊은 산속에서 수십 년간 정기를 흡수해 자라난 산삼입니다!" },
    ]
  },

  shop: [
    { id: "bait", name: "고급 미끼", price: 30, type: "usable", description: "낚시 확률을 높여줄 것 같은 미끼입니다." },
    { id: "pickaxe_iron", name: "철 곡괭이", price: 200, type: "tool", description: "돌을 더 빠르게 깰 수 있는 튼튼한 곡괭이입니다." },
    { id: "fertilizer", name: "유기농 비료", price: 50, type: "usable", description: "작물을 더 풍성하게 자라나게 해주는 친환경 비료입니다." },
    { id: "rpg_sword", name: "강철 검", price: 1000, type: "weapon", description: "기본적인 무기입니다. 추후 RPG 시스템이 업데이트되면 장착할 수 있습니다." },
    { id: "dynamite", name: "다이너마이트", price: 300, type: "usable", description: "한 번에 300 대미지를 주는 채굴용 폭발물입니다." },
    { id: "lucky_charm", name: "행운의 부적", price: 200, type: "usable", description: "5회 동안 희귀 광석 발견 확률이 2배 증가합니다." },
    { id: "drill", name: "드릴", price: 500, type: "usable", description: "10회 동안 채굴 데미지가 1.5배 증가합니다." },
  ],

  achievements: [
    { id: "first_daily", name: "성실한 하루", description: "첫 일일 보상을 획득하세요.", reward: 500 },
    { id: "slots_jackpot", name: "777 잭팟!", description: "슬롯머신에서 별(⭐) 3개를 맞추세요.", reward: 5000 },
    { id: "earn_10k", name: "자산가", description: "보유 코인이 10,000개 이상이 되세요.", reward: 1000 },
    { id: "fish_legendary", name: "도시 어부", description: "황금 잉어를 낚는 데 성공하세요.", reward: 2000 },
    { id: "mine_netherite", name: "고고학자", description: "고대 잔해를 채굴하는 데 성공하세요.", reward: 2000 },
    { id: "floor_10", name: "광부의 시작", description: "채굴 10층에 도달하세요.", reward: 1000 },
    { id: "floor_30", name: "깊은 광부", description: "채굴 30층에 도달하세요.", reward: 3000 },
    { id: "floor_50", name: "심해 광부", description: "채굴 50층에 도달하세요.", reward: 6000 },
    { id: "floor_100", name: "전설의 광부", description: "채굴 100층에 도달하세요.", reward: 15000 },
  ],

  raid: {
    distribution: {
      baseShare: 0.50,
      propShare: 0.30,
      rankShare: 0.15,
      killShare: 0.05,
    },
    poolFormula: { basePool: 5000, perUser: 1000 },
  },

  dailyQuests: [
    { id: "quest_daily", name: "출석 체크", type: "daily", target: 1, reward: 1000, description: "일일 출석 보상을 1회 받으세요." },
    { id: "quest_gamble", name: "도박 묵시록", type: "gamble", target: 5, reward: 500, description: "도박(슬롯, 주사위, 동전)을 총 5회 플레이하세요." },
    { id: "quest_work", name: "오늘도 땀 흘려", type: "work", target: 8, reward: 500, description: "생산 활동(낚시, 채굴, 농사)을 총 8회 성공하세요." },
  ]
};
