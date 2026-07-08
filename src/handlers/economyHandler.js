import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, MessageFlags } from "discord.js";
import { randomInt } from "crypto";
import { EconomyService } from "../services/economyService.js";
import { EconomyQuestService } from "../services/economyQuestService.js";
import { ECONOMY_CONFIG } from "../config/economyConfig.js";
import { getUserSubscriptionTier } from "../services/subscription.js";
import { ADMIN_USER_ID } from "../config/models.js";
import { logError, logInfo } from "../logger.js";
import { db } from "../services/database.js";

function getWebGameUrl() {
  return (process.env.WEB_APP_URL || process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
}

// ─── 유틸리티 ────────────────────────────────────────────────────────────────

/** 밀리초를 사람이 읽기 쉬운 문자열로 변환 */
function formatTime(ms) {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes}분 ${remainingSeconds}초` : `${minutes}분`;
}

/** 가중치 기반 랜덤 아이템 추첨 */
function drawReward(rewardList) {
  const totalWeight = rewardList.reduce((acc, r) => acc + r.weight, 0);
  let rand = Math.random() * totalWeight;
  for (const reward of rewardList) {
    rand -= reward.weight;
    if (rand <= 0) return reward;
  }
  return rewardList[rewardList.length - 1];
}

/**
 * 퀘스트 진행도 증가 + 업적 달성 체크 후 알림 문자열 반환
 * @param {string} userId
 * @param {"daily"|"gamble"|"work"} actionType
 * @returns {Promise<string>} 알림 메시지 (없으면 빈 문자열)
 */
async function progressAndCheck(userId, actionType) {
  let notices = "";

  // 퀘스트 진행도 업데이트
  const newlyCompleted = await EconomyQuestService.incrementProgress(userId, actionType);
  if (newlyCompleted.length > 0) {
    notices += `\n\n🎯 **퀘스트 달성!** \`${newlyCompleted.join(", ")}\` — \`/퀘스트\` 에서 보상을 받으세요!`;
  }

  // 자산가 업적 (10,000코인 이상 보유)
  const user = await EconomyService.getOrCreateUser(userId);
  if (user.coins >= 10000) {
    const unlocked = await EconomyQuestService.checkAndUnlockAchievement(userId, "earn_10k");
    if (unlocked) {
      const def = ECONOMY_CONFIG.achievements.find(a => a.id === "earn_10k");
      notices += `\n🏆 **업적 달성!** [${def.name}] (+${def.reward.toLocaleString()} 코인)`;
    }
  }

  return notices;
}

// ─── 스트릭/도파민 유틸리티 ──────────────────────────────────────────────────

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function getStreak(userId, type) {
  const user = await db.get(`SELECT ${type}_streak FROM eco_users WHERE user_id = $1`, [userId]);
  return user ? (user[`${type}_streak`] || 0) : 0;
}

async function updateStreak(userId, type, isWin) {
  const user = await EconomyService.getOrCreateUser(userId);
  const current = user[`${type}_streak`] || 0;
  const newStreak = isWin ? current + 1 : 0;
  await db.run(`UPDATE eco_users SET ${type}_streak = $1 WHERE user_id = $2`, [newStreak, userId]);
  return newStreak;
}

function getStreakEmoji(streak) {
  if (streak >= 10) return "🔥🔥🔥";
  if (streak >= 7) return "🔥🔥";
  if (streak >= 5) return "🔥";
  if (streak >= 3) return "⚡";
  return "";
}

function getStreakBonus(streak, config) {
  if (streak < config.streakThreshold) return 1.0;
  const bonus = Math.min((streak - config.streakThreshold + 1) * config.streakBonusPerWin, config.maxStreakBonus);
  return 1.0 + bonus;
}

// ─── 낚시 세션 관리 (랜덤 바이트 + 버튼 클릭) ────────────────────────────
const fishingSessions = new Map();

function clearFishingSession(userId) {
  const session = fishingSessions.get(userId);
  if (session) {
    session.active = false;
    clearTimeout(session.biteTimer);
    clearTimeout(session.expireTimer);
    fishingSessions.delete(userId);
  }
}

async function onFishBite(session) {
  if (!session.active) return;

  try {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`fish_catch:${session.userId}`)
        .setLabel("낚아채기!")
        .setStyle(ButtonStyle.Success)
        .setEmoji("🎣")
    );

    await session.interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xFFD700)
          .setTitle("🐟 물고기가 찌를 물었습니다!")
          .setDescription(
            "**지금입니다!** 아래 버튼을 눌러 낚아채세요!\n\n" +
            "⏰ **5초** 안에 버튼을 누르지 않으면 물고기가 도망갑니다!"
          )
          .setFooter({ text: "⏰ 5초 안에 버튼을 누르세요!" })
          .setTimestamp()
      ],
      components: [row],
    });

    session.expireTimer = setTimeout(() => onFishExpire(session), 5000);
  } catch (e) {
    clearFishingSession(session.userId);
  }
}

async function onFishExpire(session) {
  if (!session.active) return;
  clearFishingSession(session.userId);

  try {
    await updateStreak(session.userId, "fishing", false);
    const streakLoss = session.streak >= 3
      ? `\n💔 ${session.streak}연속 성공이 끊겼습니다...`
      : "";

    await session.interaction.editReply({
      content: "",
      embeds: [
        new EmbedBuilder()
          .setColor(0x888888)
          .setTitle("🎣 낚시 실패!")
          .setDescription(
            `💤 **늦었습니다!** 물고기가 미끼만 빼먹고 도망갔어요...\n다음에는 재빨리 낚아채세요!${streakLoss}`
          )
          .setFooter({ text: `쿨다운: ${formatTime(ECONOMY_CONFIG.cooldowns.fishing)}` })
          .setTimestamp()
      ],
      components: [],
    });
  } catch (e) {
    // interaction expired or invalid, nothing to do
  }
}

/** 큰 당첨을 채널에 공지 */
async function announceBigWin(channel, userId, game, amount, detail) {
  if (amount < 10000) return;
  const emoji = amount >= 50000 ? "🌟💫🌟" : amount >= 25000 ? "🎉🎉" : "🎉";
  await channel.send({
    content: `${emoji} **JACKPOT!** <@${userId}>님이 **${game}**에서 ${detail}\n**+${amount.toLocaleString()}** 코인 획득! ${emoji}`
  }).catch(() => {});
}

// ─── 명령어 핸들러 ────────────────────────────────────────────────────────────

export async function handleEconomyCommand(interaction) {
  const { commandName, user } = interaction;
  const userId = user.id;

  try {
    switch (commandName) {
      case "돈":        return await handleBalance(interaction, userId);
      case "상황":      return await handleStatus(interaction, userId);
      case "송금":      return await handleTransfer(interaction, userId);
      case "일출":      return await handleDaily(interaction, userId);
      case "룰렛":      return await handleRoulette(interaction, userId);
      case "슬롯머신":  return await handleSlots(interaction, userId);
      case "주사위":    return await handleDice(interaction, userId);
      case "동전":      return await handleCoinflip(interaction, userId);
      case "낚시":      return await handleFishing(interaction, userId);
      case "채굴":      return await handleMining(interaction, userId);
      case "농사":      return await handleFarming(interaction, userId);
      case "인벤토리":  return await handleInventory(interaction, userId);
      case "상점":      return await handleShop(interaction, userId);
      case "판매":      return await handleSell(interaction, userId);
      case "랭킹":      return await handleRanking(interaction);
      case "업적":      return await handleAchievements(interaction, userId);
      case "퀘스트":    return await handleQuests(interaction, userId);
      case "레이드설정":
      case "레이드_활성화": return await handleRaidConfig(interaction);
      case "레이드_비활성화": return await handleRaidDeactivate(interaction);
      case "레이드_상태": return await handleRaidStatus(interaction);
      case "레이드_테스트": return await handleRaidTest(interaction);
      case "농장알림": return await handleCropNotification(interaction, userId);
    }
  } catch (error) {
    logError("economy_command", interaction.guildId, error, {
      commandName,
      userId,
    });
    const method = interaction.replied || interaction.deferred ? "followUp" : "reply";
    await interaction[method]({
      content: "❌ 명령 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }
}

// ─── 1. 잔액 조회 ─────────────────────────────────────────────────────────────
async function handleBalance(interaction, userId) {
  const userData = await EconomyService.getOrCreateUser(userId);
  const { user } = interaction;

  // 코인 순위
  const rankings = await EconomyService.getRankings(100);
  const rankPos = rankings.findIndex(r => r.user_id === userId) + 1;
  const rankText = rankPos > 0 ? `${rankPos}위` : "순위권 밖";

  // 등급 및 수수료
  const tier = await getUserSubscriptionTier(userId);
  const feeRate = ECONOMY_CONFIG.transferFee[tier] ?? ECONOMY_CONFIG.transferFee.free;
  const feeText = feeRate === 0 ? "**면제** (프리미엄 혜택)" : `**${(feeRate * 100).toFixed(0)}%**`;

  const embed = new EmbedBuilder()
    .setColor(0x00FFBB)
    .setTitle(`💰 ${user.displayName}님의 지갑`)
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: `${ECONOMY_CONFIG.currencyEmoji} 보유 코인`, value: `**${userData.coins.toLocaleString()}** 코인`, inline: true },
      { name: "🏆 현재 순위", value: rankText, inline: true },
      { name: "💸 송금 수수료", value: feeText, inline: true },
    )
    .setFooter({ text: "낚시, 웹 채굴, 웹 농사로 코인을 모아보세요! | 프리미엄 등급은 송금 수수료가 없어요." })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

async function handleStatus(interaction, userId) {
  const userData = await EconomyService.getOrCreateUser(userId);
  const inventory = await EconomyService.getInventory(userId);
  const miningReadyAt = userData.last_mining ? new Date(new Date(userData.last_mining).getTime() + ECONOMY_CONFIG.cooldowns.mining) : null;
  const farmingReadyAt = userData.last_farming ? new Date(new Date(userData.last_farming).getTime() + ECONOMY_CONFIG.cooldowns.farming) : null;
  const now = new Date();

  const formatReady = (date) => {
    if (!date) return "즉시 가능";
    const diff = date.getTime() - now.getTime();
    if (diff <= 0) return "즉시 가능";
    return `약 ${formatTime(diff)} 후`;
  };

  let raidStatus = "확인 불가";
  try {
    const webUrl = getWebGameUrl();
    const raidRes = await fetch(`${webUrl}/api/raid/state`);
    if (raidRes.ok) {
      const raidData = await raidRes.json();
      if (raidData.raid) {
        const hpPct = Math.max(0, Math.round(raidData.raid.current_hp / raidData.raid.max_hp * 100));
        raidStatus = `⚔️ **${raidData.raid.boss_name}** HP ${hpPct}%`;
      } else {
        raidStatus = "휴면 상태";
      }
    }
  } catch (e) {}

  const embed = new EmbedBuilder()
    .setColor(0x4CC9F0)
    .setTitle(`📊 ${interaction.user.displayName}님의 상황`)
    .setDescription(
      `디스코드에서는 조회만 가능합니다.\n` +
      `채굴과 농사는 웹사이트에서만 플레이할 수 있습니다.`
    )
    .addFields(
      { name: "보유 코인", value: `**${userData.coins.toLocaleString()}** 코인`, inline: true },
      { name: "아이템 수", value: `**${inventory.length}**종`, inline: true },
      { name: "채굴 가능", value: formatReady(miningReadyAt), inline: true },
      { name: "농사 가능", value: formatReady(farmingReadyAt), inline: true },
      { name: "⚔️ 레이드 현황", value: raidStatus, inline: false },
      { name: "웹 플레이", value: `[웹사이트에서 플레이하기](${getWebGameUrl()})`, inline: false },
    )
    .setFooter({ text: "채굴/농사 실행은 웹사이트에서 진행됩니다." })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ─── 2. 송금 ──────────────────────────────────────────────────────────────────
async function handleTransfer(interaction, userId) {
  const targetUser = interaction.options.getUser("대상");
  const amount = interaction.options.getInteger("금액");

  if (targetUser.bot) {
    await interaction.reply({ content: "❌ 봇에게는 송금할 수 없습니다.", flags: MessageFlags.Ephemeral });
    return;
  }

  // 수수료 미리 계산 (안내용)
  const tier = await getUserSubscriptionTier(userId);
  const feeRate = ECONOMY_CONFIG.transferFee[tier] ?? ECONOMY_CONFIG.transferFee.free;
  const expectedFee = Math.floor(amount * feeRate);

  const result = await EconomyService.transferCoins(userId, targetUser.id, amount);
  if (!result.success) {
    await interaction.reply({ content: `❌ 송금 실패: ${result.errorMessage}`, flags: MessageFlags.Ephemeral });
    return;
  }

  const receiverData = await EconomyService.getOrCreateUser(targetUser.id);
  const feeText = result.fee > 0
    ? `**${result.fee.toLocaleString()}** 코인 (${(feeRate * 100).toFixed(0)}%)`
    : "**없음** (프리미엄 혜택 ✨)";

  const embed = new EmbedBuilder()
    .setColor(0x00AAFF)
    .setTitle("💸 송금 완료")
    .setDescription(`<@${userId}>님이 <@${targetUser.id}>님에게 코인을 보냈습니다.`)
    .addFields(
      { name: "송금 금액",   value: `**${amount.toLocaleString()}** ${ECONOMY_CONFIG.currencyEmoji}`, inline: true },
      { name: "수수료",     value: feeText, inline: true },
      { name: "나의 잔액",  value: `**${result.senderBalance.toLocaleString()}** 코인`, inline: true },
      { name: "받은 분 잔액", value: `**${receiverData.coins.toLocaleString()}** 코인`, inline: true },
    )
    .setFooter({ text: "프리미엄 등급으로 업그레이드하면 송금 수수료가 없어집니다!" })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

// ─── 3. 일일 보상 ─────────────────────────────────────────────────────────────
async function handleDaily(interaction, userId) {
  const cooldown = await EconomyService.checkAndSetCooldown(userId, "daily");
  if (cooldown.isCooldown) {
    await interaction.reply({
      content: `⏰ 이미 오늘의 보상을 수령했습니다. 다음 수령까지 **${formatTime(cooldown.remaining)}** 남았습니다.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const rewardCoins = 1000;
  await EconomyService.updateCoins(userId, rewardCoins);

  const notices = await progressAndCheck(userId, "daily");

  // 성실한 하루 업적
  const firstDailyUnlocked = await EconomyQuestService.checkAndUnlockAchievement(userId, "first_daily");
  let achievementNotice = "";
  if (firstDailyUnlocked) {
    const def = ECONOMY_CONFIG.achievements.find(a => a.id === "first_daily");
    achievementNotice = `\n🏆 **업적 달성!** [${def.name}] - ${def.description} (+${def.reward.toLocaleString()} 코인)`;
  }

  const currentBalance = (await EconomyService.getOrCreateUser(userId)).coins;

  const embed = new EmbedBuilder()
    .setColor(0xFFDD00)
    .setTitle("☀️ 일일 보상 획득!")
    .setDescription(
      `오늘의 출석 보상으로 **${rewardCoins.toLocaleString()}** ${ECONOMY_CONFIG.currencyEmoji}을 지급받았습니다!` +
      notices + achievementNotice
    )
    .addFields({ name: "현재 잔액", value: `**${currentBalance.toLocaleString()}** 코인`, inline: true })
    .setFooter({ text: "내일 다시 받을 수 있어요!" })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

// ─── 4. 슬롯머신 ─────────────────────────────────────────────────────────────
async function handleSlots(interaction, userId) {
  const cost = ECONOMY_CONFIG.slots.cost;
  const userData = await EconomyService.getOrCreateUser(userId);

  if (userData.coins < cost) {
    await interaction.reply({
      content: `❌ 코인이 부족합니다. 슬롯머신 플레이에는 **${cost.toLocaleString()}** 코인이 필요합니다.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await EconomyService.updateCoins(userId, -cost);

  const symbols = ECONOMY_CONFIG.slots.symbols;
  const s = [
    symbols[Math.floor(Math.random() * symbols.length)],
    symbols[Math.floor(Math.random() * symbols.length)],
    symbols[Math.floor(Math.random() * symbols.length)],
  ];

  let reward = 0;
  let resultLine = "꽝! 다음 기회에...";
  let color = 0xFF3300;

  if (s[0] === s[1] && s[1] === s[2]) {
    const multiplier = ECONOMY_CONFIG.slots.multipliers[s[0]] ?? 1;
    reward = cost * multiplier;
    resultLine = `🎉 **잭팟!** \`${s[0]}\` 3개 일치! (x${multiplier} = **+${reward.toLocaleString()}** 코인)`;
    color = 0xFFD700;
  } else if (s[0] === s[1] || s[1] === s[2] || s[0] === s[2]) {
    reward = Math.floor(cost * ECONOMY_CONFIG.slots.twoMatchMultiplier);
    resultLine = `✨ **더블!** 2개 일치! (x${ECONOMY_CONFIG.slots.twoMatchMultiplier} = **+${reward.toLocaleString()}** 코인)`;
    color = 0x00FF88;
  }

  if (reward > 0) await EconomyService.updateCoins(userId, reward);

  const currentBalance = (await EconomyService.getOrCreateUser(userId)).coins;
  const notices = await progressAndCheck(userId, "gamble");

  // 777 잭팟 업적
  let achievementNotice = "";
  if (s[0] === "⭐" && s[1] === "⭐" && s[2] === "⭐") {
    const unlocked = await EconomyQuestService.checkAndUnlockAchievement(userId, "slots_jackpot");
    if (unlocked) {
      const def = ECONOMY_CONFIG.achievements.find(a => a.id === "slots_jackpot");
      achievementNotice = `\n🏆 **업적 달성!** [${def.name}] (+${def.reward.toLocaleString()} 코인)`;
    }
  }

  // 연승/스트릭
  const isWin = reward > 0;
  const newStreak = await updateStreak(userId, "game", isWin);
  const sEmoji = getStreakEmoji(newStreak);
  const streakText = isWin && newStreak >= 3 ? `\n${sEmoji} **${newStreak}연속 당첨!**` : "";

  // 큰 당첨 공지
  if (reward >= 5000) {
    await announceBigWin(interaction.channel, userId, "슬롯머신", reward, `🎰 ${s[0]}${s[1]}${s[2]}`);
  }

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle("🎰 슬롯머신")
    .setDescription(
      `## ┃ ${s[0]} ┃ ${s[1]} ┃ ${s[2]} ┃\n\n` +
      resultLine +
      streakText +
      `\n현재 잔액: **${currentBalance.toLocaleString()}** 코인` +
      notices + achievementNotice
    )
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

// ─── 5. 주사위 ────────────────────────────────────────────────────────────────
async function handleDice(interaction, userId) {
  const bet = interaction.options.getInteger("배팅금");
  const { maxBet, winMultiplier, criticalRate, criticalMultiplier } = ECONOMY_CONFIG.dice;

  if (bet > maxBet) {
    await interaction.reply({
      content: `❌ 최대 배팅금은 **${maxBet.toLocaleString()}** 코인입니다.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const userData = await EconomyService.getOrCreateUser(userId);
  if (userData.coins < bet) {
    await interaction.reply({ content: "❌ 보유 코인이 배팅금보다 적습니다.", flags: MessageFlags.Ephemeral });
    return;
  }

  await EconomyService.updateCoins(userId, -bet);

  // 연승 정보 조회
  const streak = await getStreak(userId, "game");
  const streakEmoji = getStreakEmoji(streak);
  const streakMult = getStreakBonus(streak, ECONOMY_CONFIG.dice);
  const isCrit = Math.random() < criticalRate;

  // 주사위 굴리기 애니메이션
  await interaction.reply({
    content: "🎲 **주사위를 굴리는 중...** 🎲\n`🥌        `",
  });
  await sleep(600);
  await interaction.editReply({ content: "🎲 **굴러간다 굴러간다~** 🎲\n`   🥌     `" });
  await sleep(600);
  await interaction.editReply({ content: "🎲 **두구두구두구...** 🎲\n`      🥌  `" });
  await sleep(700);

  const myRoll  = Math.floor(Math.random() * 6) + 1;
  const botRoll = Math.floor(Math.random() * 6) + 1;

  let reward = 0;
  let resultLine = "";
  let color = 0x888888;
  let critText = "";
  let streakText = "";
  let isWin = false;

  if (myRoll > botRoll) {
    isWin = true;
    let effectiveMult = winMultiplier * streakMult;
    reward = Math.floor(bet * effectiveMult);
    if (isCrit) {
      reward = Math.floor(reward * criticalMultiplier);
      critText = "\n💥 **크리티컬 히트!** ×3 데미지!";
    }
    const streakCount = await updateStreak(userId, "game", true);
    const sEmoji = getStreakEmoji(streakCount);
    if (streakCount >= 3) streakText = `\n${sEmoji} **${streakCount}연승!** (x${effectiveMult.toFixed(1)})`;
    resultLine = `🎉 **승리!** x${effectiveMult.toFixed(1)} = **+${reward.toLocaleString()}** 코인`;
    if (isCrit) resultLine += critText;
    color = 0x00FF00;
  } else if (myRoll < botRoll) {
    await updateStreak(userId, "game", false);
    resultLine = "💀 **패배...** 배팅금을 잃었습니다.";
    color = 0xFF0000;
  } else {
    reward = bet;
    isWin = true;
    resultLine = "🤝 **무승부!** 배팅금을 돌려받습니다.";
    color = 0x888888;
  }

  if (reward > 0) await EconomyService.updateCoins(userId, reward);

  const currentBalance = (await EconomyService.getOrCreateUser(userId)).coins;
  const notices = await progressAndCheck(userId, "gamble");

  // 주사위 시각 표현
  const diceEmoji = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
  const myDiceEmoji = diceEmoji[myRoll];
  const botDiceEmoji = diceEmoji[botRoll];

  // 큰 당첨 공지
  if (reward > bet) {
    await announceBigWin(interaction.channel, userId, "주사위", reward - bet, `${myRoll} vs ${botRoll}로 승리`);
  }

  const desc = [
    `${streakText}`,
    `${resultLine}`,
    ``,
    `현재 잔액: **${currentBalance.toLocaleString()}** 코인`,
  ].filter(Boolean).join("\n");

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle("🎲 주사위 대결" + (isCrit ? " 💥" : ""))
    .addFields(
      { name: "🧑 나", value: `${myDiceEmoji} **${myRoll}**`, inline: true },
      { name: "🤖 봇", value: `${botDiceEmoji} **${botRoll}**`, inline: true },
    )
    .setDescription(desc + notices)
    .setTimestamp();

  await interaction.editReply({ content: "", embeds: [embed] });
}

// ─── 6. 동전 던지기 ───────────────────────────────────────────────────────────
async function handleCoinflip(interaction, userId) {
  const pick = interaction.options.getString("선택");
  const bet  = interaction.options.getInteger("배팅금");
  const { maxBet, winMultiplier, streakBonusPerWin, maxStreakBonus, streakThreshold } = ECONOMY_CONFIG.coinflip;

  if (bet > maxBet) {
    await interaction.reply({
      content: `❌ 최대 배팅금은 **${maxBet.toLocaleString()}** 코인입니다.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const userData = await EconomyService.getOrCreateUser(userId);
  if (userData.coins < bet) {
    await interaction.reply({ content: "❌ 보유 코인이 배팅금보다 적습니다.", flags: MessageFlags.Ephemeral });
    return;
  }

  await EconomyService.updateCoins(userId, -bet);

  // 동전 던지기 애니메이션
  await interaction.reply({
    content: "🪙 **동전을 던지는 중...** 🪙\n`🪙        `",
  });
  await sleep(500);
  await interaction.editReply({ content: "🪙 **빙글빙글~** 🪙\n`  🪙      `" });
  await sleep(500);
  await interaction.editReply({ content: "🪙 **돌아간다 돌아간다~** 🪙\n`    🪙    `" });
  await sleep(600);

  const streak = await getStreak(userId, "game");
  const streakMult = getStreakBonus(streak, ECONOMY_CONFIG.coinflip);

  const result   = Math.random() < 0.5 ? "front" : "back";
  const resultKo = result === "front" ? "앞면 🟡" : "뒷면 ⚪";
  const pickKo   = pick   === "front" ? "앞면 🟡" : "뒷면 ⚪";

  let reward = 0;
  let resultLine = "";
  let color = 0xFF0000;

  if (pick === result) {
    const effectiveMult = winMultiplier * streakMult;
    reward = Math.floor(bet * effectiveMult);
    const newStreak = await updateStreak(userId, "game", true);
    const sEmoji = getStreakEmoji(newStreak);
    const streakText = newStreak >= 3 ? `\n${sEmoji} **${newStreak}연승!** (x${effectiveMult.toFixed(1)})` : "";
    resultLine = `🎉 **적중!** x${effectiveMult.toFixed(1)} = **+${reward.toLocaleString()}** 코인${streakText}`;
    color = 0x00FF00;
  } else {
    await updateStreak(userId, "game", false);
    resultLine = `💀 **오답!** 배팅금을 잃었습니다.`;
  }

  if (reward > 0) await EconomyService.updateCoins(userId, reward);

  const currentBalance = (await EconomyService.getOrCreateUser(userId)).coins;
  const notices = await progressAndCheck(userId, "gamble");

  if (reward > bet) {
    await announceBigWin(interaction.channel, userId, "동전던지기", reward - bet, `${pickKo} 선택`);
  }

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle("🪙 동전 던지기")
    .addFields(
      { name: "나의 선택", value: pickKo,   inline: true },
      { name: "결과",      value: resultKo, inline: true },
    )
    .setDescription(
      `\n${resultLine}\n현재 잔액: **${currentBalance.toLocaleString()}** 코인` + notices
    )
    .setTimestamp();

  await interaction.editReply({ content: "", embeds: [embed] });
}

// ─── 6.5. 🎰 룰렛 ──────────────────────────────────────────────────────────────
async function handleRoulette(interaction, userId) {
  const bet = interaction.options.getInteger("배팅금");
  const betType = interaction.options.getString("종류");
  const betChoice = interaction.options.getString("선택").toLowerCase().trim();

  const { minBet, maxBet, straightWinMultiplier, outsideWinMultiplier, dozenWinMultiplier, redNumbers } = ECONOMY_CONFIG.roulette;

  if (bet < minBet) {
    await interaction.reply({ content: `❌ 최소 배팅금은 **${minBet.toLocaleString()}** 코인입니다.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (bet > maxBet) {
    await interaction.reply({ content: `❌ 최대 배팅금은 **${maxBet.toLocaleString()}** 코인입니다.`, flags: MessageFlags.Ephemeral });
    return;
  }

  const userData = await EconomyService.getOrCreateUser(userId);
  if (userData.coins < bet) {
    await interaction.reply({ content: "❌ 보유 코인이 배팅금보다 적습니다.", flags: MessageFlags.Ephemeral });
    return;
  }

  // 배팅 금액 차감
  await EconomyService.updateCoins(userId, -bet);

  // 스트릭 정보
  const streak = await getStreak(userId, "game");
  const streakEmoji = getStreakEmoji(streak);

  // 룰렛 스핀 애니메이션
  await interaction.reply({
    content: "🎰 **룰렛을 돌리는 중...**\n`⚙️         `",
  });
  await sleep(700);
  await interaction.editReply({ content: "🎰 **돌아간다 돌아간다~** 🎰\n`  ⚙️       `" });
  await sleep(700);
  await interaction.editReply({ content: "🎰 **어디에 멈출까...** 🎰\n`     ⚙️    `" });
  await sleep(700);
  await interaction.editReply({ content: "🎰 🎰 🎰 **두구두구두구!** 🎰 🎰 🎰\n`        ⚙️  `" });
  await sleep(700);

  // 결과 생성
  const result = Math.floor(Math.random() * 37); // 0-36
  const isRed = redNumbers.includes(result);
  const resultColor = result === 0 ? "초록" : isRed ? "빨강" : "검정";
  const resultColorEmoji = result === 0 ? "💚" : isRed ? "🔴" : "⚫";
  const resultParity = result === 0 ? "제로" : (result % 2 === 0 ? "짝수" : "홀수");
  const resultRange = result === 0 ? "-" : (result <= 18 ? "1-18" : "19-36");
  const resultDozen = result === 0 ? "-" : (result <= 12 ? "1st 12" : result <= 24 ? "2nd 12" : "3rd 12");

  // 당첨 판정
  let win = false;
  let multiplier = 0;
  let betLabel = "";

  switch (betType) {
    case "number": {
      const num = parseInt(betChoice);
      if (isNaN(num) || num < 0 || num > 36) {
        await EconomyService.updateCoins(userId, bet);
        await interaction.editReply({ content: "❌ 올바른 숫자를 입력하세요 (0-36). 배팅금을 돌려드립니다." });
        return;
      }
      win = result === num;
      multiplier = straightWinMultiplier;
      betLabel = `숫자 **${num}**`;
      break;
    }
    case "red_black": {
      if (betChoice === "빨강" || betChoice === "red") {
        win = isRed;
        betLabel = "🔴 빨강";
      } else {
        win = !isRed && result !== 0;
        betLabel = "⚫ 검정";
      }
      multiplier = outsideWinMultiplier;
      break;
    }
    case "odd_even": {
      if (result === 0) { win = false; }
      else if (betChoice === "홀" || betChoice === "odd") { win = result % 2 === 1; }
      else { win = result % 2 === 0; }
      multiplier = outsideWinMultiplier;
      betLabel = betChoice === "홀" || betChoice === "odd" ? "홀수" : "짝수";
      break;
    }
    case "high_low": {
      if (result === 0) { win = false; }
      else if (betChoice === "low" || betChoice === "1-18") { win = result <= 18; }
      else { win = result >= 19; }
      multiplier = outsideWinMultiplier;
      betLabel = betChoice === "low" || betChoice === "1-18" ? "1-18" : "19-36";
      break;
    }
    case "dozen": {
      if (result === 0) { win = false; }
      else if (betChoice === "1st" || betChoice === "1-12") { win = result <= 12; }
      else if (betChoice === "2nd" || betChoice === "13-24") { win = result >= 13 && result <= 24; }
      else { win = result >= 25; }
      multiplier = dozenWinMultiplier;
      const dozenLabel = betChoice === "1st" || betChoice === "1-12" ? "1st 12" : betChoice === "2nd" || betChoice === "13-24" ? "2nd 12" : "3rd 12";
      betLabel = dozenLabel;
      break;
    }
  }

  let reward = 0;
  let resultLine = "";
  let embedColor = 0xFF0000;
  let isWin = false;

  if (win) {
    isWin = true;
    reward = Math.floor(bet * multiplier);
    await EconomyService.updateCoins(userId, reward);

    // 연승 갱신
    const newStreak = await updateStreak(userId, "game", true);
    const sEmoji = getStreakEmoji(newStreak);
    const streakText = newStreak >= 3 ? `\n${sEmoji} **${newStreak}연승!**` : "";

    resultLine = `🎉 **적중!** x${multiplier} = **+${reward.toLocaleString()}** 코인!${streakText}`;
    embedColor = reward >= bet * 10 ? 0xFFD700 : 0x00FF00;
  } else {
    await updateStreak(userId, "game", false);
    const streakLoss = streak >= 3 ? `\n💔 ${streak}연승이 끊겼습니다...` : "";
    resultLine = `💀 **미스...** 배팅금 **${bet.toLocaleString()}**코인을 잃었습니다.${streakLoss}`;
    embedColor = 0xFF0000;
  }

  const currentBalance = (await EconomyService.getOrCreateUser(userId)).coins;
  const notices = await progressAndCheck(userId, "gamble");

  // 높은 당첨금 기록 갱신
  const highest = userData.highest_roulette_win || 0;
  if (reward > highest) {
    await db.run("UPDATE eco_users SET highest_roulette_win = $1 WHERE user_id = $2", [reward, userId]);
  }

  // 큰 당첨 공지
  if (reward > bet) {
    await announceBigWin(interaction.channel, userId, "룰렛", reward - bet, `${betLabel}에 배팅하여 당첨!`);
  }

  // 결과 필드
  const resultField = [
    `**${result}** ${resultColorEmoji}`,
    `${resultColor} · ${resultParity}`,
    `${resultRange} · ${resultDozen}`,
  ].join("\n");

  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setTitle("🎰 룰렛 결과")
    .addFields(
      { name: "🎯 배팅", value: `\`${bet.toLocaleString()}\`코인 → ${betLabel}`, inline: true },
      { name: "🎳 룰렛 공", value: resultField, inline: true },
    )
    .setDescription(
      `\n━━━━━━━━━━━━━━━━\n${resultLine}\n━━━━━━━━━━━━━━━━\n` +
      `현재 잔액: **${currentBalance.toLocaleString()}** 코인` +
      notices
    )
    .setTimestamp();

  await interaction.editReply({ content: "", embeds: [embed] });
}

// ─── 7. 낚시 (랜덤 타이밍 + 버튼 클릭) ─────────────────────────────────────
async function handleFishing(interaction, userId) {
  // 쿨다운 체크 (세션 시작 시 바로 소모 - 놓쳐도 쿨다운 감)
  const cooldown = await EconomyService.checkAndSetCooldown(userId, "fishing");
  if (cooldown.isCooldown) {
    await interaction.reply({
      content: `⏰ 낚싯줄이 엉켰습니다. **${formatTime(cooldown.remaining)}** 후에 다시 시도하세요.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // 기존 세션 정리
  clearFishingSession(userId);

  // 스트릭 조회
  const streak = await getStreak(userId, "fishing");
  const streakEmoji = getStreakEmoji(streak);

  const streakText = streak >= 3
    ? `${streakEmoji} **${streak}연속 낚시 성공 중!**\n\n`
    : "";

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x00BFFF)
        .setTitle("🎣 낚시 시작!")
        .setDescription(
          `${streakText}낚시대를 던졌습니다...\n` +
          `물고기가 찌를 물 때까지 **기다려주세요!** 🎣\n\n` +
          `물고기가 물면 버튼이 나타납니다!\n` +
          `**5초** 안에 버튼을 눌러야 잡을 수 있어요!`
        )
        .setFooter({ text: "기다리는 중..." })
        .setTimestamp()
    ],
  });

  // 랜덤 시간 (3~10초) 후 바이트
  const biteDelay = randomInt(3000, 10001);

  const session = {
    interaction,
    userId,
    streak,
    active: true,
    biteTimer: null,
    expireTimer: null,
  };

  session.biteTimer = setTimeout(() => onFishBite(session), biteDelay);
  fishingSessions.set(userId, session);
}

// ─── 낚시 버튼 클릭 처리 ───────────────────────────────────────────────────
export async function handleFishingCatch(interaction, userId) {
  const session = fishingSessions.get(userId);
  if (!session || !session.active) {
    await interaction.reply({
      content: "⏰ 이미 시간이 지났거나 낚시 세션이 만료되었어요! `/낚시` 로 다시 시작하세요.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  clearFishingSession(userId);
  await interaction.deferUpdate();

  const streak = session.streak;
  const newStreak = streak + 1;
  const streakEmojiNew = getStreakEmoji(newStreak);

  // 연속 성공률 보너스
  const effectiveRate = Math.min(
    ECONOMY_CONFIG.fishing.successRate + (streak * ECONOMY_CONFIG.fishing.streakSuccessBonus),
    ECONOMY_CONFIG.fishing.successRate + ECONOMY_CONFIG.fishing.maxStreakBonus
  );

  const success = Math.random() < effectiveRate;
  if (!success) {
    await updateStreak(userId, "fishing", false);
    const streakLoss = streak >= 3 ? `\n💔 ${streak}연속 성공이 끊겼습니다...` : "";
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x888888)
          .setTitle("🎣 낚시 실패!")
          .setDescription(
            `힘껏 낚아챘지만... 물고기가 너무 강했습니다!${streakLoss}\n다음 기회를 노려보세요!`
          )
          .setFooter({ text: `쿨다운: ${formatTime(ECONOMY_CONFIG.cooldowns.fishing)}` })
          .setTimestamp()
      ],
      components: [],
    });
    return;
  }

  // 특별 이벤트 체크 (해일/대박)
  const isSpecial = Math.random() < ECONOMY_CONFIG.fishing.specialEventRate;

  // 스트릭 갱신
  await updateStreak(userId, "fishing", true);

  let rewardMultiplier = 1;
  let eventText = "";
  if (isSpecial) {
    rewardMultiplier = ECONOMY_CONFIG.fishing.specialEventMultiplier;
    eventText = "\n🌊 **해일이 몰려왔다!** 대박 터졌다! 🌊";
  }

  // 아이템 선택 (스트릭이 높을수록 희귀도 증가)
  let rewards = [...ECONOMY_CONFIG.fishing.rewards];
  if (newStreak >= 5) {
    rewards = rewards.map(r => {
      if (r.id === "fish_trash") return { ...r, weight: Math.max(5, r.weight - 15) };
      if (r.id === "fish_legendary") return { ...r, weight: r.weight + 3 };
      return r;
    });
  }

  const item = drawReward(rewards);
  const quantity = isSpecial ? Math.floor(Math.random() * 3) + 1 : 1;
  const totalSellValue = item.sellPrice * quantity * rewardMultiplier;

  await EconomyService.updateInventory(userId, item.id, quantity);

  const notices = await progressAndCheck(userId, "work");

  let achievementNotice = "";
  if (item.id === "fish_legendary") {
    const unlocked = await EconomyQuestService.checkAndUnlockAchievement(userId, "fish_legendary");
    if (unlocked) {
      const def = ECONOMY_CONFIG.achievements.find(a => a.id === "fish_legendary");
      achievementNotice = `\n🏆 **업적 달성!** [${def.name}] - ${def.description} (+${def.reward.toLocaleString()} 코인)`;
    }
  }

  const rarityColor = {
    fish_legendary: 0xFFD700,
    fish_rare:      0x9400D3,
    fish_normal_2:  0x00BFFF,
    fish_normal_1:  0x00FFFF,
    fish_trash:     0x888888,
  };

  const streakText = newStreak >= 3
    ? `${streakEmojiNew} **${newStreak}연속 낚시 성공!**\n`
    : "";

  const itemQuantityText = quantity > 1 ? `×${quantity}` : "";
  const specialBonusText = isSpecial
    ? `\n💰 **판매가 x${rewardMultiplier} = ${totalSellValue.toLocaleString()}코인!**`
    : `\n💰 판매가: **${item.sellPrice.toLocaleString()}** 코인/개`;

  const desc = [
    streakText,
    `✨ **${item.name}** ${itemQuantityText}`,
    `*${item.description}*`,
    specialBonusText,
  ].filter(Boolean).join("\n");

  const embed = new EmbedBuilder()
    .setColor(rarityColor[item.id] ?? 0x00FFFF)
    .setTitle(`🎣 낚시 성공!${isSpecial ? " 🌊💥" : ""}`)
    .setDescription(eventText + "\n" + desc + notices + achievementNotice)
    .setFooter({ text: `쿨다운: ${formatTime(ECONOMY_CONFIG.cooldowns.fishing)}` })
    .setTimestamp();

  if (item.id === "fish_legendary" || isSpecial) {
    await announceBigWin(interaction.channel, userId, "낚시", totalSellValue, `${item.name} 낚시 성공!`);
  }

  await interaction.editReply({
    embeds: [embed],
    components: [],
  });
}

// ─── 8. 채굴 ─────────────────────────────────────────────────────────────────
async function handleMining(interaction, userId) {
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x4CC9F0)
        .setTitle("⛏️ 채굴은 웹사이트 전용")
        .setDescription(
          `디스코드에서는 채굴을 실행할 수 없습니다.\n` +
          `웹사이트에서만 플레이할 수 있도록 분리했습니다.\n\n` +
          `[웹 채굴하러 가기](${getWebGameUrl()})`
        )
        .setFooter({ text: "잔액과 상황만 디스코드에서 조회할 수 있습니다." })
        .setTimestamp(),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

// ─── 9. 농사 ─────────────────────────────────────────────────────────────────
async function handleFarming(interaction, userId) {
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x4CC9F0)
        .setTitle("🌾 농사는 웹사이트 전용")
        .setDescription(
          `디스코드에서는 농사를 실행할 수 없습니다.\n` +
          `웹사이트에서만 플레이할 수 있도록 분리했습니다.\n\n` +
          `[웹 농사하러 가기](${getWebGameUrl()})`
        )
        .setFooter({ text: "잔액과 상황만 디스코드에서 조회할 수 있습니다." })
        .setTimestamp(),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

// ─── 10. 인벤토리 ────────────────────────────────────────────────────────────
async function handleInventory(interaction, userId) {
  const inv = await EconomyService.getInventory(userId);

  if (inv.length === 0) {
    const embed = new EmbedBuilder()
      .setColor(0x888888)
      .setTitle("🎒 인벤토리")
      .setDescription("인벤토리가 비어 있습니다.\n낚시, 채굴, 농사 등으로 아이템을 획득해보세요!")
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
    return;
  }

  // 아이템 목록 (카테고리별 정렬: 물고기 → 광석 → 작물 → 기타)
  const categoryOrder = ["fish", "ore", "crop"];
  const sorted = [...inv].sort((a, b) => {
    const ai = categoryOrder.findIndex(c => a.item_id.startsWith(c));
    const bi = categoryOrder.findIndex(c => b.item_id.startsWith(c));
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  const totalSellValue = inv.reduce((acc, i) => acc + i.sellPrice * i.quantity, 0);
  const itemLines = sorted.map(item =>
    `• **${item.name}** ×${item.quantity}  (판매가: ${item.sellPrice.toLocaleString()}코인/개)`
  );

  const embed = new EmbedBuilder()
    .setColor(0xCD853F)
    .setTitle(`🎒 ${interaction.user.displayName}님의 인벤토리`)
    .setDescription(itemLines.join("\n"))
    .addFields({
      name: "💰 전체 판매 시 예상 금액",
      value: `**${totalSellValue.toLocaleString()}** 코인`,
      inline: false,
    })
    .setFooter({ text: "/판매 로 아이템을 판매할 수 있습니다." })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

// ─── 11. 상점 ────────────────────────────────────────────────────────────────
async function handleShop(interaction, userId) {
  const itemId = interaction.options.getString("아이템");

  if (!itemId) {
    // 상점 목록 표시
    const lines = ECONOMY_CONFIG.shop.map(item =>
      `**${item.name}** — \`${item.price.toLocaleString()}\` 코인\n*${item.description}*`
    );

    const embed = new EmbedBuilder()
      .setColor(0x00FF7F)
      .setTitle("🛒 FLUX 잡화상점")
      .setDescription(
        "코인을 사용하여 다양한 아이템을 구매할 수 있습니다.\n\n" +
        lines.join("\n\n") +
        "\n\n`/상점 [아이템]` 선택 후 즉시 구매하세요!"
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
    return;
  }

  // 구매 처리
  const targetItem = ECONOMY_CONFIG.shop.find(item => item.id === itemId);
  if (!targetItem) {
    await interaction.reply({ content: "❌ 존재하지 않는 아이템입니다.", flags: MessageFlags.Ephemeral });
    return;
  }

  const { coins } = await EconomyService.getOrCreateUser(userId);
  if (coins < targetItem.price) {
    await interaction.reply({
      content: `❌ 코인이 부족합니다. **${targetItem.price.toLocaleString()}** 코인이 필요하지만 **${coins.toLocaleString()}** 코인만 보유 중입니다.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await EconomyService.updateCoins(userId, -targetItem.price);
  await EconomyService.updateInventory(userId, targetItem.id, 1);

  const newBalance = (await EconomyService.getOrCreateUser(userId)).coins;

  const embed = new EmbedBuilder()
    .setColor(0x00FF7F)
    .setTitle("🛒 구매 완료!")
    .addFields(
      { name: "구매 아이템",  value: `**${targetItem.name}** ×1`,           inline: true },
      { name: "지출",        value: `**${targetItem.price.toLocaleString()}** 코인`,   inline: true },
      { name: "남은 잔액",   value: `**${newBalance.toLocaleString()}** 코인`, inline: true },
    )
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

// ─── 12. 판매 ────────────────────────────────────────────────────────────────
async function handleSell(interaction, userId) {
  const target = interaction.options.getString("대상") || "전체";
  const inventory = await EconomyService.getInventory(userId);

  if (inventory.length === 0) {
    await interaction.reply({ content: "❌ 판매할 아이템이 없습니다.", flags: MessageFlags.Ephemeral });
    return;
  }

  let itemsToSell = [];

  if (target.toLowerCase() === "전체" || target.toLowerCase() === "all") {
    itemsToSell = inventory.filter(i => i.sellPrice > 0);
  } else {
    const match = inventory.find(i => i.item_id === target || i.name.includes(target));
    if (match && match.sellPrice > 0) itemsToSell = [match];
  }

  if (itemsToSell.length === 0) {
    await interaction.reply({ content: "❌ 판매 가능한 아이템이 없거나 해당 아이템을 찾을 수 없습니다.", flags: MessageFlags.Ephemeral });
    return;
  }

  let totalEarned = 0;
  const lines = [];

  for (const item of itemsToSell) {
    const earned = item.sellPrice * item.quantity;
    totalEarned += earned;
    await EconomyService.updateInventory(userId, item.item_id, -item.quantity);
    lines.push(`• **${item.name}** ×${item.quantity} → **+${earned.toLocaleString()}** 코인`);
  }

  await EconomyService.updateCoins(userId, totalEarned);
  const newBalance = (await EconomyService.getOrCreateUser(userId)).coins;

  const notices = await progressAndCheck(userId, "work");

  const embed = new EmbedBuilder()
    .setColor(0xFF8C00)
    .setTitle("💰 판매 완료!")
    .setDescription(
      lines.join("\n") +
      `\n\n합계: **+${totalEarned.toLocaleString()}** ${ECONOMY_CONFIG.currencyEmoji}` +
      `\n현재 잔액: **${newBalance.toLocaleString()}** 코인` +
      notices
    )
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

// ─── 13. 랭킹 ────────────────────────────────────────────────────────────────
async function handleRanking(interaction) {
  const list = await EconomyService.getRankings(10);

  if (list.length === 0) {
    await interaction.reply({ content: "아직 경제 활동을 등록한 멤버가 없습니다." });
    return;
  }

  const rankEmojis = ["🥇", "🥈", "🥉"];
  const lines = list.map((entry, i) =>
    `${rankEmojis[i] ?? `\`${i + 1}위\``} <@${entry.user_id}> — **${entry.coins.toLocaleString()}** 코인`
  );

  const embed = new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle("🏆 서버 코인 랭킹 TOP 10")
    .setDescription(lines.join("\n"))
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

// ─── 14. 업적 ────────────────────────────────────────────────────────────────
async function handleAchievements(interaction, userId) {
  const unlocked = await EconomyQuestService.getUnlockedAchievements(userId);
  const unlockedIds = new Set(unlocked.map(u => u.achievement_id));

  const lines = ECONOMY_CONFIG.achievements.map(ach => {
    const done = unlockedIds.has(ach.id);
    const mark = done ? "✅" : "❌";
    return `${mark} **${ach.name}**\n*${ach.description}* — 보상 **${ach.reward.toLocaleString()}** 코인`;
  });

  const embed = new EmbedBuilder()
    .setColor(0xEE82EE)
    .setTitle(`🏆 ${interaction.user.displayName}님의 업적`)
    .setDescription(
      `달성: **${unlocked.length}** / **${ECONOMY_CONFIG.achievements.length}**\n\n` +
      lines.join("\n\n")
    )
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

// ─── 15. 일일 퀘스트 ─────────────────────────────────────────────────────────
async function handleQuests(interaction, userId) {
  const quests = await EconomyQuestService.getDailyQuests(userId);

  const descLines = quests.map(q => {
    let status;
    if (q.completed) {
      status = "✅ 완료 (보상 수령됨)";
    } else if (q.progress >= q.target) {
      status = "🎁 목표 달성! 보상을 받으세요";
    } else {
      status = `🏃 진행 중 (${q.progress}/${q.target})`;
    }
    return (
      `🎯 **${q.name}**\n` +
      `*${q.description}*\n` +
      `보상: **${q.reward.toLocaleString()}** 코인 | 상태: ${status}`
    );
  });

  // 보상 수령 가능한 퀘스트가 있으면 버튼 추가
  const claimableQuests = quests.filter(q => q.progress >= q.target && !q.completed);
  const rows = [];

  // 버튼은 한 row에 최대 5개, quest가 많아도 안전하게 처리
  if (claimableQuests.length > 0) {
    const row = new ActionRowBuilder();
    for (const q of claimableQuests.slice(0, 5)) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`claim_quest:${q.quest_id}:${userId}`)
          .setLabel(`${q.name} 보상 수령`)
          .setStyle(ButtonStyle.Success)
      );
    }
    rows.push(row);
  }

  const embed = new EmbedBuilder()
    .setColor(0x1E90FF)
    .setTitle("🎯 오늘의 일일 퀘스트")
    .setDescription(descLines.join("\n\n"))
    .setFooter({ text: "퀘스트는 매일 자정(KST)에 초기화됩니다." })
    .setTimestamp();

  await interaction.reply({
    embeds: [embed],
    components: rows,
  });
}

// ─── 16. 레이드 설정 ─────────────────────────────────────────────────────────
async function handleRaidConfig(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const isAdmin = interaction.member?.permissions.has(PermissionFlagsBits.Administrator) ||
    interaction.member?.permissions.has(PermissionFlagsBits.ManageGuild);
  if (!isAdmin) {
    await interaction.editReply({ content: "❌ 레이드 설정은 서버 소유자 또는 관리자만 할 수 있어요." });
    return;
  }

  const channel = interaction.options.getChannel("채널");
  if (!channel) {
    await interaction.editReply({ content: "❌ 채널을 선택해주세요." });
    return;
  }

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.editReply({ content: "❌ 서버에서만 사용할 수 있는 명령어입니다." });
    return;
  }

  const webUrl = (process.env.WEB_APP_URL || "http://localhost:3000").replace(/\/$/, "");
  let saved = false;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${webUrl}/api/raid/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guild_id: guildId, channel_id: channel.id }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.ok) saved = true;
  } catch (e) {
    console.error("Raid config web API failed:", e.message);
  }

  if (!saved) {
    try {
      const { db } = await import("../services/database.js");
      await db.run(
        `INSERT INTO raid_config (guild_id, channel_id, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (guild_id) DO UPDATE SET channel_id = $2, updated_at = NOW()`,
        [guildId, channel.id]
      );
      saved = true;
    } catch (e2) {
      console.error("Raid config DB save failed:", e2.message);
    }
  }

  const embed = new EmbedBuilder()
    .setColor(0x5ce4ff)
    .setTitle("⚔️ 레이드 알림 설정 완료")
    .setDescription(
      `보스 레이드 출현 알림이 <#${channel.id}> 채널로 설정되었습니다.\n\n` +
      `이제 보스가 출현하면 해당 채널로 알림이 전송됩니다.\n` +
      `설정을 변경하려면 다시 \`/레이드설정\` 명령어를 사용하세요.`
    )
    .addFields(
      { name: "📡 알림 채널", value: `<#${channel.id}>`, inline: true },
      { name: "🎯 알림 종류", value: "출현 알림 / HP 현황 / 처치 결과", inline: true },
    )
    .setFooter({ text: "FLUX 레이드 시스템" })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleRaidDeactivate(interaction) {
  await interaction.deferReply();

  const isAdmin = interaction.member?.permissions.has(PermissionFlagsBits.Administrator) ||
    interaction.member?.permissions.has(PermissionFlagsBits.ManageGuild);
  if (!isAdmin) {
    await interaction.editReply({ content: "❌ 레이드 설정은 서버 소유자 또는 관리자만 변경할 수 있어요." });
    return;
  }

  try {
    const { db } = await import("../services/database.js");
    await db.run("DELETE FROM raid_config WHERE guild_id = $1", [interaction.guildId]);

    const webUrl = (process.env.WEB_APP_URL || "http://localhost:3000").replace(/\/$/, "");
    try {
      await fetch(`${webUrl}/api/raid/config`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guild_id: interaction.guildId }),
        signal: AbortSignal.timeout(3000),
      });
    } catch (e) {
      // web API fallback
    }

    logInfo("raid_deactivated_slash", {
      guildId: interaction.guildId,
      guildName: interaction.guild?.name,
      userId: interaction.user.id,
    });
  } catch (e) {
    logError("raid_deactivate_slash", interaction.guildId, e);
    await interaction.editReply({ content: "❌ 레이드 비활성화 중 오류가 발생했습니다." });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0xf87171)
    .setTitle("⚔️ 레이드 비활성화")
    .setDescription("레이드 알림이 비활성화되었습니다.\n다시 활성화하려면 `/레이드_활성화` 명령어를 사용하세요.")
    .setFooter({ text: "FLUX 레이드 시스템" })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleRaidStatus(interaction) {
  await interaction.deferReply();

  try {
    const { db } = await import("../services/database.js");
    const row = await db.get("SELECT channel_id, updated_at FROM raid_config WHERE guild_id = $1", [interaction.guildId]);

    if (!row) {
      const embed = new EmbedBuilder()
        .setColor(0x888888)
        .setTitle("⚔️ 레이드 설정")
        .setDescription(
          "이 서버는 레이드가 **비활성화**되어 있어요.\n" +
          `활성화하려면 \`/레이드_활성화\` 명령어를 사용하세요.`
        )
        .setFooter({ text: "FLUX 레이드 시스템" })
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    const channel = interaction.guild.channels.cache.get(row.channel_id);
    const channelMention = channel ? `${channel}` : `<#${row.channel_id}>`;

    const embed = new EmbedBuilder()
      .setColor(0x5ce4ff)
      .setTitle("⚔️ 레이드 설정")
      .addFields(
        { name: "상태", value: "✅ 활성화", inline: true },
        { name: "공지 채널", value: channelMention, inline: true },
        { name: "등록일", value: row.updated_at || "알 수 없음", inline: false },
      )
      .setDescription("매일 오후 10시에 보스가 출현하고, 홈페이지에서 레이드에 참여할 수 있어요.")
      .setFooter({ text: "FLUX 레이드 시스템" })
      .setTimestamp();
    await interaction.editReply({ embeds: [embed] });
  } catch (e) {
    logError("raid_status_slash", interaction.guildId, e);
    await interaction.editReply({ content: "❌ 설정 확인 중 오류가 발생했습니다." });
  }
}

// ─── 17. 레이드 테스트 (개발자 전용) ──────────────────────────────────────────
async function handleRaidTest(interaction) {
  if (interaction.user.id !== ADMIN_USER_ID) {
    await interaction.reply({ content: "❌ 이 명령어는 개발자만 사용할 수 있습니다.", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply();

  const hp = interaction.options.getInteger("hp") || 10000;
  const bossName = interaction.options.getString("이름") || "테스트 보스";
  const rewardPool = Math.floor(hp * 0.3);

  const webUrl = getWebGameUrl();
  const secret = process.env.WEBHOOK_SECRET || "";

  try {
    const res = await fetch(`${webUrl}/api/raid/spawn-global`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        maxHp: hp,
        bossName,
        rewardPool,
        guildIds: [],
        secret,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      const text = await res.text();
      await interaction.editReply({ content: `❌ 레이드 소환 실패 (HTTP ${res.status}): ${text}` });
      return;
    }

    const data = await res.json();
    if (!data.spawned) {
      await interaction.editReply({ content: "❌ 레이드 소환에 실패했습니다. 이미 활성화된 레이드가 있는지 확인하세요." });
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0x5ce4ff)
      .setTitle("⚔️ 테스트 레이드 소환 완료!")
      .setDescription(
        `**${bossName}**이(가) 소환되었습니다!\n\n` +
        `> HP: ${hp.toLocaleString()}\n` +
        `> 보상 풀: ${rewardPool.toLocaleString()} 코인\n` +
        `> 소환자: ${interaction.user.tag}\n\n` +
        `🌐 홈페이지에서 공격하세요!\n${webUrl}/raid`
      )
      .setFooter({ text: "FLUX 레이드 시스템 • 개발자 전용" })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });

    logInfo("raid_test_spawned", {
      userId: interaction.user.id,
      bossName,
      hp,
      rewardPool,
    });
  } catch (e) {
    logError("raid_test_spawn", null, e);
    await interaction.editReply({ content: `❌ 레이드 소환 중 오류 발생: ${e.message}` });
  }
}

const KNOWN_CROPS = [
  { id: "wheat", name: "밀" }, { id: "carrot", name: "당근" }, { id: "potato", name: "감자" },
  { id: "tomato", name: "토마토" }, { id: "strawberry", name: "딸기" }, { id: "blueberry", name: "블루베리" },
  { id: "pumpkin", name: "호박" }, { id: "golden_corn", name: "황금 옥수수" }, { id: "magic_bean", name: "마법 콩" },
  { id: "flux_fruit", name: "플럭스 열매" }, { id: "nightshade", name: "야광 버섯" }, { id: "time_flower", name: "시간의 꽃" },
  { id: "cosmic_gem", name: "코스믹 젬" },
];

function getCropIdFromName(input) {
  const direct = KNOWN_CROPS.find(c => c.id === input);
  if (direct) return direct.id;
  const byName = KNOWN_CROPS.find(c => c.name === input || input.includes(c.name));
  return byName?.id || null;
}

// ─── 18. 농장알림 (Crop Notification) ─────────────────────────────────────────
async function handleCropNotification(interaction, userId) {
  const subcommand = interaction.options.getSubcommand();
  const tier = await getUserSubscriptionTier(userId);

  if (tier !== "premium") {
    await interaction.reply({
      content: "❌ 작물 수확 알림은 **Premium** 등급 이상만 사용할 수 있습니다.\n`!FLUX 등급 구매` 명령어로 업그레이드하세요!",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  switch (subcommand) {
    case "추가": return await handleNotifAdd(interaction, userId);
    case "제거": return await handleNotifRemove(interaction, userId);
    case "목록": return await handleNotifList(interaction, userId);
    case "전체활성화": return await handleNotifEnableAll(interaction, userId);
    case "전체비활성화": return await handleNotifDisableAll(interaction, userId);
    default:
      await interaction.reply({ content: "❌ 알 수 없는 하위 명령어입니다.", flags: MessageFlags.Ephemeral });
  }
}

async function handleNotifAdd(interaction, userId) {
  const cropInput = interaction.options.getString("작물");
  const cropId = getCropIdFromName(cropInput);
  if (!cropId) {
    await interaction.reply({
      content: `❌ \`${cropInput}\`에 해당하는 작물을 찾을 수 없습니다.\n작물 이름: 밀, 당근, 감자, 토마토, 딸기, 블루베리, 호박, 황금 옥수수, 마법 콩, 플럭스 열매, 야광 버섯, 시간의 꽃, 코스믹 젬`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await db.run(
    `INSERT INTO crop_notification_settings (user_id, crop_id, enabled)
     VALUES ($1, $2, 1)
     ON CONFLICT (user_id, crop_id) DO UPDATE SET enabled = 1`,
    [userId, cropId]
  );

  await interaction.reply({ content: `✅ **${getCropName(cropId)}** 수확 알림이 켜졌습니다.`, flags: MessageFlags.Ephemeral });
}

async function handleNotifRemove(interaction, userId) {
  const cropInput = interaction.options.getString("작물");
  const cropId = getCropIdFromName(cropInput);
  if (!cropId) {
    await interaction.reply({ content: "❌ 해당 작물을 찾을 수 없습니다.", flags: MessageFlags.Ephemeral });
    return;
  }

  await db.run(
    "DELETE FROM crop_notification_settings WHERE user_id = $1 AND crop_id = $2",
    [userId, cropId]
  );

  await interaction.reply({ content: `✅ **${getCropName(cropId)}** 수확 알림이 제거되었습니다.`, flags: MessageFlags.Ephemeral });
}

async function handleNotifList(interaction, userId) {
  const rows = await db.all(
    "SELECT crop_id FROM crop_notification_settings WHERE user_id = $1 AND enabled = 1 ORDER BY crop_id",
    [userId]
  );

  if (rows.length === 0) {
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x888888)
        .setTitle("🌾 농장 알림 설정")
        .setDescription("현재 알림이 설정된 작물이 없습니다.\n`/농장알림 추가 [작물]` 로 알림을 추가하세요.")],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const lines = rows.map(r => `• **${getCropName(r.crop_id)}** (\`${r.crop_id}\`)`);
  const embed = new EmbedBuilder()
    .setColor(0x4CC9F0)
    .setTitle("🌾 농장 알림 설정된 작물")
    .setDescription(lines.join("\n"))
    .setFooter({ text: "작물이 수확 가능해지면 DM으로 알려드립니다." })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleNotifEnableAll(interaction, userId) {
  for (const crop of KNOWN_CROPS) {
    await db.run(
      `INSERT INTO crop_notification_settings (user_id, crop_id, enabled)
       VALUES ($1, $2, 1)
       ON CONFLICT (user_id, crop_id) DO UPDATE SET enabled = 1`,
      [userId, crop.id]
    );
  }
  await interaction.reply({ content: "✅ 모든 작물에 대한 수확 알림이 켜졌습니다.", flags: MessageFlags.Ephemeral });
}

async function handleNotifDisableAll(interaction, userId) {
  await db.run(
    "DELETE FROM crop_notification_settings WHERE user_id = $1",
    [userId]
  );
  await interaction.reply({ content: "✅ 모든 작물에 대한 수확 알림이 꺼졌습니다.", flags: MessageFlags.Ephemeral });
}

function getCropName(cropId) {
  return KNOWN_CROPS.find(c => c.id === cropId)?.name || cropId;
}
