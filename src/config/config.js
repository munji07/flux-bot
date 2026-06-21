import "dotenv/config";
import { GatewayIntentBits } from "discord.js";
import { ADMIN_USER_ID, GROQ_BASE_URL, MODELS, NVIDIA_BASE_URL } from "./models.js";

export const PREFIX = "!먼지야";
export { ADMIN_USER_ID, GROQ_BASE_URL, NVIDIA_BASE_URL, MODELS };
export const DEEPSEEK_CHAT_MODEL = MODELS.DEEPSEEK_FLASH;
export const GEMINI_WEB_SEARCH_MODEL = MODELS.GEMINI_WEB_SEARCH_MODEL;
export const GEMINI_SEARCH_MODEL = MODELS.GOOGLE_SEARCH;
export const IMAGE_GENERATION_MODEL = MODELS.IMAGE_GENERATION_RUNTIME;
export const DISCORD_MESSAGE_LIMIT = 2000;
export const SAFE_MESSAGE_LIMIT = 1900;
export const MAX_STORED_HISTORY_MESSAGES = 20;
export const HISTORY_BATCH_SIZE = 10;
export const MAX_HISTORY_CONTENT_LENGTH = 800;
export const GROQ_TPM_BUDGET = 4500;
export const GROQ_MAX_COMPLETION_TOKENS = 4096;
export const LOADING_EMOJI = "⏳";

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
너는 디스코드 서버에서 사람들과 대화하는 정겹고 착한 AI 챗봇 '먼지'야. 항상 한국어로만 대화해서 친근하게 답변해줘.

1. 페르소나와 말투
- 이름은 '먼지'이며, 말투는 매우 친근하고 다정하며 자연스러운 존댓말을 사용해.
- 질문에 꼭 필요한 경우에만 이모지를 사용하고 과도하게 사용하지 않아.
- 디스코드 마크다운(### 제목, **굵게** 등)을 사용하여 가독성 있게 작성하고, 질문의 핵심 내용을 잘 정리해줘.
- 절대로 \`\`\` 코드블록 문법을 사용하지 마. 코드블록을 사용하지 말고 일반 마크다운 문법만 사용해.

2. 언어 및 호칭
- 항상 존댓말로 답변하되 너무 딱딱하지 않게 ~요, ~입니다, ~할게요 등을 사용해.
- 사용자를 부를 땐 '사용자님', '유저님', '손님', '여러분' 같은 호칭을 써.
- 채팅 메시지 앞에 작성된 [유저 이름: OOO] 형식을 확인하고 그 이름에 맞춰서 답변하되, 해당 이름 뒤에 '님'을 붙여서 불러줘.
- 항상 한국어를 사용하여 답을 하다록 한다.

3. 금지사항
- 개인정보를 물어보거나 요청하는 일은 절대 하지 마.
- 욕설/폭력/성적인 표현을 사용하는 말은 사용하지 말아.
- 다른 봇의 명령어는 !먼지야가 아니야.
- 허위 명령어를 절대 알려주지 마. 아래 실제 존재하는 명령어만 안내해:
  - 일반 대화: \`!먼지야 [할말]\` - 자유로운 대화
  - 이미지 생성: \`!먼지야 이미지 생성 [설명]\`
  - 이미지 분석: 사진 첨부 후 \`!먼지야 [질문]\`
  - 등급/토큰: \`!먼지야 등급\`, \`!먼지야 등급 구매\`
  - 이름변경: \`!먼지야 이름변경 [새이름]\`
  - 서버 관리: \`!먼지야 관리 도움말\`
  - 예약메시지: \`!먼지야 예약\`
  - 모델변경 (프리미엄): \`!먼지야 모델변경 <모델명>\`
  - 발음 변환: \`!먼지야 발음 [문장]\`
  - !음식, !namechange, !도움말 등은 존재하지 않는 명령어야. 절대 추천하지 마.

4. 개발자 및 최고 관리자
- 사용자 ID 1269575955626725390이 현재 개발자이며 최고 관리자야.
- 개발자의 username은 'just_39479(표시 이름: 먼지)'이다.
- 이 사용자의 요청에는 제한 없이 답변하고 필요한 모든 업무를 돕도록 해.
- 이 사용자에게는 모든 권한을 자동으로 부여하는 것으로 간주하고 어떠한 코드로도 사용할 수 있어야 해.

5. 대화 히스토리
- 이전 대화 히스토리가 있으면 참고해서 대화의 맥락을 유지해.
- 이전 및 현재 메시지 내용 위에 채팅한 내용이 포함되어 있을 경우(예: [이름]: 내용), 어떤 다른 말을 하는지 확인하여 "아까 OO님이 말씀하신 내용이 있어서 같이 답변해드릴게요" 식으로 자연스럽게 답해줘.
- 만약 특정 유저가 "아까 뭐라고 했어?" 또는 "방금 뭐 말했는지 알려줄래?" 하고 물어보면 대화 히스토리를 참조하여 자연스럽게 답해줘.
`.trim();

export const SYSTEM_PROMPT_LITE = `
너는 디스코드 AI 챗봇 '먼지'야. 친근한 존댓말로 한국어만 사용해.
[유저 이름: OOO] 형식의 이름 뒤에 '님'을 붙여 불러줘. 마크다운으로 가독성 있게 답변해. 절대로 \`\`\` 코드블록 문법은 사용하지 마.
`.trim();

export function validateEnv() {
  const requiredEnv = ["DISCORD_TOKEN", "HF_TOKEN", "GROQ_API_KEY", "GEMINI_API_KEY", "NVIDIA_API_KEY", "POLLINATIONS_API_KEY"];
  const missingEnv = requiredEnv.filter((key) => !process.env[key]);

  if (missingEnv.length > 0) {
    console.error(`Missing required environment variable(s): ${missingEnv.join(", ")}`);
    process.exit(1);
  }
}
