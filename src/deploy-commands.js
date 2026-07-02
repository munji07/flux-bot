import { REST, Routes, SlashCommandBuilder } from "discord.js";
import { validateEnv } from "./config/config.js";
import { ECONOMY_CONFIG } from "./config/economyConfig.js";

validateEnv();

const commands = [
  // 1. 경제 명령어
  new SlashCommandBuilder()
    .setName("돈")
    .setDescription("자신의 잔액을 조회합니다."),
  new SlashCommandBuilder()
    .setName("송금")
    .setDescription("다른 사용자에게 코인을 송금합니다.")
    .addUserOption(option => 
      option.setName("대상").setDescription("코인을 보낼 유저").setRequired(true)
    )
    .addIntegerOption(option => 
      option.setName("금액").setDescription("보낼 코인 양").setRequired(true).setMinValue(1)
    ),
  new SlashCommandBuilder()
    .setName("일출")
    .setDescription("일일 보상 코인을 획득합니다."),

  // 2. 미니게임
  new SlashCommandBuilder()
    .setName("슬롯머신")
    .setDescription(`슬롯머신을 돌립니다. (소모: ${ECONOMY_CONFIG.slots.cost} 코인)`),
  new SlashCommandBuilder()
    .setName("주사위")
    .setDescription("주사위 굴리기 도박을 진행합니다.")
    .addIntegerOption(option =>
      option.setName("배팅금").setDescription("배팅할 코인 양").setRequired(true).setMinValue(ECONOMY_CONFIG.dice.minBet)
    ),
  new SlashCommandBuilder()
    .setName("동전")
    .setDescription("동전 던지기 도박을 진행합니다.")
    .addStringOption(option =>
      option.setName("선택").setDescription("앞면 혹은 뒷면을 선택하세요.").setRequired(true).addChoices(
        { name: "앞면", value: "front" },
        { name: "뒷면", value: "back" }
      )
    )
    .addIntegerOption(option =>
      option.setName("배팅금").setDescription("배팅할 코인 양").setRequired(true).setMinValue(ECONOMY_CONFIG.coinflip.minBet)
    ),

  // 3. 생산 및 수집
  new SlashCommandBuilder()
    .setName("낚시")
    .setDescription("강가나 바다로 나가 낚시를 시도합니다."),
  new SlashCommandBuilder()
    .setName("채굴")
    .setDescription("광산으로 들어가 광석을 채굴합니다."),
  new SlashCommandBuilder()
    .setName("농사")
    .setDescription("밭을 가꾸어 다양한 작물을 수확합니다."),

  // 4. 아이템 / 인벤토리 / 상점
  new SlashCommandBuilder()
    .setName("인벤토리")
    .setDescription("자신의 인벤토리 및 획득한 아이템을 확인합니다."),
  new SlashCommandBuilder()
    .setName("상점")
    .setDescription("코인으로 구매할 수 있는 상점 아이템을 보거나 구매합니다.")
    .addStringOption(option => {
      option.setName("아이템").setDescription("구매할 아이템의 이름을 입력하거나 선택하세요.").setRequired(false);
      ECONOMY_CONFIG.shop.forEach(item => {
        option.addChoices({ name: `${item.name} (${item.price}코인)`, value: item.id });
      });
      return option;
    }),
  new SlashCommandBuilder()
    .setName("판매")
    .setDescription("수집한 생선, 광석, 작물 등을 일괄 혹은 개별 판매합니다.")
    .addStringOption(option =>
      option.setName("대상").setDescription("판매할 아이템 ID를 적거나 '전체'를 선택해 모두 판매합니다.").setRequired(false)
    ),

  // 5. 업적 / 랭킹 / 퀘스트
  new SlashCommandBuilder()
    .setName("랭킹")
    .setDescription("서버 내 코인 보유 순위를 확인합니다."),
  new SlashCommandBuilder()
    .setName("업적")
    .setDescription("자신의 업적 달성 현황을 조회합니다."),
  new SlashCommandBuilder()
    .setName("퀘스트")
    .setDescription("오늘 진행해야 하는 일일 퀘스트 목록과 달성 상태를 조회합니다."),
].map(command => command.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log("Started refreshing application (/) commands.");

    // 글로벌 슬래시 명령어 등록 (테스트 환경에선 길드 등록이 실시간 적용되어 빠르나, 글로벌 등록으로 구성)
    // DISCORD_TOKEN에서 첫 번째 파트를 base64 디코딩하여 Application ID(Client ID)를 얻습니다.
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
      } catch (e) {
        console.error("Token decoding failed:", e);
      }
    }
    
    if (!clientId) {
      throw new Error("DISCORD_CLIENT_ID or valid DISCORD_TOKEN is required.");
    }

    await rest.put(
      Routes.applicationCommands(clientId),
      { body: commands }
    );

    console.log("Successfully reloaded application (/) commands.");
  } catch (error) {
    console.error("Error deployment of slash commands:", error);
  }
})();
