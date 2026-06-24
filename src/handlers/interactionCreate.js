import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from "discord.js";
import { ADMIN_USER_ID } from "../config/config.js";
import { addServerImageToken, updateUserSubscription, getServerSubscriptionTier } from "../services/subscription.js";
import { createScheduledMessage } from "../services/scheduler.js";
import { parseScheduleTime, scheduleChannelMap } from "../commands/scheduler.js";

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
  if (interaction.isModalSubmit() && interaction.customId === "schedule_create_modal") {
    const tier = getServerSubscriptionTier(interaction.guildId);
    if (tier !== "platinum") {
      await interaction.reply({
        content: "❌ 이 서버는 **플래티넘 서버(유료)** 권한이 없으므로 예약 기능을 사용할 수 없습니다. `!먼지야 플래티넘 서버 구매`를 입력해 등급을 업그레이드해 보세요!",
        ephemeral: true,
      });
      return;
    }

    const timeInput = interaction.fields.getTextInputValue("schedule_time");
    const content = interaction.fields.getTextInputValue("schedule_content").trim();
    const parsed = parseScheduleTime(timeInput);

    if (!parsed || !content) {
      await interaction.reply({
        content: "예약 시간이나 메시지를 이해하지 못했어요. 예: `10분 뒤`, `내일 09:30`, `2026-06-20 18:30`",
        ephemeral: true,
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
        if (resolved && resolved.isTextBased()) {
          channelId = resolved.id;
        }
      } else {
        const byName = interaction.guild.channels.cache.find(
          c => c.isTextBased() && (c.name === channelTextInput || c.name.includes(channelTextInput))
        );
        if (byName) {
          channelId = byName.id;
        }
      }
    }

    const task = createScheduledMessage({
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
      ephemeral: true,
    });
    return;
  }

  // 채널 선택 메뉴 처리 (예약 메시지)
  if (interaction.isChannelSelectMenu() && interaction.customId === "schedule_channel_select") {
    const channelId = interaction.values[0];
    scheduleChannelMap.set(interaction.user.id, { channelId, timestamp: Date.now() });

    const modal = new ModalBuilder()
      .setCustomId("schedule_create_modal")
      .setTitle("예약 메시지");

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

  // 버튼 상호작용만 처리
  if (!interaction.isButton()) return;

  const { customId } = interaction;

  if (customId === "schedule_open_modal") {
    const tier = getServerSubscriptionTier(interaction.guildId);
    if (tier !== "platinum") {
      await interaction.reply({
        content: "❌ 이 서버는 **플래티넘 서버(유료)** 권한이 없으므로 예약 기능을 사용할 수 없습니다. `!먼지야 플래티넘 서버 구매`를 입력해 등급을 업그레이드해 보세요!",
        ephemeral: true,
      });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId("schedule_create_modal")
      .setTitle("예약 메시지");

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

  // 1. 유저/서버의 등급 구매 송금완료 버튼 처리
  if (customId.startsWith("sub_complete:")) {
    const parts = customId.split(":");
    if (parts.length < 4) return;

    const [_, tier, userId, timeStr, maybeGuildId] = parts;
    const isPlatinum = tier === "platinum";
    const guildId = maybeGuildId || "dm";
    const depositName = isPlatinum 
      ? `${timeStr}-plat-${guildId !== 'dm' ? guildId.slice(-4) : 'dm'}`
      : `${timeStr}-${userId}`;
    const uppercaseTier = tier.toUpperCase();

    try {
      // 개발자에게 알림 DM 발송 (승인/반려 컨텍스트 버튼 포함)
      const developer = await client.users.fetch(ADMIN_USER_ID);
      if (developer) {
        let adminNotifyMsg = `🔔 **[${isPlatinum ? '플래티넘 서버' : '등급'} 구매 신청 알림]**\n\n`;
        adminNotifyMsg += `- **신청자**: <@${userId}> (ID: \`${userId}\`)\n`;
        adminNotifyMsg += `- **신청 등급**: \`${uppercaseTier}\`\n`;
        if (isPlatinum) {
          adminNotifyMsg += `- **대상 길드 ID**: \`${guildId}\`\n`;
        }
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
            .setStyle(ButtonStyle.Danger)
        );

        await developer.send({
          content: adminNotifyMsg,
          components: [row]
        });
      }

      // 신청자에게 응답
      await interaction.reply({
        content: `✅ **송금 완료 알림이 전송되었습니다.**\n\n` +
                 `- **입금자명**: \`${depositName}\`\n` +
                 `- **신청 등급**: \`${uppercaseTier}\`\n` +
                 (isPlatinum ? `- **대상 길드 ID**: \`${guildId}\`\n` : "") + `\n` +
                 `개발자가 입금 확인 후 등급을 부여해 드립니다. 처리가 완료되면 DM으로 알려드릴게요! 잠시만 기다려주세요. ✨`,
        ephemeral: true
      });

    } catch (error) {
      console.error("Error processing sub_complete interaction:", error);
      await interaction.reply({
        content: "❌ 송금 완료 처리 중 오류가 발생했습니다. 개발자에게 직접 문의해주세요.",
        ephemeral: true
      }).catch(() => {});
    }
    return;
  }

  // 2. 개발자 승인 버튼 처리
  // customId 형식: admin_approve:<tier>:<userId>
  if (customId.startsWith("server_token_complete:")) {
    const parts = customId.split(":");
    if (parts.length < 5) return;

    const [, type, guildId, userId, timeStr, countStr] = parts;
    const count = parseInt(countStr || "1", 10);
    const label = SERVER_TOKEN_LABELS[type];
    if (!label) {
      await interaction.reply({ content: "알 수 없는 서버 토큰 상품이에요.", ephemeral: true });
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
        ephemeral: true,
      });
    } catch (error) {
      console.error("Error processing server token interaction:", error);
      await interaction.reply({
        content: "서버 토큰 구매 신청 처리 중 오류가 발생했어요. 개발자에게 직접 문의해 주세요.",
        ephemeral: true,
      }).catch(() => {});
    }
    return;
  }

  if (customId.startsWith("server_token_approve:")) {
    if (interaction.user.id !== ADMIN_USER_ID) {
      await interaction.reply({ content: "권한이 없습니다.", ephemeral: true });
      return;
    }

    const parts = customId.split(":");
    if (parts.length < 4) return;

    const [, type, guildId, userId] = parts;
    const label = SERVER_TOKEN_LABELS[type];
    if (!label) return;

    // customId에 저장된 count 추출 (parts[5]에 위치)
    const count = parseInt(parts[5] || 1, 10);

    try {
      const tokens = addServerImageToken(guildId, type, count);
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
      await interaction.reply({ content: "서버 토큰 승인 처리 중 DB 오류가 발생했어요.", ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (customId.startsWith("server_token_reject:")) {
    if (interaction.user.id !== ADMIN_USER_ID) {
      await interaction.reply({ content: "권한이 없습니다.", ephemeral: true });
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

  if (customId.startsWith("admin_approve_platinum:")) {
    if (interaction.user.id !== ADMIN_USER_ID) {
      await interaction.reply({ content: "❌ 권한이 없습니다.", ephemeral: true });
      return;
    }

    const parts = customId.split(":");
    if (parts.length < 3) return;

    const [_, guildId, userId] = parts;

    try {
      const { updateServerSubscription } = await import("../services/subscription.js");
      const { tier: updatedTier, expiresAt } = updateServerSubscription(guildId, "platinum", 30);
      const displayExpiry = expiresAt ? `${expiresAt} (KST)` : "무제한";

      await interaction.update({
        content: `✅ 길드 ID ${guildId} (신청자: <@${userId}>)의 **플래티넘 서버** 구매 신청을 **승인**했습니다.\n- 만료일: ${displayExpiry}`,
        components: []
      });

      try {
        const targetUser = await client.users.fetch(userId);
        if (targetUser) {
          await targetUser.send(
            `🎉 **DUST봇 플래티넘 서버 승인 완료**\n\n` +
            `안녕하세요, **${targetUser.username}**님! 개발자가 송금 확인을 완료하여 플래티넘 서버 구독을 승인했습니다.\n` +
            `- **부여 등급**: \`PLATINUM\`\n` +
            `- **대상 길드 ID**: \`${guildId}\`\n` +
            `- **만료 일자**: \`${displayExpiry}\`\n\n` +
            `해당 서버의 예약 메시지 및 서버 분석 기능 등 플래티넘 혜택이 정상적으로 적용됩니다. 감사합니다! 💛`
          );
        }
      } catch (dmError) {
        console.error("Failed to send platinum approval DM to user:", dmError);
      }
    } catch (dbError) {
      console.error("Database error during platinum approval:", dbError);
      await interaction.reply({ content: "❌ 플래티넘 서버 등급 부여 중 DB 오류가 발생했습니다.", ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (customId.startsWith("admin_reject_platinum:")) {
    if (interaction.user.id !== ADMIN_USER_ID) {
      await interaction.reply({ content: "❌ 권한이 없습니다.", ephemeral: true });
      return;
    }

    const parts = customId.split(":");
    if (parts.length < 3) return;

    const [_, guildId, userId] = parts;

    try {
      await interaction.update({
        content: `❌ 길드 ID ${guildId} (신청자: <@${userId}>)의 플래티넘 서버 구매 신청을 **반려(거절)** 처리했습니다.`,
        components: []
      });

      try {
        const targetUser = await client.users.fetch(userId);
        if (targetUser) {
          await targetUser.send(
            `❌ **DUST봇 플래티넘 서버 구매 신청 반려**\n\n` +
            `안녕하세요, **${targetUser.username}**님.\n` +
            `신청하신 플래티넘 서버 라이선스 (길드 ID: \`${guildId}\`) 구매 건이 입금 미확인 또는 기타 사유로 인해 반려 처리되었습니다.`
          );
        }
      } catch (dmError) {
        console.error("Failed to send platinum rejection DM to user:", dmError);
      }
    } catch (err) {
      console.error("Error during platinum rejection:", err);
    }
    return;
  }

  if (customId.startsWith("admin_approve:")) {
    if (interaction.user.id !== ADMIN_USER_ID) {
      await interaction.reply({ content: "❌ 권한이 없습니다.", ephemeral: true });
      return;
    }

    const parts = customId.split(":");
    if (parts.length < 3) return;

    const [_, tier, userId] = parts;

    try {
      // 등급 부여 및 DB 저장 (기본 30일)
      const { tier: updatedTier, expiresAt } = updateUserSubscription(userId, tier, 30);
      const displayExpiry = expiresAt ? `${expiresAt} (KST)` : "무제한";

      // 개발자 DM 메시지에서 버튼을 지우고 완료 상태로 업데이트
      await interaction.update({
        content: `✅ <@${userId}> (ID: \`${userId}\`)님의 \`${updatedTier.toUpperCase()}\` 등급 구매 신청을 **승인**했습니다.\n- 만료일: \`${displayExpiry}\``,
        components: []
      });

      // 신청자에게 완료 안내 DM 발송
      try {
        const targetUser = await client.users.fetch(userId);
        if (targetUser) {
          await targetUser.send(
            `🎉 **DUST봇 등급 승인 완료**\n\n` +
            `안녕하세요, **${targetUser.username}**님! 개발자가 송금 확인을 완료하여 등급을 승인했습니다.\n` +
            `- **부여 등급**: \`${updatedTier.toUpperCase()}\`\n` +
            `- **만료 일자**: \`${displayExpiry}\`\n\n` +
            `지금부터 혜택이 정상적으로 적용됩니다. DUST봇을 애용해 주셔서 감사합니다! 💛`
          );
        }
      } catch (dmError) {
        console.error("Failed to send approval DM to user:", dmError);
      }

    } catch (dbError) {
      console.error("Database error during admin approval:", dbError);
      await interaction.reply({ content: "❌ 등급 부여 처리 중 DB 오류가 발생했습니다.", ephemeral: true }).catch(() => {});
    }
    return;
  }

  // 3. 개발자 반려 버튼 처리
  // customId 형식: admin_reject:<userId>
  if (customId.startsWith("admin_reject:")) {
    if (interaction.user.id !== ADMIN_USER_ID) {
      await interaction.reply({ content: "❌ 권한이 없습니다.", ephemeral: true });
      return;
    }

    const parts = customId.split(":");
    if (parts.length < 2) return;

    const [_, userId] = parts;

    try {
      // 개발자 DM 메시지에서 버튼을 지우고 반려 상태로 업데이트
      await interaction.update({
        content: `❌ <@${userId}> (ID: \`${userId}\`)님의 등급 구매 신청을 **반려(거절)** 처리했습니다.`,
        components: []
      });

      // 신청자에게 반려 안내 DM 발송
      try {
        const targetUser = await client.users.fetch(userId);
        if (targetUser) {
          await targetUser.send(
            `❌ **DUST봇 등급 구매 신청 반려**\n\n` +
            `안녕하세요, **${targetUser.username}**님.\n` +
            `신청하신 등급 구매 건이 입금 미확인 또는 기타 사유로 인해 반려 처리되었습니다.\n` +
            `문제가 있거나 입금 완료 후에도 반려되었다면 개발자에게 문의해주시기 바랍니다.`
          );
        }
      } catch (dmError) {
        console.error("Failed to send rejection DM to user:", dmError);
      }

    } catch (err) {
      console.error("Error during admin rejection:", err);
    }
    return;
  }

}
