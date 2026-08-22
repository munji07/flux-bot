import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { ADMIN_USER_ID } from "../config.js";
import { addServerImageToken, extendUserSubscription, getKstNow, getServerSubscriptionTier, syncTierRole, updateDonationAmount } from "../services/subscription.js";
import { createScheduledMessage } from "../services/scheduler.js";
import { parseScheduleTime, scheduleChannelMap } from "../commands/scheduler.js";
import { db } from "../services/database.js";
import { logError } from "../logger.js";
import { handleEconomyCommand, handleFishingCatch } from "./economyHandler.js";
import { handleAddWordCommand, handleLookupWordCommand, handleRemoveWordCommand, handleWordChainCommand, handleAnalyzeCommand } from "../services/gameManager.js";
import { EconomyQuestService } from "../services/economyQuestService.js";
import { handleNameChangeSlashCommand, handleNameResetSlashCommand } from "../commands/userSettings.js";

const SERVER_TOKEN_LABELS = {
  image_readings: "서버 이미지 검토 토큰",
  image_generations: "서버 이미지 생성 토큰",
  video_analysis: "서버 비디오 판독 토큰",
};

const SERVER_TOKEN_PRICES = {
  image_readings: 100,
  image_generations: 500,
};

/**
 * 디스코드 Interaction(버튼 클릭 등) 이벤트를 처리합니다.
 * @param {import("discord.js").Client} client
 * @param {import("discord.js").Interaction} interaction
 */
export async function handleInteractionCreate(client, interaction) {
  // ── 슬래시 명령어 처리 ────────────────────────────────────────────────────
  if (interaction.isChatInputCommand()) {
    try {
      if (interaction.commandName === "단어추가") {
        await handleAddWordCommand(interaction);
      } else if (interaction.commandName === "단어조회") {
        await handleLookupWordCommand(interaction);
      } else if (interaction.commandName === "단어제거") {
        await handleRemoveWordCommand(interaction);
      } else if (interaction.commandName === "끝말잇기") {
        const subcommand = interaction.options.getSubcommand();
        if (subcommand === "분석") {
          await handleAnalyzeCommand(interaction);
        } else {
          const difficulty = interaction.options.getString("난이도") || "normal";
          const opponent = interaction.options.getUser("상대")?.id ?? null;
          const userStarts = interaction.options.getBoolean("유저부터") ?? false;
          await handleWordChainCommand(interaction, difficulty, opponent, userStarts);
        }
      } else if (interaction.commandName === "이름변경") {
        await handleNameChangeSlashCommand(interaction);
      } else if (interaction.commandName === "이름초기화") {
        await handleNameResetSlashCommand(interaction);
      } else {
        await handleEconomyCommand(interaction);
      }
    } catch (err) {
      logError("slash_command_execution_failed", interaction.guildId, err, {
        commandName: interaction.commandName,
        userId: interaction.user?.id,
      });
      const replyMethod = interaction.replied || interaction.deferred ? "followUp" : "reply";
      await interaction[replyMethod]({
        content: "❌ 명령어를 실행하는 중 내부 오류가 발생했습니다.",
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }
    return;
  }

  // ── 일일 퀘스트 보상 수령 버튼 ───────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("claim_quest:")) {
    const [, questId, userId] = interaction.customId.split(":");
    if (interaction.user.id !== userId) {
      await interaction.reply({ content: "❌ 본인의 퀘스트 보상만 수령할 수 있습니다.", flags: MessageFlags.Ephemeral });
      return;
    }

    const result = await EconomyQuestService.claimQuestReward(userId, questId);
    if (!result.success) {
      await interaction.reply({ content: `❌ 수령 실패: ${result.message}`, flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.reply({ content: `🎉 보상 수령 성공! **+${result.reward.toLocaleString()}** 코인을 획득했습니다!` });
    return;
  }

  // ── AI 채널 카테고리 선택 메뉴 ───────────────────────────────────────────
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("ai_channel_create_category:")) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
      await interaction.reply({
        content: "❌ 채널 관리 권한(`ManageChannels`)이 없어 AI 전용 채널을 생성할 수 없습니다.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const channelName = interaction.customId.split(":")[1] || "ai-전용-채널";
    const categoryId = interaction.values[0];

    try {
      const parent = interaction.guild.channels.cache.get(categoryId);
      const newChan = await interaction.guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: categoryId,
        rateLimitPerUser: 10,
      });

      await db.run("INSERT INTO ai_channels (channel_id, guild_id) VALUES ($1, $2) ON CONFLICT(channel_id) DO UPDATE SET guild_id = EXCLUDED.guild_id", [newChan.id, interaction.guildId]);

      await interaction.update({
        content: `✅ 카테고리 **${parent ? parent.name : "Unknown"}** 하위에 AI 전용 채널 ${newChan}을 생성했어요. (슬로우모드 10초가 적용되었습니다.)`,
        components: [],
      });
    } catch (error) {
      logError("ai_channel_create_interaction_failed", interaction.guildId, error);
      await interaction.reply({
        content: `❌ 채널 생성 중 오류가 발생했습니다: ${error.message}`,
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  // ── 예약 메시지 모달 제출 ────────────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId === "schedule_create_modal") {
    const tier = await getServerSubscriptionTier(interaction.guildId);
    if (tier !== "platinum") {
      await interaction.reply({
        content: "❌ 이 서버는 **플래티넘 서버(유료)** 권한이 없으므로 예약 기능을 사용할 수 없습니다. `!FLUX 플래티넘 서버 구매`를 입력해 등급을 업그레이드해 보세요!",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const timeInput = interaction.fields.getTextInputValue("schedule_time");
    const content = interaction.fields.getTextInputValue("schedule_content").trim();
    const parsed = parseScheduleTime(timeInput);

    if (!parsed || !content) {
      await interaction.reply({
        content: "예약 시간이나 메시지를 이해하지 못했어요. 예: `10분 뒤`, `내일 09:30`, `2026-06-20 18:30`",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const stored = scheduleChannelMap.get(interaction.user.id);
    scheduleChannelMap.delete(interaction.user.id);
    const storedChannelId = stored?.channelId;

    let channelTextInput;
    try { channelTextInput = interaction.fields.getTextInputValue("schedule_channel")?.trim(); } catch { channelTextInput = null; }
    let channelId = storedChannelId || interaction.channelId;
    if (!storedChannelId && channelTextInput) {
      const mentionMatch = channelTextInput.match(/^<#(\d+)>$/);
      const rawId = mentionMatch ? mentionMatch[1] : channelTextInput;
      if (/^\d{17,20}$/.test(rawId)) {
        const resolved = await interaction.guild.channels.fetch(rawId).catch(() => null);
        if (resolved && resolved.isTextBased()) channelId = resolved.id;
      } else {
        const byName = interaction.guild.channels.cache.find(
          c => c.isTextBased() && (c.name === channelTextInput || c.name.includes(channelTextInput))
        );
        if (byName) channelId = byName.id;
      }
    }

    const task = await createScheduledMessage({
      guildId: interaction.guildId,
      channelId,
      userId: interaction.user.id,
      content,
      executeAt: parsed.executeAt,
    });

    await interaction.reply({
      content: [
        "예약 메시지를 등록했어요.",
        `- ID: \`${task.id}\``,
        `- 시간: \`${task.execute_at} KST\``,
        `- 채널: <#${task.channel_id}>`,
      ].join("\n"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // ── 예약 채널 선택 메뉴 ──────────────────────────────────────────────────
  if (interaction.isChannelSelectMenu() && interaction.customId === "schedule_channel_select") {
    const channelId = interaction.values[0];
    scheduleChannelMap.set(interaction.user.id, { channelId, timestamp: Date.now() });

    const modal = new ModalBuilder().setCustomId("schedule_create_modal").setTitle("예약 메시지");

    const timeInput = new TextInputBuilder()
      .setCustomId("schedule_time")
      .setLabel("시간")
      .setPlaceholder("10분 뒤 / 내일 09:30 / 2026-06-20 18:30")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const contentInput = new TextInputBuilder()
      .setCustomId("schedule_content")
      .setLabel("메시지")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(1900);

    modal.addComponents(
      new ActionRowBuilder().addComponents(timeInput),
      new ActionRowBuilder().addComponents(contentInput),
    );

    await interaction.showModal(modal);
    return;
  }

  // ── 후원 금액 입력 모달 제출 ─────────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId.startsWith("donation_submit:")) {
    const userId = interaction.customId.split(":")[1];
    if (interaction.user.id !== userId) {
      await interaction.reply({ content: "본인의 후원만 접수할 수 있어요.", flags: MessageFlags.Ephemeral });
      return;
    }

    const amountText = interaction.fields.getTextInputValue("donation_amount").replace(/[^\d]/g, "");
    const amount = parseInt(amountText, 10);

    if (!Number.isInteger(amount) || amount <= 0) {
      await interaction.reply({
        content: "❌ 후원 금액을 올바른 숫자(원)로 입력해 주세요. 예: 5000",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const tier = amount >= 5000 ? "premium" : amount >= 3000 ? "basic" : null;
    const tierLabel = tier === "premium" ? "Premium" : tier === "basic" ? "Basic" : "등급 미해당 (3,000원 미만)";

    const now = getKstNow();
    const timeStr = `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
    const depositName = `${timeStr}-${userId}`;

    try {
      const developer = await client.users.fetch(ADMIN_USER_ID);
      if (developer) {
        let adminNotifyMsg = `🔔 **[후원 알림]**\n\n`;
        adminNotifyMsg += `- **후원자**: <@${userId}> (ID: \`${userId}\`)\n`;
        adminNotifyMsg += `- **후원 금액**: \`${amount.toLocaleString("ko-KR")}원\`\n`;
        adminNotifyMsg += `- **산정 등급**: \`${tierLabel}\`\n`;
        adminNotifyMsg += `- **입금자명**: \`${depositName}\`\n`;
        adminNotifyMsg += `- **신청 시간**: \`${timeStr}\`\n\n`;

        if (tier) {
          adminNotifyMsg += `*아래 버튼을 눌러 후원 등급 부여 또는 반려 처리를 진행하세요.*`;
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`admin_approve:${tier}:${userId}:${amount}`)
              .setLabel(`${tier.toUpperCase()} 부여`)
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(`admin_reject:${userId}`)
              .setLabel("반려 (거절)")
              .setStyle(ButtonStyle.Danger),
          );
          await developer.send({ content: adminNotifyMsg, components: [row] });
        } else {
          adminNotifyMsg += `*3,000원 미만 후원으로 등급 지급 대상이 아닙니다. (등급 기준: 3,000원 이상 Basic, 5,000원 이상 Premium)*`;
          await developer.send({ content: adminNotifyMsg });
        }
      }

      const tierLine = tier
        ? `- **지급 등급**: \`${tierLabel}\` (30일)`
        : `- **지급 등급**: 없음 (3,000원 이상부터 Basic, 5,000원 이상부터 Premium 등급이 지급됩니다)`;

      await interaction.reply({
        content: `✅ **후원 접수가 완료되었습니다.**\n\n- **후원 금액**: \`${amount.toLocaleString("ko-KR")}원\`\n- **입금자명**: \`${depositName}\`\n${tierLine}\n\n개발자가 입금을 확인한 뒤 등급을 부여해 드려요. 잠시만 기다려주세요! ✨`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      console.error("Error processing donation submit:", error);
      await interaction.reply({
        content: "❌ 후원 접수 처리 중 오류가 발생했습니다. 개발자에게 직접 문의해주세요.",
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }
    return;
  }

  // ── 이 이하는 버튼 전용 ───────────────────────────────────────────────────
  if (!interaction.isButton()) return;

  const { customId } = interaction;

  // 낚시 버튼 (랜덤 바이트 후 나타남)
  if (customId.startsWith("fish_catch:")) {
    const userId = customId.split(":")[1];
    if (interaction.user.id !== userId) {
      await interaction.reply({ content: "다른 사람의 낚시에 간섭할 수 없어요!", flags: MessageFlags.Ephemeral });
      return;
    }
    await handleFishingCatch(interaction, userId);
    return;
  }

  // 예약 메시지 모달 열기 버튼
  if (customId === "schedule_open_modal") {
    const tier = await getServerSubscriptionTier(interaction.guildId);
    if (tier !== "platinum") {
      await interaction.reply({
        content: "❌ 이 서버는 **플래티넘 서버(유료)** 권한이 없으므로 예약 기능을 사용할 수 없습니다. `!FLUX 플래티넘 서버 구매`를 입력해 등급을 업그레이드해 보세요!",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const modal = new ModalBuilder().setCustomId("schedule_create_modal").setTitle("예약 메시지");

    const timeInput = new TextInputBuilder()
      .setCustomId("schedule_time")
      .setLabel("시간")
      .setPlaceholder("10분 뒤 / 내일 09:30 / 2026-06-20 18:30")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const contentInput = new TextInputBuilder()
      .setCustomId("schedule_content")
      .setLabel("메시지")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(1900);

    const channelInput = new TextInputBuilder()
      .setCustomId("schedule_channel")
      .setLabel("채널 (선택)")
      .setPlaceholder("#채널명 입력 (비우면 현재 채널)")
      .setStyle(TextInputStyle.Short)
      .setRequired(false);

    modal.addComponents(
      new ActionRowBuilder().addComponents(timeInput),
      new ActionRowBuilder().addComponents(contentInput),
      new ActionRowBuilder().addComponents(channelInput),
    );

    await interaction.showModal(modal);
    return;
  }

  // 후원 금액 입력 모달 열기 버튼
  if (customId.startsWith("donation_open_modal:")) {
    const userId = customId.split(":")[1];
    if (interaction.user.id !== userId) {
      await interaction.reply({ content: "본인의 후원만 진행할 수 있어요.", flags: MessageFlags.Ephemeral });
      return;
    }

    const modal = new ModalBuilder().setCustomId(`donation_submit:${userId}`).setTitle("FLUX봇 후원 완료");

    const amountInput = new TextInputBuilder()
      .setCustomId("donation_amount")
      .setLabel("후원 금액 (원)")
      .setPlaceholder("예: 5000")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(amountInput));

    await interaction.showModal(modal);
    return;
  }

  // 1. 유저/서버 등급 구매 송금완료 버튼
  if (customId.startsWith("sub_complete:")) {
    const parts = customId.split(":");
    if (parts.length < 4) return;

    const [, tier, userId, timeStr, maybeGuildId] = parts;
    const isPlatinum = tier === "platinum";
    const guildId = maybeGuildId || "dm";
    const depositName = isPlatinum
      ? `${timeStr}-plat-${guildId !== "dm" ? guildId.slice(-4) : "dm"}`
      : `${timeStr}-${userId}`;
    const uppercaseTier = tier.toUpperCase();

    try {
      const developer = await client.users.fetch(ADMIN_USER_ID);
      if (developer) {
        let adminNotifyMsg = `🔔 **[${isPlatinum ? "플래티넘 서버" : "등급"} 구매 신청 알림]**\n\n`;
        adminNotifyMsg += `- **신청자**: <@${userId}> (ID: \`${userId}\`)\n`;
        adminNotifyMsg += `- **신청 등급**: \`${uppercaseTier}\`\n`;
        if (isPlatinum) adminNotifyMsg += `- **대상 길드 ID**: \`${guildId}\`\n`;
        adminNotifyMsg += `- **입금자명**: \`${depositName}\`\n`;
        adminNotifyMsg += `- **신청 시간**: \`${timeStr}\`\n\n`;
        adminNotifyMsg += `*아래 버튼을 눌러 입금 승인 또는 반려 처리를 진행하세요.*`;

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(isPlatinum ? `admin_approve_platinum:${guildId}:${userId}` : `admin_approve:${tier}:${userId}`)
            .setLabel(`${uppercaseTier} 승인`)
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(isPlatinum ? `admin_reject_platinum:${guildId}:${userId}` : `admin_reject:${userId}`)
            .setLabel("반려 (거절)")
            .setStyle(ButtonStyle.Danger),
        );

        await developer.send({ content: adminNotifyMsg, components: [row] });
      }

      await interaction.reply({
        content:
          `✅ **송금 완료 알림이 전송되었습니다.**\n\n` +
          `- **입금자명**: \`${depositName}\`\n` +
          `- **신청 등급**: \`${uppercaseTier}\`\n` +
          (isPlatinum ? `- **대상 길드 ID**: \`${guildId}\`\n` : "") +
          `\n개발자가 입금 확인 후 등급을 부여해 드립니다. 처리가 완료되면 DM으로 알려드릴게요! 잠시만 기다려주세요. ✨`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      console.error("Error processing sub_complete interaction:", error);
      await interaction.reply({
        content: "❌ 송금 완료 처리 중 오류가 발생했습니다. 개발자에게 직접 문의해주세요.",
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }
    return;
  }

  // 2. 서버 토큰 구매 완료 버튼
  if (customId.startsWith("server_token_complete:")) {
    const parts = customId.split(":");
    if (parts.length < 5) return;

    const [, type, guildId, userId, timeStr, countStr] = parts;
    const count = parseInt(countStr || "1", 10);
    const label = SERVER_TOKEN_LABELS[type];
    if (!label) {
      await interaction.reply({ content: "알 수 없는 서버 토큰 상품이에요.", flags: MessageFlags.Ephemeral });
      return;
    }

    const depositName = `${timeStr}-${count}-${guildId.slice(-4)}`;
    const price = SERVER_TOKEN_PRICES[type] * count;
    const guild = await client.guilds.fetch(guildId).catch(() => null);

    try {
      const developer = await client.users.fetch(ADMIN_USER_ID);
      if (developer) {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`server_token_approve:${type}:${guildId}:${userId}:${timeStr}:${count}`)
            .setLabel("승인")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`server_token_reject:${type}:${guildId}:${userId}`)
            .setLabel("반려")
            .setStyle(ButtonStyle.Danger),
        );

        await developer.send({
          content: [
            `**[${label} 구매 신청 알림]**`,
            "",
            `- 신청자: <@${userId}> (ID: \`${userId}\`)`,
            `- 서버: ${guild?.name ?? "알 수 없는 서버"} (ID: \`${guildId}\`)`,
            `- 상품: \`${label} ${count}개\``,
            `- 금액: \`${price.toLocaleString("ko-KR")}원\``,
            `- 입금자명: \`${depositName}\``,
            "",
            "아래 버튼으로 입금 승인 또는 반려 처리를 진행하세요.",
          ].join("\n"),
          components: [row],
        });
      }

      await interaction.reply({
        content: [
          "**입금 완료 알림을 전송했어요.**",
          "",
          `- 상품: \`${label} ${count}개\``,
          `- 금액: \`${price.toLocaleString("ko-KR")}원\``,
          `- 입금자명: \`${depositName}\``,
          "",
          "관리자가 입금을 확인하면 서버 토큰이 추가됩니다.",
        ].join("\n"),
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      console.error("Error processing server token interaction:", error);
      await interaction.reply({
        content: "서버 토큰 구매 신청 처리 중 오류가 발생했어요. 개발자에게 직접 문의해 주세요.",
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }
    return;
  }

  // 3. 서버 토큰 승인 버튼
  if (customId.startsWith("server_token_approve:")) {
    if (interaction.user.id !== ADMIN_USER_ID) {
      await interaction.reply({ content: "권한이 없습니다.", flags: MessageFlags.Ephemeral });
      return;
    }

    const parts = customId.split(":");
    if (parts.length < 4) return;

    const [, type, guildId, userId] = parts;
    const label = SERVER_TOKEN_LABELS[type];
    if (!label) return;

    const count = parseInt(parts[5] || 1, 10);

    try {
      const tokens = await addServerImageToken(guildId, type, count);
      await interaction.update({
        content: [
          `**${label} 구매 신청을 승인했습니다.**`,
          `- 서버 ID: \`${guildId}\``,
          `- 신청자: <@${userId}>`,
          `- 추가 토큰: \`${label} ${count}개\``,
          `- 현재 이미지 검토 토큰: \`${tokens.image_readings}개\``,
          `- 현재 이미지 생성 토큰: \`${tokens.image_generations}개\``,
        ].join("\n"),
        components: [],
      });

      const targetUser = await client.users.fetch(userId).catch(() => null);
      if (targetUser) {
        await targetUser.send([
          `**${label} 승인 완료**`,
          "",
          `입금 확인이 완료되어 서버 토큰 ${count}개가 추가됐어요.`,
          `- 서버 ID: \`${guildId}\``,
          `- 이미지 검토 토큰: \`${tokens.image_readings}개\``,
          `- 이미지 생성 토큰: \`${tokens.image_generations}개\``,
        ].join("\n")).catch(() => {});
      }
    } catch (error) {
      console.error("Database error during server token approval:", error);
      await interaction.reply({ content: "서버 토큰 승인 처리 중 DB 오류가 발생했어요.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  // 4. 서버 토큰 반려 버튼
  if (customId.startsWith("server_token_reject:")) {
    if (interaction.user.id !== ADMIN_USER_ID) {
      await interaction.reply({ content: "권한이 없습니다.", flags: MessageFlags.Ephemeral });
      return;
    }

    const parts = customId.split(":");
    if (parts.length < 4) return;

    const [, type, guildId, userId] = parts;
    const label = SERVER_TOKEN_LABELS[type] ?? "서버 이미지 토큰";

    await interaction.update({
      content: [
        `**${label} 구매 신청을 반려했습니다.**`,
        `- 서버 ID: \`${guildId}\``,
        `- 신청자: <@${userId}>`,
      ].join("\n"),
      components: [],
    });

    const targetUser = await client.users.fetch(userId).catch(() => null);
    if (targetUser) {
      await targetUser.send([
        `**${label} 구매 신청 반려**`,
        "",
        "입금 미확인 또는 기타 사유로 서버 토큰 구매 신청이 반려됐어요.",
      ].join("\n")).catch(() => {});
    }
    return;
  }

  // 5. 플래티넘 서버 승인 버튼
  if (customId.startsWith("admin_approve_platinum:")) {
    if (interaction.user.id !== ADMIN_USER_ID) {
      await interaction.reply({ content: "❌ 권한이 없습니다.", flags: MessageFlags.Ephemeral });
      return;
    }

    const parts = customId.split(":");
    if (parts.length < 3) return;
    const [, guildId, userId] = parts;

    try {
      const { updateServerSubscription } = await import("../services/subscription.js");
      const { tier: updatedTier, expiresAt } = await updateServerSubscription(guildId, "platinum", 30);
      const displayExpiry = expiresAt ? `${expiresAt} (KST)` : "무제한";

      await interaction.update({
        content: `✅ 길드 ID ${guildId} (신청자: <@${userId}>)의 **플래티넘 서버** 구매 신청을 **승인**했습니다.\n- 만료일: ${displayExpiry}`,
        components: [],
      });

      const targetUser = await client.users.fetch(userId).catch(() => null);
      if (targetUser) {
        await targetUser.send(
          `🎉 **FLUX봇 플래티넘 서버 승인 완료**\n\n` +
          `안녕하세요, **${targetUser.username}**님! 개발자가 송금 확인을 완료하여 플래티넘 서버 구독을 승인했습니다.\n` +
          `- **부여 등급**: \`PLATINUM\`\n` +
          `- **대상 길드 ID**: \`${guildId}\`\n` +
          `- **만료 일자**: \`${displayExpiry}\`\n\n` +
          `해당 서버의 예약 메시지 및 서버 분석 기능 등 플래티넘 혜택이 정상적으로 적용됩니다. 감사합니다! 💛`
        ).catch(() => {});
      }
    } catch (dbError) {
      console.error("Database error during platinum approval:", dbError);
      await interaction.reply({ content: "❌ 플래티넘 서버 등급 부여 중 DB 오류가 발생했습니다.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  // 6. 플래티넘 서버 반려 버튼
  if (customId.startsWith("admin_reject_platinum:")) {
    if (interaction.user.id !== ADMIN_USER_ID) {
      await interaction.reply({ content: "❌ 권한이 없습니다.", flags: MessageFlags.Ephemeral });
      return;
    }

    const parts = customId.split(":");
    if (parts.length < 3) return;
    const [, guildId, userId] = parts;

    try {
      await interaction.update({
        content: `❌ 길드 ID ${guildId} (신청자: <@${userId}>)의 플래티넘 서버 구매 신청을 **반려(거절)** 처리했습니다.`,
        components: [],
      });

      const targetUser = await client.users.fetch(userId).catch(() => null);
      if (targetUser) {
        await targetUser.send(
          `❌ **FLUX봇 플래티넘 서버 구매 신청 반려**\n\n` +
          `안녕하세요, **${targetUser.username}**님.\n` +
          `신청하신 플래티넘 서버 라이선스 (길드 ID: \`${guildId}\`) 구매 건이 입금 미확인 또는 기타 사유로 인해 반려 처리되었습니다.`
        ).catch(() => {});
      }
    } catch (err) {
      console.error("Error during platinum rejection:", err);
    }
    return;
  }

  // 7. 개발자 등급 승인 버튼
  if (customId.startsWith("admin_approve:")) {
    if (interaction.user.id !== ADMIN_USER_ID) {
      await interaction.reply({ content: "❌ 권한이 없습니다.", flags: MessageFlags.Ephemeral });
      return;
    }

    const parts = customId.split(":");
    if (parts.length < 3) return;
    const [, tier, userId, amountText] = parts;
    const donationAmount = Number.parseInt(amountText, 10);

    try {
      const { tier: updatedTier, expiresAt } = await extendUserSubscription(userId, tier, 30);
      const totalDonation = Number.isInteger(donationAmount) && donationAmount > 0
        ? await updateDonationAmount(userId, donationAmount)
        : null;
      const displayExpiry = expiresAt ? `${expiresAt} (KST)` : "무제한";

      await syncTierRole(client, userId, tier);

      await interaction.update({
        content: `✅ <@${userId}> (ID: \`${userId}\`)님의 후원에 따른 \`${updatedTier.toUpperCase()}\` 등급 부여를 **승인**했습니다.\n- 만료일: \`${displayExpiry}\``,
        components: [],
      });

      const targetUser = await client.users.fetch(userId).catch(() => null);
      if (targetUser) {
        await targetUser.send(
          `🎉 **FLUX봇 후원 등급 승인 완료**\n\n` +
          `안녕하세요, **${targetUser.username}**님! 개발자가 후원 확인을 완료하여 등급을 승인했습니다.\n` +
          `- **부여 등급**: \`${updatedTier.toUpperCase()}\`\n` +
          `- **만료 일자**: \`${displayExpiry}\`\n\n` +
          `지금부터 혜택이 정상적으로 적용됩니다. FLUX봇을 후원해 주셔서 감사합니다! 💛`
        ).catch(() => {});
      }
    } catch (dbError) {
      console.error("Database error during admin approval:", dbError);
      await interaction.reply({ content: "❌ 등급 부여 처리 중 DB 오류가 발생했습니다.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  // 8. 개발자 등급 반려 버튼
  if (customId.startsWith("admin_reject:")) {
    if (interaction.user.id !== ADMIN_USER_ID) {
      await interaction.reply({ content: "❌ 권한이 없습니다.", flags: MessageFlags.Ephemeral });
      return;
    }

    const parts = customId.split(":");
    if (parts.length < 2) return;
    const [, userId] = parts;

    try {
      await interaction.update({
        content: `❌ <@${userId}> (ID: \`${userId}\`)님의 등급 구매 신청을 **반려(거절)** 처리했습니다.`,
        components: [],
      });

      const targetUser = await client.users.fetch(userId).catch(() => null);
      if (targetUser) {
        await targetUser.send(
          `❌ **FLUX봇 등급 구매 신청 반려**\n\n` +
          `안녕하세요, **${targetUser.username}**님.\n` +
          `신청하신 등급 구매 건이 입금 미확인 또는 기타 사유로 인해 반려 처리되었습니다.\n` +
          `문제가 있거나 입금 완료 후에도 반려되었다면 개발자에게 문의해주시기 바랍니다.`
        ).catch(() => {});
      }
    } catch (err) {
      console.error("Error during admin rejection:", err);
    }
    return;
  }
}
