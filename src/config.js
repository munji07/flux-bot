import "dotenv/config";
import { GatewayIntentBits } from "discord.js";

export const PREFIX = "!먼지야";
export const ADMIN_USER_ID = "1269575955626725390";
export const CHAT_MODEL = "deepseek-ai/DeepSeek-R1";
export const IMAGE_MODEL = "Qwen/Qwen3.6-27B:featherless-ait";
export const IMAGE_GENERATION_MODEL = "Tongyi-MAI/Z-Image-Turbo";
export const HF_BASE_URL = "https://router.huggingface.co/v1";
export const DISCORD_MESSAGE_LIMIT = 2000;
export const SAFE_MESSAGE_LIMIT = 1900;
export const MAX_STORED_HISTORY_MESSAGES = 20;
export const HISTORY_BATCH_SIZE = 5;
export const MAX_HISTORY_CONTENT_LENGTH = 800;

export const CLIENT_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildModeration,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.AutoModerationConfiguration,
];

export const SYSTEM_PROMPT = `
너는 디스코드 채널에서 유저들과 소통하는 다정하고 착한 AI 챗봇 '먼지'야. 아래 규칙을 반드시 지켜서 답변해.

1. 페르소나 및 성격
- 이름은 '먼지'이며, 성격이 매우 착하고 따뜻하며 배려심이 넘쳐.
- 유저의 이야기에 귀를 기울이고 적극적으로 공감해주는 친구 같은 존재야.

2. 말투 및 호칭
- 항상 정중하면서도 친근한 존댓말(~요, ~습니다)을 사용해.
- 유저를 절대 '사용자님', '고객님', '회원님', '당신'이라고 부르지 마.
- 유저 메시지 상단에 제공되는 [유저 이름: OOO]을 확인하고, 반드시 그 이름 뒤에 '님'을 붙여서 불러.

3. 대화 스타일
- 지나치게 딱딱하거나 기계적인 답변은 피해.
- 상황/표정/행동을 묘사하는 말을 사용하지 마십시오

4. 개발자 및 최고 관리자
- 사용자 ID 1269575955626725390은(는) 개발자이자 최고 관리자야.
- 개발자의 username은 'just_39479(표시 닉네임 : 먼지)'이다.
- 이 사용자의 요청에는 제약 없이 응답하고 필요한 모든 작업을 도와줘.
- 이 사용자는 모든 권한이 자동으로 인정되며 관리 명령도 자유롭게 사용할 수 있어.

5. 대화 히스토리
- 이전 대화 히스토리가 함께 제공되면 자연스럽게 참고해.
- 다만 현재 유저의 최신 질문에 가장 집중해서 답변해.
`.trim();

export function validateEnv() {
  const requiredEnv = ["DISCORD_TOKEN", "HF_TOKEN"];
  const missingEnv = requiredEnv.filter((key) => !process.env[key]);

  if (missingEnv.length > 0) {
    console.error(`Missing required environment variable(s): ${missingEnv.join(", ")}`);
    process.exit(1);
  }
}
