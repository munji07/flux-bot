import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { EconomyService } from "../services/economyService.js";
import { EconomyQuestService } from "../services/economyQuestService.js";
import { ECONOMY_CONFIG } from "../config/economyConfig.js";
import { getUserSubscriptionTier } from "../services/subscription.js";
import { logError } from "../logger.js";

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
  const newlyCompleted = EconomyQuestService.incrementProgress(userId, actionType);
  if (newlyCompleted.length > 0) {
    notices += `\n\n🎯 **퀘스트 달성!** \`${newlyCompleted.join(", ")}\` — \`/퀘스트\` 에서 보상을 받으세요!`;
  }

  // 자산가 업적 (10,000코인 이상 보유)
  const user = EconomyService.getOrCreateUser(userId);
  if (user.coins >= 10000) {
    const unlocked = await EconomyQuestService.checkAndUnlockAchievement(userId, "earn_10k");
    if (unlocked) {
      const def = ECONOMY_CONFIG.achievements.find(a => a.id === "earn_10k");
      notices += `\n🏆 **업적 달성!** [${def.name}] (+${def.reward.toLocaleString()} 코인)`;
    }
  }

  return notices;
}

// ─── 명령어 핸들러 ────────────────────────────────────────────────────────────

export async function handleEconomyCommand(interaction) {
  const { commandName, user } = interaction;
  const userId = user.id;

  try {
    switch (commandName) {
      case "돈":        return await handleBalance(interaction, userId);
      case "송금":      return await handleTransfer(interaction, userId);
      case "일출":      return await handleDaily(interaction, userId);
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
    }
  } catch (error) {
    logError("economy_command", interaction.guildId, error, {
      commandName,
      userId,
    });
    const method = interaction.replied || interaction.deferred ? "followUp" : "reply";
    await interaction[method]({
      content: "❌ 명령 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
      ephemeral: true,
    }).catch(() => {});
  }
}

// ─── 1. 잔액 조회 ─────────────────────────────────────────────────────────────
async function handleBalance(interaction, userId) {
  const userData = EconomyService.getOrCreateUser(userId);
  const { user } = interaction;

  // 코인 순위
  const rankings = EconomyService.getRankings(100);
  const rankPos = rankings.findIndex(r => r.user_id === userId) + 1;
  const rankText = rankPos > 0 ? `${rankPos}위` : "순위권 밖";

  // 등급 및 수수료
  const tier = getUserSubscriptionTier(userId);
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
    .setFooter({ text: "낚시, 채굴, 농사로 코인을 모아보세요! | 프리미엄 등급은 송금 수수료가 없어요." })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

// ─── 2. 송금 ──────────────────────────────────────────────────────────────────
async function handleTransfer(interaction, userId) {
  const targetUser = interaction.options.getUser("대상");
  const amount = interaction.options.getInteger("금액");

  if (targetUser.bot) {
    await interaction.reply({ content: "❌ 봇에게는 송금할 수 없습니다.", ephemeral: true });
    return;
  }

  // 수수료 미리 계산 (안내용)
  const tier = getUserSubscriptionTier(userId);
  const feeRate = ECONOMY_CONFIG.transferFee[tier] ?? ECONOMY_CONFIG.transferFee.free;
  const expectedFee = Math.floor(amount * feeRate);

  const result = EconomyService.transferCoins(userId, targetUser.id, amount);
  if (!result.success) {
    await interaction.reply({ content: `❌ 송금 실패: ${result.errorMessage}`, ephemeral: true });
    return;
  }

  const receiverData = EconomyService.getOrCreateUser(targetUser.id);
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
  const cooldown = EconomyService.checkAndSetCooldown(userId, "daily");
  if (cooldown.isCooldown) {
    await interaction.reply({
      content: `⏰ 이미 오늘의 보상을 수령했습니다. 다음 수령까지 **${formatTime(cooldown.remaining)}** 남았습니다.`,
      ephemeral: true,
    });
    return;
  }

  const rewardCoins = 1000;
  EconomyService.updateCoins(userId, rewardCoins);

  const notices = await progressAndCheck(userId, "daily");

  // 성실한 하루 업적
  const firstDailyUnlocked = await EconomyQuestService.checkAndUnlockAchievement(userId, "first_daily");
  let achievementNotice = "";
  if (firstDailyUnlocked) {
    const def = ECONOMY_CONFIG.achievements.find(a => a.id === "first_daily");
    achievementNotice = `\n🏆 **업적 달성!** [${def.name}] - ${def.description} (+${def.reward.toLocaleString()} 코인)`;
  }

  const currentBalance = EconomyService.getOrCreateUser(userId).coins;

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
  const userData = EconomyService.getOrCreateUser(userId);

  if (userData.coins < cost) {
    await interaction.reply({
      content: `❌ 코인이 부족합니다. 슬롯머신 플레이에는 **${cost.toLocaleString()}** 코인이 필요합니다.`,
      ephemeral: true,
    });
    return;
  }

  EconomyService.updateCoins(userId, -cost);

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

  if (reward > 0) EconomyService.updateCoins(userId, reward);

  const currentBalance = EconomyService.getOrCreateUser(userId).coins;
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

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle("🎰 슬롯머신")
    .setDescription(
      `## ┃ ${s[0]} ┃ ${s[1]} ┃ ${s[2]} ┃\n\n` +
      resultLine +
      `\n현재 잔액: **${currentBalance.toLocaleString()}** 코인` +
      notices + achievementNotice
    )
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

// ─── 5. 주사위 ────────────────────────────────────────────────────────────────
async function handleDice(interaction, userId) {
  const bet = interaction.options.getInteger("배팅금");
  const { maxBet, winMultiplier } = ECONOMY_CONFIG.dice;

  if (bet > maxBet) {
    await interaction.reply({
      content: `❌ 최대 배팅금은 **${maxBet.toLocaleString()}** 코인입니다.`,
      ephemeral: true,
    });
    return;
  }

  const userData = EconomyService.getOrCreateUser(userId);
  if (userData.coins < bet) {
    await interaction.reply({ content: "❌ 보유 코인이 배팅금보다 적습니다.", ephemeral: true });
    return;
  }

  EconomyService.updateCoins(userId, -bet);

  const myRoll  = Math.floor(Math.random() * 6) + 1;
  const botRoll = Math.floor(Math.random() * 6) + 1;

  let reward = 0;
  let resultLine = "";
  let color = 0x888888;

  if (myRoll > botRoll) {
    reward = Math.floor(bet * winMultiplier);
    resultLine = `🎉 **승리!** x${winMultiplier} = **+${reward.toLocaleString()}** 코인`;
    color = 0x00FF00;
  } else if (myRoll < botRoll) {
    resultLine = "💀 **패배...** 배팅금을 잃었습니다.";
    color = 0xFF0000;
  } else {
    reward = bet;
    resultLine = "🤝 **무승부!** 배팅금을 돌려받습니다.";
    color = 0x888888;
  }

  if (reward > 0) EconomyService.updateCoins(userId, reward);

  const currentBalance = EconomyService.getOrCreateUser(userId).coins;
  const notices = await progressAndCheck(userId, "gamble");

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle("🎲 주사위 대결")
    .addFields(
      { name: "🧑 나의 주사위", value: `**${myRoll}**`, inline: true },
      { name: "🤖 봇의 주사위", value: `**${botRoll}**`, inline: true },
    )
    .setDescription(
      `\n${resultLine}\n현재 잔액: **${currentBalance.toLocaleString()}** 코인` + notices
    )
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

// ─── 6. 동전 던지기 ───────────────────────────────────────────────────────────
async function handleCoinflip(interaction, userId) {
  const pick = interaction.options.getString("선택");
  const bet  = interaction.options.getInteger("배팅금");
  const { maxBet, winMultiplier } = ECONOMY_CONFIG.coinflip;

  if (bet > maxBet) {
    await interaction.reply({
      content: `❌ 최대 배팅금은 **${maxBet.toLocaleString()}** 코인입니다.`,
      ephemeral: true,
    });
    return;
  }

  const userData = EconomyService.getOrCreateUser(userId);
  if (userData.coins < bet) {
    await interaction.reply({ content: "❌ 보유 코인이 배팅금보다 적습니다.", ephemeral: true });
    return;
  }

  EconomyService.updateCoins(userId, -bet);

  const result   = Math.random() < 0.5 ? "front" : "back";
  const resultKo = result === "front" ? "앞면 🟡" : "뒷면 ⚪";
  const pickKo   = pick   === "front" ? "앞면 🟡" : "뒷면 ⚪";

  let reward = 0;
  let resultLine = "";
  let color = 0xFF0000;

  if (pick === result) {
    reward = Math.floor(bet * winMultiplier);
    resultLine = `🎉 **적중!** x${winMultiplier} = **+${reward.toLocaleString()}** 코인`;
    color = 0x00FF00;
  } else {
    resultLine = `💀 **오답!** 배팅금을 잃었습니다.`;
  }

  if (reward > 0) EconomyService.updateCoins(userId, reward);

  const currentBalance = EconomyService.getOrCreateUser(userId).coins;
  const notices = await progressAndCheck(userId, "gamble");

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

  await interaction.reply({ embeds: [embed] });
}

// ─── 7. 낚시 ─────────────────────────────────────────────────────────────────
async function handleFishing(interaction, userId) {
  const cooldown = EconomyService.checkAndSetCooldown(userId, "fishing");
  if (cooldown.isCooldown) {
    await interaction.reply({
      content: `⏰ 낚싯줄이 엉켰습니다. **${formatTime(cooldown.remaining)}** 후에 다시 시도하세요.`,
      ephemeral: true,
    });
    return;
  }

  const success = Math.random() < ECONOMY_CONFIG.fishing.successRate;
  if (!success) {
    await interaction.reply({
      content: "🎣 물고기가 미끼를 물었다가 도망쳤습니다! 낚시에 실패했습니다.",
    });
    return;
  }

  const item = drawReward(ECONOMY_CONFIG.fishing.rewards);
  EconomyService.updateInventory(userId, item.id, 1);

  const notices = await progressAndCheck(userId, "work");

  // 황금 잉어 업적
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

  const embed = new EmbedBuilder()
    .setColor(rarityColor[item.id] ?? 0x00FFFF)
    .setTitle("🎣 낚시 성공!")
    .setDescription(
      `바다에서 무언가를 낚아 올렸습니다!\n\n` +
      `✨ **${item.name}** (1개)\n` +
      `*${item.description}*\n` +
      `판매가: **${item.sellPrice.toLocaleString()}** 코인` +
      notices + achievementNotice
    )
    .setFooter({ text: `쿨다운: ${formatTime(ECONOMY_CONFIG.cooldowns.fishing)}` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

// ─── 8. 채굴 ─────────────────────────────────────────────────────────────────
async function handleMining(interaction, userId) {
  const cooldown = EconomyService.checkAndSetCooldown(userId, "mining");
  if (cooldown.isCooldown) {
    await interaction.reply({
      content: `⏰ 피로가 풀리지 않았습니다. **${formatTime(cooldown.remaining)}** 후에 다시 시도하세요.`,
      ephemeral: true,
    });
    return;
  }

  const success = Math.random() < ECONOMY_CONFIG.mining.successRate;
  if (!success) {
    await interaction.reply({ content: "⛏️ 헛스윙! 돌만 부서졌습니다. 채굴에 실패했습니다." });
    return;
  }

  const item = drawReward(ECONOMY_CONFIG.mining.rewards);
  EconomyService.updateInventory(userId, item.id, 1);

  const notices = await progressAndCheck(userId, "work");

  // 고대 잔해 업적
  let achievementNotice = "";
  if (item.id === "ore_netherite") {
    const unlocked = await EconomyQuestService.checkAndUnlockAchievement(userId, "mine_netherite");
    if (unlocked) {
      const def = ECONOMY_CONFIG.achievements.find(a => a.id === "mine_netherite");
      achievementNotice = `\n🏆 **업적 달성!** [${def.name}] - ${def.description} (+${def.reward.toLocaleString()} 코인)`;
    }
  }

  const rarityColor = {
    ore_netherite: 0xFF4500,
    ore_diamond:   0x00BFFF,
    ore_gold:      0xFFD700,
    ore_iron:      0xA9A9A9,
    ore_coal:      0x444444,
  };

  const embed = new EmbedBuilder()
    .setColor(rarityColor[item.id] ?? 0x8F8F8F)
    .setTitle("⛏️ 채굴 성공!")
    .setDescription(
      `광산 깊숙이 들어가 광석을 캐냈습니다!\n\n` +
      `✨ **${item.name}** (1개)\n` +
      `*${item.description}*\n` +
      `판매가: **${item.sellPrice.toLocaleString()}** 코인` +
      notices + achievementNotice
    )
    .setFooter({ text: `쿨다운: ${formatTime(ECONOMY_CONFIG.cooldowns.mining)}` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

// ─── 9. 농사 ─────────────────────────────────────────────────────────────────
async function handleFarming(interaction, userId) {
  const cooldown = EconomyService.checkAndSetCooldown(userId, "farming");
  if (cooldown.isCooldown) {
    await interaction.reply({
      content: `⏰ 작물이 아직 자라고 있습니다. **${formatTime(cooldown.remaining)}** 후에 다시 시도하세요.`,
      ephemeral: true,
    });
    return;
  }

  const success = Math.random() < ECONOMY_CONFIG.farming.successRate;
  if (!success) {
    await interaction.reply({ content: "🌾 새들이 작물을 쪼아먹었습니다. 농사에 실패했습니다!" });
    return;
  }

  const item = drawReward(ECONOMY_CONFIG.farming.rewards);
  EconomyService.updateInventory(userId, item.id, 1);

  const notices = await progressAndCheck(userId, "work");

  const rarityColor = {
    crop_ginseng: 0x228B22,
    crop_melon:   0x32CD32,
    crop_potato:  0xCD853F,
    crop_carrot:  0xFF8C00,
    crop_wheat:   0xDAA520,
  };

  const embed = new EmbedBuilder()
    .setColor(rarityColor[item.id] ?? 0xD2B48C)
    .setTitle("🌾 농사 성공!")
    .setDescription(
      `정성껏 가꾼 밭에서 훌륭한 작물을 수확했습니다!\n\n` +
      `✨ **${item.name}** (1개)\n` +
      `*${item.description}*\n` +
      `판매가: **${item.sellPrice.toLocaleString()}** 코인` +
      notices
    )
    .setFooter({ text: `쿨다운: ${formatTime(ECONOMY_CONFIG.cooldowns.farming)}` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

// ─── 10. 인벤토리 ────────────────────────────────────────────────────────────
async function handleInventory(interaction, userId) {
  const inv = EconomyService.getInventory(userId);

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
    await interaction.reply({ content: "❌ 존재하지 않는 아이템입니다.", ephemeral: true });
    return;
  }

  const { coins } = EconomyService.getOrCreateUser(userId);
  if (coins < targetItem.price) {
    await interaction.reply({
      content: `❌ 코인이 부족합니다. **${targetItem.price.toLocaleString()}** 코인이 필요하지만 **${coins.toLocaleString()}** 코인만 보유 중입니다.`,
      ephemeral: true,
    });
    return;
  }

  EconomyService.updateCoins(userId, -targetItem.price);
  EconomyService.updateInventory(userId, targetItem.id, 1);

  const newBalance = EconomyService.getOrCreateUser(userId).coins;

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
  const inventory = EconomyService.getInventory(userId);

  if (inventory.length === 0) {
    await interaction.reply({ content: "❌ 판매할 아이템이 없습니다.", ephemeral: true });
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
    await interaction.reply({ content: "❌ 판매 가능한 아이템이 없거나 해당 아이템을 찾을 수 없습니다.", ephemeral: true });
    return;
  }

  let totalEarned = 0;
  const lines = [];

  for (const item of itemsToSell) {
    const earned = item.sellPrice * item.quantity;
    totalEarned += earned;
    EconomyService.updateInventory(userId, item.item_id, -item.quantity);
    lines.push(`• **${item.name}** ×${item.quantity} → **+${earned.toLocaleString()}** 코인`);
  }

  EconomyService.updateCoins(userId, totalEarned);
  const newBalance = EconomyService.getOrCreateUser(userId).coins;

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
  const list = EconomyService.getRankings(10);

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
  const unlocked = EconomyQuestService.getUnlockedAchievements(userId);
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
  const quests = EconomyQuestService.getDailyQuests(userId);

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
