import { REST, Routes, SlashCommandBuilder } from "discord.js";
import { validateEnv } from "./config/config.js";

validateEnv();

const commands = [
  new SlashCommandBuilder()
    .setName("돈")
    .setDescription("자신의 잔액을 조회합니다."),
  new SlashCommandBuilder()
    .setName("상황")
    .setDescription("현재 잔액과 웹 채굴/농사/레이드 가능 상태를 조회합니다."),
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
        .setDescription("매일 10시 레이드 공지를 보낼 채널을 선택하세요")
        .setRequired(true)),
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

    let clientId = process.env.DISCORD_CLIENT_ID;
    if (!clientId && process.env.DISCORD_TOKEN) {
      try {
        const tokenParts = process.env.DISCORD_TOKEN.split(".");
        if (tokenParts[0]) {
          const decoded = Buffer.from(tokenParts[0], "base64").toString("utf-8");
          if (/^\d+$/.test(decoded)) {
            clientId = decoded;
          }
        }
      } catch (error) {
        console.error("Token decoding failed:", error);
      }
    }

    if (!clientId) {
      throw new Error("DISCORD_CLIENT_ID or valid DISCORD_TOKEN is required.");
    }

    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log("Successfully reloaded application (/) commands.");
  } catch (error) {
    console.error("Error deployment of slash commands:", error);
  }
})();
