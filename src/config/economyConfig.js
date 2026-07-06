export const ECONOMY_CONFIG = {
  // 기본 통화 기호
  currencyEmoji: "🪙",
  currencyName: "코인",

  // 송금 수수료율 (0.0 ~ 1.0)
  transferFee: {
    free:    0.08, // 8%
    basic:   0.08, // 8%
    premium: 0,    // 0% (무료)
  },

  // 쿨다운 (밀리초)
  cooldowns: {
    fishing: 30 * 1000, // 30초
    mining: 45 * 1000,  // 45초
    farming: 60 * 1000, // 1분
    daily: 24 * 60 * 60 * 1000, // 24시간
  },

  // 미니게임 설정
  slots: {
    cost: 100,
    symbols: ["🍒", "🍋", "🍊", "🍇", "🔔", "💎", "⭐"],
    // 3개 일치 시 배율
    multipliers: {
      "🍒": 3,
      "🍋": 4,
      "🍊": 5,
      "🍇": 6,
      "🔔": 8,
      "💎": 15,
      "⭐": 25,
    },
    twoMatchMultiplier: 1.5, // 2개 일치 시 배율
  },

  dice: {
    minBet: 10,
    maxBet: 10000,
    winMultiplier: 2.0, // 승리 시 배율
  },

  coinflip: {
    minBet: 10,
    maxBet: 10000,
    winMultiplier: 1.9, // 승리 시 배율
  },

  // 컨텐츠 보상 및 확률
  fishing: {
    successRate: 0.85,
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

  // 상점 아이템 리스트 (소비/도구 등 확장 고려)
  shop: [
    { id: "bait", name: "고급 미끼", price: 30, type: "usable", description: "낚시 확률을 높여줄 것 같은 미끼입니다." },
    { id: "pickaxe_iron", name: "철 곡괭이", price: 200, type: "tool", description: "돌을 더 빠르게 깰 수 있는 튼튼한 곡괭이입니다." },
    { id: "fertilizer", name: "유기농 비료", price: 50, type: "usable", description: "작물을 더 풍성하게 자라나게 해주는 친환경 비료입니다." },
    { id: "rpg_sword", name: "강철 검", price: 1000, type: "weapon", description: "기본적인 무기입니다. 추후 RPG 시스템이 업데이트되면 장착할 수 있습니다." },
    { id: "dynamite", name: "다이너마이트", price: 300, type: "usable", description: "한 번에 300 대미지를 주는 채굴용 폭발물입니다." },
    { id: "lucky_charm", name: "행운의 부적", price: 200, type: "usable", description: "5회 동안 희귀 광석 발견 확률이 2배 증가합니다." },
    { id: "drill", name: "드릴", price: 500, type: "usable", description: "10회 동안 채굴 데미지가 1.5배 증가합니다." },
  ],

  // 업적 정의
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

  // 레이드 보상 설정
  raid: {
    // reward_pool 분배 비율 (합계 1.0)
    distribution: {
      baseShare: 0.50,  // 균등 기본 보상
      propShare: 0.30,  // 기여도 비례
      rankShare: 0.15,  // 순위 보너스 (1위 50%, 2위 30%, 3위 20%)
      killShare: 0.05,  // 막타 보너스
    },
    // reward_pool 계산 공식: basePool + members * perUser
    poolFormula: { basePool: 5000, perUser: 1000 },
  },

  // 일일 퀘스트 정의
  dailyQuests: [
    { id: "quest_daily", name: "출석 체크", type: "daily", target: 1, reward: 500, description: "일일 출석 보상을 1회 받으세요." },
    { id: "quest_gamble", name: "도박 묵시록", type: "gamble", target: 5, reward: 300, description: "도박(슬롯, 주사위, 동전)을 총 5회 플레이하세요." },
    { id: "quest_work", name: "오늘도 땀 흘려", type: "work", target: 8, reward: 400, description: "생산 활동(낚시, 채굴, 농사)을 총 8회 성공하세요." },
  ]
};
