import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { ADMIN_USER_ID } from "../config.js";
import { addServerImageToken, updateUserSubscription } from "../services/subscription.js";

const SERVER_TOKEN_LABELS = {
  image_readings: "서버 이미지 검토 토큰",
  image_generations: "서버 이미지 생성 토큰",
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
  // 버튼 상호작용만 처리
  if (!interaction.isButton()) return;

  const { customId } = interaction;

  // 1. 유저의 등급 구매 송금완료 버튼 처리
  // customId 형식: sub_complete:<tier>:<userId>:<timeStr>
  if (customId.startsWith("sub_complete:")) {
    const parts = customId.split(":");
    if (parts.length < 4) return;

    const [_, tier, userId, timeStr] = parts;
    const depositName = `${timeStr}-${userId}`;
    const uppercaseTier = tier.toUpperCase();

    try {
      // 개발자에게 알림 DM 발송 (승인/반려 컨텍스트 버튼 포함)
      const developer = await client.users.fetch(ADMIN_USER_ID);
      if (developer) {
        let adminNotifyMsg = `🔔 **[등급 구매 신청 알림]**\n\n`;
        adminNotifyMsg += `- **신청자**: <@${userId}> (ID: \`${userId}\`)\n`;
        adminNotifyMsg += `- **신청 등급**: \`${uppercaseTier}\`\n`;
        adminNotifyMsg += `- **입금자명**: \`${depositName}\`\n`;
        adminNotifyMsg += `- **신청 시간**: \`${timeStr}\`\n\n`;
        adminNotifyMsg += `*아래 버튼을 눌러 입금 승인 또는 반려 처리를 진행하세요.*`;

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`admin_approve:${tier}:${userId}`)
            .setLabel(`${uppercaseTier} 승인`)
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`admin_reject:${userId}`)
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
                 `- **신청 등급**: \`${uppercaseTier}\`\n\n` +
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

    const [, type, guildId, userId, timeStr] = parts;
    const label = SERVER_TOKEN_LABELS[type];
    if (!label) {
      await interaction.reply({ content: "알 수 없는 서버 토큰 상품이에요.", ephemeral: true });
      return;
    }

    const depositName = `${timeStr}-${guildId}`;
    const price = SERVER_TOKEN_PRICES[type];
    const guild = await client.guilds.fetch(guildId).catch(() => null);

    try {
      const developer = await client.users.fetch(ADMIN_USER_ID);
      if (developer) {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`server_token_approve:${type}:${guildId}:${userId}`)
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
            `- 상품: \`${label} 1개\``,
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
          `- 상품: \`${label} 1개\``,
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

    try {
      const tokens = addServerImageToken(guildId, type, 1);
      await interaction.update({
        content: [
          `**${label} 구매 신청을 승인했습니다.**`,
          `- 서버 ID: \`${guildId}\``,
          `- 신청자: <@${userId}>`,
          `- 추가 토큰: \`${label} 1개\``,
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
          "입금 확인이 완료되어 서버 토큰 1개가 추가됐어요.",
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
