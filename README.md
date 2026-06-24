# 먼지 (DUST) 디스코드 AI 챗봇

`discord.js` v14 기반 다목적 AI 챗봇. Groq/NVIDIA/Gemini 멀티 모델 지원, 서버 관리, 등급 시스템, 이미지 생성/판독, 영상 분석, 예약 메시지, 구글 검색 등을 제공.

---

## 환경 변수

`.env` 파일을 프로젝트 루트에 생성:

```env
DISCORD_TOKEN=your_token
HF_TOKEN=your_hf_token
GROQ_API_KEY=your_groq_key
NVIDIA_API_KEY=your_nvidia_key
GEMINI_API_KEY=your_gemini_key
POLLINATIONS_API_KEY=your_pollinations_key
```

## 설치 및 실행

```bash
npm install
npm start
```

`npm start`는 `src/index.js`의 `ShardingManager`를 실행합니다.

---

## 사용법

모든 명령은 `!먼지야` 접두어로 시작합니다.

### 일반 대화

```
!먼지야 오늘 저녁 메뉴 추천해줘
!먼지야 파이썬 리스트 정렬 방법 알려줘
```

- 기본 모델: `qwen/qwen3-32b` (Groq)
- Premium 사용자는 모델 변경 가능 (DeepSeek Flash/Pro, Llama 3.3)

### 이미지 생성

```
!먼지야 이미지 생성 노을 지는 바닷가 고양이
```

- 모델: Pollinations.ai (`gptimage` / `flux`)

### 이미지 판독

이미지 첨부 후 `!먼지야 [질문]`

- 모델: `meta/llama-4-maverick-17b-128e-instruct`

### 영상 분석

영상 파일 첨부 후 `!먼지야 [질문]`

- 모델: `nvidia/nemotron-nano-12b-v2-vl`

### 구글 실시간 검색

```
!먼지야 오늘 날씨 어때?
!먼지야 최신 뉴스 알려줘
```

- 모델: `gemini-2.5-flash`

### 등급/멤버십

```
!먼지야 등급            # 내 등급 조회
!먼지야 등급 구매        # 구매 안내
```

| 등급 | 가격/30일 | AI 호출 | 이미지 생성 | 이미지 판독 | 영상 분석 |
|------|-----------|---------|------------|------------|----------|
| Free | 무료 | 10회 | 3회 | 5회 | 0회 |
| Basic | 3,000원 | 30회 | 6회 | 10회 | 0회 |
| Premium | 5,000원 | 무제한 | 15회 | 30회 | 3회 |

서버 전용 Platinum (4,000원/30일): 예약 메시지, 서버/채널 분석

### 서버 관리

```
!먼지야 청소 20                 # 메시지 20개 삭제
!먼지야 타임아웃 @유저 10m     # 타임아웃
!먼지야 추방 @유저              # 추방 (위험 작업 확인 필요)
!먼지야 차단 @유저              # 차단 (위험 작업 확인 필요)
!먼지야 역할부여 @유저 @역할    # 역할 부여
!먼지야 감사로그 5              # 감사 로그 조회
!먼지야 관리 도움말              # 전체 명령어 목록
```

위험한 작업(추방, 차단, 역할 변경, 보안 수준 변경 등)은 30초 내 2차 확인(`!먼지야 확인` / `!먼지야 취소`) 필요.

### 예약 메시지

```
!먼지야 10분 뒤에 회의 시작한다고 알려줘
!먼지야 예약                    # 예약 목록
```

### 발음 변환

```
!먼지야 발음 私は学生です
```

### 이름 변경

```
!먼지야 이름변경 새로운이름
```

---

## AI 모델 체계

| 목적 | 모델 | 제공자 |
|------|------|--------|
| 의도 분류 | `meta/llama-3.1-8b-instruct` | NVIDIA |
| 일반 대화 | `qwen/qwen3-32b` | Groq |
| 이미지 포함 대화 | `meta/llama-4-maverick-17b-128e-instruct` | NVIDIA |
| 폴백 대화 | `deepseek-ai/deepseek-v4-flash` | NVIDIA |
| Premium 전용 | `deepseek-ai/deepseek-v4-pro`, `meta/llama-3.3-70b-instruct` | NVIDIA |
| 영상 분석 | `nvidia/nemotron-nano-12b-v2-vl` | NVIDIA |
| 이미지 생성 | `gptimage` / `flux` | Pollinations.ai |
| 실시간 검색 | `gemini-2.5-flash` | Google |
| 로그 요약 | `qwen/qwen3-32b` | Groq |
| 멤버/채널/역할 매칭 | `meta/llama-3.1-8b-instruct` | NVIDIA |

---

## 프로젝트 구조

```
src/
├── index.js                    # ShardingManager 진입점
├── bot.js                      # Discord 클라이언트 + 이벤트 바인딩
├── logger.js                   # 로깅 (콘솔 + JSON 파일)
├── errors.js                   # UserFacingError
│
├── config/
│   ├── config.js               # 상수, SYSTEM_PROMPT, env 검증
│   └── models.js               # 모델 ID, API URL, 관리자 ID
│
├── handlers/
│   ├── messageCreate.js        # 메인 메시지 라우터 (831줄)
│   ├── interactionCreate.js    # 버튼/모달 상호작용 처리
│   ├── imageGeneration.js      # 이미지 생성 요청
│   ├── googleSearch.js         # Gemini 실시간 검색
│   └── video.js                # 영상 분석
│
├── commands/
│   ├── management.js           # 서버 관리 명령어 (1,600+줄)
│   ├── subscription.js         # 등급 구매/부여 UI
│   ├── scheduler.js            # 예약 메시지 명령어
│   └── userSettings.js         # 이름 변경
│
├── services/
│   ├── ai.js                   # AI 클라이언트 + 분류 + 채팅 (1,100+줄)
│   ├── database.js             # SQLite 스키마 (8개 테이블)
│   ├── subscription.js         # 등급/사용량/토큰 로직
│   ├── history.js              # 대화 히스토리 저장/조회
│   ├── scheduler.js            # 예약 메시지 서비스
│   ├── userSettings.js         # 유저 설정 서비스
│   ├── botFeatureInfo.js       # 봇 기능 정보
│   ├── developerDiagnostics.js # 개발자 진단
│   └── logSearch.js            # 관리자 로그 검색
│
└── utils/
    ├── message.js              # 메시지 포매팅/청크 전송
    ├── command.js              # 명령어 파싱 유틸
    └── phonetics.js            # 한글 발음 변환
```

---

## 데이터베이스

SQLite (`data/conversations.sqlite`), WAL 모드.

| 테이블 | 용도 |
|--------|------|
| `conversation_messages` | 대화 히스토리 |
| `user_subscriptions` | 유저 등급/만료일 |
| `user_daily_usage` | 일별 사용량 |
| `server_image_tokens` | 서버별 이미지/영상 토큰 |
| `server_subscriptions` | 서버 Platinum 등급 |
| `scheduled_tasks` | 예약 메시지 |
| `user_settings` | 유저별 설정 (이름, 모델) |
| `channel_messages` | 채널 메시지 로깅 |

---

## 권한 체계

- 일반 사용자: Discord 권한 기반
- 개발자/최고 관리자 (`1269575955626725390`): 모든 권한 자동 보유, 2차 확인 없이 위험 작업 실행 가능
- 위험 작업 7종: 추방, 차단, 역할 부여/제거, 권한 변경, 보안 수준 변경, AutoMod, 닉네임 변경

---

## 라이선스

개인 프로젝트
