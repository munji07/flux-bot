import { REST, Routes, SlashCommandBuilder } from "discord.js";
import "dotenv/config";

if (!process.env.DISCORD_TOKEN) {
  console.error("Missing required environment variable: DISCORD_TOKEN");
  process.exit(1);
}
if (!process.env.DISCORD_CLIENT_ID) {
  console.error("Missing required environment variable: DISCORD_CLIENT_ID");
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName("돈")
    .setDescription("자신의 잔액을 조회합니다."),
  new SlashCommandBuilder()
    .setName("상황")
    .setDescription("현재 잔액과 웹 채굴/농사/레이드 가능 상태를 조회합니다."),
  new SlashCommandBuilder()
    .setName("룰렛")
    .setDescription("룰렛을 돌려 도박을 즐깁니다. 숫자 맞추면 x36!")
    .addIntegerOption(option =>
      option.setName("배팅금")
        .setDescription("배팅할 코인 수량 (최소 10)")
        .setRequired(true)
        .setMinValue(10)
        .setMaxValue(50000))
    .addStringOption(option =>
      option.setName("종류")
        .setDescription("배팅 종류")
        .setRequired(true)
        .addChoices(
          { name: "🎯 숫자 (x36)", value: "number" },
          { name: "🔴 색상 (x2)", value: "red_black" },
          { name: "🔢 홀짝 (x2)", value: "odd_even" },
          { name: "📊 하이로우 (x2)", value: "high_low" },
          { name: "📐 더즌 (x3)", value: "dozen" },
        ))
    .addStringOption(option =>
      option.setName("선택")
        .setDescription("숫자(0-36) / 빨강/검정 / 홀/짝 / low/high / 1st/2nd/3rd")
        .setRequired(true)),
  new SlashCommandBuilder()
    .setName("송금")
    .setDescription("다른 유저에게 코인을 송금합니다.")
    .addUserOption(option =>
      option.setName("대상")
        .setDescription("송금할 대상 유저")
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName("금액")
        .setDescription("송금할 코인 수량")
        .setRequired(true)
        .setMinValue(1)),
  new SlashCommandBuilder()
    .setName("일출")
    .setDescription("일일 출석 보상을 수령합니다. (+1000 코인)"),
  new SlashCommandBuilder()
    .setName("슬롯머신")
    .setDescription("슬롯머신을 돌립니다! (100코인)"),
  new SlashCommandBuilder()
    .setName("주사위")
    .setDescription("봇과 주사위 대결을 합니다.")
    .addIntegerOption(option =>
      option.setName("배팅금")
        .setDescription("배팅할 코인 수량")
        .setRequired(true)
        .setMinValue(10)
        .setMaxValue(10000)),
  new SlashCommandBuilder()
    .setName("동전")
    .setDescription("앞면/뒷면을 맞추는 동전 던기기 게임입니다.")
    .addStringOption(option =>
      option.setName("선택")
        .setDescription("앞면 또는 뒷면을 선택하세요")
        .setRequired(true)
        .addChoices(
          { name: "앞면 🟡", value: "front" },
          { name: "뒷면 ⚪", value: "back" },
        ))
    .addIntegerOption(option =>
      option.setName("배팅금")
        .setDescription("배팅할 코인 수량")
        .setRequired(true)
        .setMinValue(10)
        .setMaxValue(10000)),
  new SlashCommandBuilder()
    .setName("낚시")
    .setDescription("낚시를 합니다! 다양한 물고기를 잡아보세요."),
  new SlashCommandBuilder()
    .setName("채굴")
    .setDescription("채굴은 웹사이트 전용입니다. 잔액을 조회하세요."),
  new SlashCommandBuilder()
    .setName("농사")
    .setDescription("농사는 웹사이트 전용입니다. 잔액을 조회하세요."),
  new SlashCommandBuilder()
    .setName("인벤토리")
    .setDescription("보유 중인 아이템 목록을 확인합니다."),
  new SlashCommandBuilder()
    .setName("상점")
    .setDescription("FLUX 잡화상점에서 아이템을 구매합니다.")
    .addStringOption(option =>
      option.setName("아이템")
        .setDescription("구매할 아이템 (비우면 상점 목록 표시)")
        .setRequired(false)),
  new SlashCommandBuilder()
    .setName("판매")
    .setDescription("인벤토리의 아이템을 판매합니다.")
    .addStringOption(option =>
      option.setName("대상")
        .setDescription("판매할 아이템 이름 또는 '전체'")
        .setRequired(false)),
  new SlashCommandBuilder()
    .setName("랭킹")
    .setDescription("서버 코인 랭킹 TOP 10을 확인합니다."),
  new SlashCommandBuilder()
    .setName("업적")
    .setDescription("획득한 업적 목록을 확인합니다."),
  new SlashCommandBuilder()
    .setName("퀘스트")
    .setDescription("일일 퀘스트 현황을 확인하고 보상을 수령합니다."),
  new SlashCommandBuilder()
    .setName("레이드설정")
    .setDescription("보스 레이드 출현 알림을 받을 채널을 지정합니다.")
    .addChannelOption(option =>
      option.setName("채널")
        .setDescription("알림을 보낼 채널을 선택하세요")
        .setRequired(true)),
  new SlashCommandBuilder()
    .setName("레이드_활성화")
    .setDescription("레이드를 활성화하고 공지 채널을 지정합니다.")
    .addChannelOption(option =>
      option.setName("채널")
        .setDescription("매일 22시 레이드 공지를 보낼 채널을 선택하세요")
        .setRequired(true))
    .addStringOption(option =>
      option.setName("역할이름")
        .setDescription("레이드 참여자에게 부여할 역할 이름 (기본: 레이드 참여자)")
        .setRequired(false)
        .setMaxLength(100)),
  new SlashCommandBuilder()
    .setName("레이드_비활성화")
    .setDescription("이 서버의 레이드를 비활성화합니다."),
  new SlashCommandBuilder()
    .setName("레이드_상태")
    .setDescription("현재 서버의 레이드 설정 상태를 확인합니다."),
  new SlashCommandBuilder()
    .setName("레이드_테스트")
    .setDescription("[개발자 전용] 테스트 레이드 보스를 소환합니다.")
    .addIntegerOption(option =>
      option.setName("hp")
        .setDescription("보스 HP (기본: 10000)")
        .setRequired(false))
    .addStringOption(option =>
      option.setName("이름")
        .setDescription("보스 이름 (기본: 테스트 보스)")
        .setRequired(false)),
  new SlashCommandBuilder()
    .setName("레이드_참여")
    .setDescription("레이드 참여 역할을 받고 레이드 알림 멘션 대상이 됩니다."),
  new SlashCommandBuilder()
    .setName("농장알림")
    .setDescription("작물 수확 알림을 관리합니다. (Premium 전용)")
    .addSubcommand(sub => sub
      .setName("추가")
      .setDescription("알림을 받을 작물을 추가합니다. (예: 밀, 당근 등)")
      .addStringOption(opt => opt
        .setName("작물")
        .setDescription("작물 이름 (예: 밀, 당근, 토마토...)")
        .setRequired(true)))
    .addSubcommand(sub => sub
      .setName("제거")
      .setDescription("알림을 제거할 작물을 선택합니다.")
      .addStringOption(opt => opt
        .setName("작물")
        .setDescription("작물 이름")
        .setRequired(true)))
    .addSubcommand(sub => sub
      .setName("목록")
      .setDescription("현재 알림 설정된 작물 목록을 확인합니다."))
    .addSubcommand(sub => sub
      .setName("전체활성화")
      .setDescription("모든 작물에 대해 수확 알림을 켭니다."))
    .addSubcommand(sub => sub
      .setName("전체비활성화")
      .setDescription("모든 작물에 대해 수확 알림을 끕니다.")),
].map((command) => command.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log("Started refreshing application (/) commands.");

    const clientId = process.env.DISCORD_CLIENT_ID;

    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log("Successfully reloaded application (/) commands.");
  } catch (error) {
    console.error("Error deployment of slash commands:", error);
  }
})();
