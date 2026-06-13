import { groqClient, stripReasoningTags } from "./ai.js";

const MAX_DISCORD_EDIT_CHARS = 1900;

const BOT_FEATURE_FILES = [
  {
    path: "src/handlers/messageCreate.js",
    area: "메시지 처리",
    features: [
      "봇 호출 접두사로 들어온 디스코드 메시지를 처리합니다.",
      "의도 분류 결과에 따라 일반 대화, 이미지 생성/판독, 웹 검색, 관리 명령, 구독, 로그 조회, 개발자 진단으로 분기합니다.",
      "사용량 제한을 확인하고, 답변을 길이에 맞게 나누어 전송합니다.",
    ],
  },
  {
    path: "src/services/ai.js",
    area: "AI 라우팅과 생성",
    features: [
      "대화 모델, 이미지 판독 모델, 웹 검색 판단, 도구 호출 정의를 관리합니다.",
      "사용자 요청을 어떤 기능으로 처리할지 분류합니다.",
      "로그 요약, 멤버 매칭, 이미지 생성 호출 같은 AI 보조 작업을 제공합니다.",
    ],
  },
  {
    path: "src/handlers/imageGeneration.js",
    area: "이미지 생성",
    features: [
      "이미지 생성 요청을 받아 생성 모델을 호출합니다.",
      "생성된 이미지를 디스코드 첨부 파일로 전송합니다.",
      "이미지 생성 시작/완료/오류를 로그로 남깁니다.",
    ],
  },
  {
    path: "src/handlers/googleSearch.js",
    area: "실시간 웹 검색",
    features: [
      "최신 정보가 필요한 질문을 Google Search Grounding으로 처리합니다.",
      "날씨, 뉴스, 가격, 일정, 최신 버전처럼 변동되는 정보를 답변하는 데 쓰입니다.",
    ],
  },
  {
    path: "src/commands/management.js",
    area: "서버 관리",
    features: [
      "메시지 삭제, 청소, 타임아웃, 추방, 차단, 역할 부여/제거, 권한 변경, 슬로우모드, 오토모드 등 관리 명령을 처리합니다.",
      "위험한 명령은 확인 절차를 거치며, 실행자와 봇의 디스코드 권한을 확인합니다.",
      "최고 관리자 ID는 관리 권한 검사에서 예외로 인정됩니다.",
    ],
  },
  {
    path: "src/commands/subscription.js",
    area: "구독과 사용량",
    features: [
      "무료, Basic, Premium 등급과 일일 사용량 제한을 안내합니다.",
      "등급 구매 안내 DM과 입금 완료 버튼을 제공합니다.",
      "서버 이미지 검토/생성 토큰 구매 안내와 입금 완료 버튼을 제공합니다.",
      "최고 관리자만 사용자 등급을 직접 부여할 수 있습니다.",
    ],
  },
  {
    path: "src/services/subscription.js",
    area: "구독 데이터",
    features: [
      "사용자 구독 등급, 만료일, 일일 사용량을 데이터베이스에서 조회/갱신합니다.",
      "AI 호출, 이미지 생성, 이미지 판독 사용량 제한을 검사합니다.",
      "서버 이미지 검토/생성 토큰을 조회, 추가, 소모합니다.",
    ],
  },
  {
    path: "src/services/logSearch.js",
    area: "로그 조회",
    features: [
      "봇 로그와 오류 로그를 검색해 요약할 기록을 구성합니다.",
      "최고 관리자 ID만 사용할 수 있도록 제한되어 있습니다.",
      "관리 작업, 오류, AI 호출, 이미지 생성 등 주요 기록을 분류합니다.",
    ],
  },
  {
    path: "src/services/developerDiagnostics.js",
    area: "개발자 진단",
    features: [
      "최고 관리자만 최근 로그와 제한된 소스 스니펫을 AI로 진단할 수 있습니다.",
      "비밀 파일, 로그 원본, 데이터베이스, node_modules 같은 민감 경로를 차단합니다.",
    ],
  },
  {
    path: "src/services/history.js",
    area: "대화 히스토리",
    features: [
      "최근 대화 내용을 저장하고 필요할 때 AI 응답에 참고하도록 제공합니다.",
      "채널/사용자 단위로 대화 맥락을 관리합니다.",
    ],
  },
  {
    path: "src/services/database.js",
    area: "데이터베이스 초기화",
    features: [
      "대화 히스토리, 구독 정보, 일일 사용량 테이블을 준비합니다.",
      "SQLite 기반 저장소를 봇 서비스들이 공유하도록 제공합니다.",
    ],
  },
  {
    path: "src/handlers/interactionCreate.js",
    area: "버튼 상호작용",
    features: [
      "구독 구매 입금 완료 버튼과 관리자 승인/반려 버튼을 처리합니다.",
      "서버 이미지 검토/생성 토큰 구매 승인/반려 버튼을 처리합니다.",
      "승인/반려는 최고 관리자만 수행할 수 있습니다.",
    ],
  },
  {
    path: "src/utils/message.js",
    area: "메시지 유틸",
    features: [
      "표시 이름, 첨부 이미지 URL, AI용 사용자 메시지, 긴 답변 분할 전송을 처리합니다.",
    ],
  },
  {
    path: "src/utils/command.js",
    area: "명령어 유틸",
    features: [
      "명령어 정규화, 인자 분리, 디스코드 ID 추출을 제공합니다.",
    ],
  },
  {
    path: "src/utils/phonetics.js",
    area: "발음 변환",
    features: [
      "한글 발음과 영어식 표기 변환 요청을 처리합니다.",
    ],
  },
  {
    path: "src/logger.js",
    area: "로그 기록",
    features: [
      "봇 이벤트와 오류를 JSON 로그 파일에 저장합니다.",
      "사용자, 길드, 채널, 명령 텍스트 같은 진단용 메타데이터를 함께 남깁니다.",
    ],
  },
  {
    path: "src/config.js",
    area: "설정과 시스템 프롬프트",
    features: [
      "봇 접두사, 관리자 ID, 모델명, 메시지 제한, 디스코드 인텐트, 시스템 프롬프트를 정의합니다.",
    ],
  },
  {
    path: "src/bot.js",
    area: "봇 클라이언트",
    features: [
      "디스코드 클라이언트를 만들고 메시지/상호작용 이벤트 핸들러를 연결합니다.",
    ],
  },
  {
    path: "src/index.js",
    area: "앱 시작점",
    features: [
      "환경변수를 검증하고 데이터베이스를 초기화한 뒤 봇을 실행합니다.",
    ],
  },
];

export async function handleBotFeatureInfoRequest(message, intent, loadingMessage) {
  const args = intent?.arguments ?? {};
  const query = String(args.query || args.topic || "").trim() || "봇 기능을 알려줘";

  const answer = await createBotFeatureAnswer({
    query,
    requesterName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
  });

  await loadingMessage.edit(truncate(answer || createFallbackAnswer(), MAX_DISCORD_EDIT_CHARS));
  return true;
}

async function createBotFeatureAnswer({ query, requesterName }) {
  const completion = await groqClient.chat.completions.create({
    model: "qwen/qwen3-32b",
    messages: [
      {
        role: "system",
        content: [
          "You answer user questions about this Discord bot's features.",
          "Use only the provided feature catalog. Do not claim you read the source code directly.",
          "Do not expose secrets, raw source code, environment variables, internal logs, or database contents.",
          "Answer in Korean, friendly and concise.",
          "If the question is broad, summarize the most useful user-facing features first.",
          "Mention relevant file paths only when the user asks how the bot is structured or where a feature lives.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          requesterName,
          query,
          featureCatalog: BOT_FEATURE_FILES,
        }),
      },
    ],
    temperature: 0.2,
    max_completion_tokens: 900,
  });

  return stripReasoningTags(completion.choices?.[0]?.message?.content ?? "");
}

function createFallbackAnswer() {
  return BOT_FEATURE_FILES
    .slice(0, 8)
    .map((file) => `- ${file.area}: ${file.features[0]}`)
    .join("\n");
}

function truncate(value, maxLength) {
  const text = String(value ?? "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}
