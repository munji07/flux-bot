import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { ADMIN_USER_ID, PREFIX } from "../config.js";
import { getUserSubscription, updateUserSubscription, getDailyUsage, getServerImageTokens, getServerSubscriptionTier, TIER_LIMITS, getKstNow, syncTierRole } from "../services/subscription.js";

const SERVER_IMAGE_TOKEN_PRODUCTS = {
  "서버 이미지 검토 토큰 구매": {
    type: "image_readings",
    label: "서버 이미지 검토 토큰",
    price: 100,
    buttonLabel: "검토 토큰 입금완료",
  },
  "서버 이미지 생성 토큰 구매": {
    type: "image_generations",
    label: "서버 이미지 생성 토큰",
    price: 500,
    buttonLabel: "생성 토큰 입금완료",
  },
  "서버 비디오 판독 토큰 구매": {
    type: "video_analysis",
    label: "서버 비디오 판독 토큰",
    price: 1000,
    buttonLabel: "판독 토큰 입금완료",
  },
};

function getTimeStr() {
  const now = getKstNow();
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  return `${hours}${minutes}`;
}

async function sendDonationGuide(message, sendResponse) {
  const timeStr = getTimeStr();
  const depositName = `${timeStr}-${message.author.id}`;

  const dmContent = [
    "## ✨ FLUX봇 후원 안내",
    `안녕하세요, ${message.author.username}님! FLUX봇을 후원해 주셔서 감사합니다.`,
    `후원해 주신 금액에 따라 등급이 지급됩니다.`,
    "",
    "**🏷️ 후원 금액별 등급**",
    "- 3,000원 이상 → **Basic** 등급 (30일)",
    "- 5,000원 이상 → **Premium** 등급 (30일)",
    "",
    "**💳 입금 계좌 정보**",
    "- 은행: 토스뱅크",
    "- 계좌번호: `1908-8961-3017`",
    "- 예금주: 전민재 (개발자)",
    "",
    "**⚠️ 입금자명 설정 안내**",
    `입금 시 입금자명을 반드시 \`${depositName}\` 으로 설정해 주세요.`,
    "",
    "입금이 완료되면 아래 **[후원 완료]** 버튼을 눌러 후원 금액을 입력해 주세요. 개발자가 확인 후 등급을 부여해 드립니다.",
  ].join("\n");

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`donation_open_modal:${message.author.id}`)
      .setLabel("후원 완료")
      .setStyle(ButtonStyle.Success),
  );

  try {
    await message.author.send({ content: dmContent, components: [row] });
  } catch (error) {
    console.error("Failed to send DM to user:", error);
    await sendResponse(`❌ ${message.author.username}님에게 DM을 보낼 수 없습니다. 디스코드 설정에서 '서버 멤버가 보내는 개인 메시지 허용'이 켜져 있는지 확인해주세요.`);
    return false;
  }
  await sendResponse(`📩 ${message.author.username}님, 후원 안내를 **DM**으로 전송했습니다! DM에서 **[후원 완료]** 버튼을 눌러 진행해 주세요.`);
  return true;
}

async function sendPlatinumGuide(message, sendResponse) {
  if (message.guildId) {
    const serverTier = await getServerSubscriptionTier(message.guildId);
    if (serverTier === "platinum") {
      await sendResponse(`⚠️ 이 서버에는 이미 **Platinum 서버**가 등록되어 있어 추가 구매할 수 없습니다.`);
      return true;
    }
  }

  const timeStr = getTimeStr();
  const depositName = `${timeStr}-plat-${message.guildId ? message.guildId.slice(-4) : "dm"}`;

  const dmContent = [
    "## Platinum 서버 구매 안내",
    `${message.author.username}님, 아래 계좌로 4,000원을 입금한 뒤 버튼을 눌러 주세요.`,
    "",
    "**입금 계좌**",
    "- 토스뱅크",
    "- `1908-8961-3017`",
    "- 예금주: 전민재",
    "",
    "**상품**",
    "- Platinum 서버 (4,000원 / 30일)",
    "- 예약 메시지, 서버/채널 분석 기능 제공",
    "",
    `입금자명: \`${depositName}\``,
  ].join("\n");

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`sub_complete:platinum:${message.author.id}:${timeStr}:${message.guildId || "dm"}`)
      .setLabel("Platinum 서버 (4,000원) 송금완료")
      .setStyle(ButtonStyle.Danger),
  );

  try {
    await message.author.send({ content: dmContent, components: [row] });
  } catch (error) {
    console.error("Failed to send DM to user:", error);
    await sendResponse(`❌ ${message.author.username}님에게 DM을 보낼 수 없습니다. 디스코드 설정에서 '서버 멤버가 보내는 개인 메시지 허용'이 켜져 있는지 확인해주세요.`);
    return true;
  }
  await sendResponse(`${message.author.username}님, Platinum 서버 구매 안내를 DM으로 보냈어요.`);
  return true;
}

export async function handleServerImageTokenPurchaseCommand(message, userPrompt, loadingMessage = null) {
  // "서버 이미지/이모지 생성/분석/검토/비디오 판독 토큰 (수량) 구매" 형태를 인식
  const regex = /^(서버 (?:이미지|이모지|비디오 판독) (?:검토|분석|생성|판독) 토큰)\s*(?:(\d+)개)?\s*구매$/;
  const match = userPrompt.trim().match(regex);
  if (!match) return false;

  // 사용자 입력 키워드 정규화
  let normalizedType = match[1]
    .replace("이모지", "이미지")
    .replace("분석", "검토")
    .replace("비디오 판독 검토", "비디오 판독");

  const product = SERVER_IMAGE_TOKEN_PRODUCTS[normalizedType + " 구매"];
  if (!product) return false;

  const count = match[2] ? parseInt(match[2], 10) : 1;
  if (count <= 0) return false;

  const totalPrice = product.price * count;

  const now = getKstNow();
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const timeStr = `${hours}${minutes}`;
  const depositName = `${timeStr}-${count}-${message.guildId.slice(-4)}`; // 입금자명에 수량 포함
  const tokens = await getServerImageTokens(message.guildId);

  const dmContent = [
    `## ${product.label} 구매 안내`,
    `${message.guild.name} 서버에서 사용할 ${product.label} ${count}개 구매 안내입니다.`,
    "",
    "**입금 계좌**",
    "- 토스뱅크",
    "- `1908-8961-3017`",
    "- 예금주: 전민재",
    "",
    "**상품**",
    `- 상품명: ${product.label}`,
    `- 수량: ${count}개`,
    `- 총 입금액: **${totalPrice.toLocaleString("ko-KR")}원** (1개당 ${product.price.toLocaleString("ko-KR")}원)`,
    `- 입금자명: \`${depositName}\``,
    "",
    "**현재 서버 토큰**",
    `- 이미지 검토: ${tokens.image_readings}개`,
    `- 이미지 생성: ${tokens.image_generations}개`,
    `- 비디오 판독: ${tokens.video_analysis}개`,
  ].join("\n");

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`server_token_complete:${product.type}:${message.guildId}:${message.author.id}:${timeStr}:${count}`)
      .setLabel(product.buttonLabel)
      .setStyle(ButtonStyle.Success),
  );

  try {
    await message.author.send({ content: dmContent, components: [row] });
  } catch (error) {
    console.error("Failed to send DM to user:", error);
    await message.reply(`❌ ${message.author.username}님에게 DM을 보낼 수 없습니다. 디스코드 설정에서 '서버 멤버가 보내는 개인 메시지 허용'이 켜져 있는지 확인해주세요.`);
    return true;
  }

  const replyText = `${message.author.username}님, ${product.label} ${count}개 구매 안내를 DM으로 보냈어요.`;
  if (loadingMessage) {
    await loadingMessage.edit(replyText);
  } else {
    await message.reply(replyText);
  }
  return true;
}

/**
 * AI 도구 호출을 통한 구독/등급 관련 작업을 처리합니다.
 * @param {import("discord.js").Message} message 
 * @param {object} intent 
 * @param {import("discord.js").Message} [loadingMessage=null]
 */
export async function handleSubscriptionToolCall(message, intent, loadingMessage = null) {
  if (intent?.tool !== "subscription") return false;

  const args = intent.arguments ?? {};
  const action = args.action || "status";

  const sendResponse = async (payload) => {
    const options = typeof payload === "string" ? { content: payload } : payload;
    if (loadingMessage) return await loadingMessage.edit(options);
    return await message.reply(options);
  };

  if (action === "status") {
    const sub = await getUserSubscription(message.author.id);
    const usage = await getDailyUsage(message.author.id);
    const limits = TIER_LIMITS[sub.tier];
    const aiCallLimit = limits.ai_calls === Infinity ? "무제한" : `${limits.ai_calls}회`;
    const expiresAt = sub.expires_at ? `${sub.expires_at} (KST)` : "무제한";

    const embed = new EmbedBuilder()
      .setAuthor({ 
        name: `${message.author.username}님의 멤버십 정보`, 
        iconURL: message.author.displayAvatarURL() 
      })
      .setColor(limits.name === "Premium" ? 0xFFD700 : limits.name === "Basic" ? 0x3498DB : 0x95A5A6)
      .addFields(
        { name: "✨ 현재 등급", value: `**${limits.name}**`, inline: true },
        { name: "📅 만료 예정", value: expiresAt, inline: true },
        { name: "━━━━━━━━━━━━━━━━━━━━", value: "**📊 오늘의 사용 현황**" },
        { name: "💬 AI 대화", value: `\`${usage.ai_calls}\` / ${aiCallLimit}`, inline: true },
        { name: "🎨 이미지 생성", value: `\`${usage.image_generations}\` / ${limits.image_generations}회`, inline: true },
        { name: "🔍 이미지 분석", value: `\`${usage.image_readings}\` / ${limits.image_readings}회`, inline: true },
        { name: "🎬 비디오 판독", value: `\`${usage.video_analysis || 0}\` / ${limits.video_analysis}회`, inline: true }
      )
      .setFooter({ text: `💡 후원하시면 등급 혜택이 지급돼요. "${PREFIX} 후원"을 입력하세요.` })
      .setTimestamp();

    await sendResponse({ content: null, embeds: [embed] });
    return true;
  }

  if (action === "purchase") {
    const type = args.type || "tier";

    // 1. 서버 이미지 토큰 구매 요청인 경우 (AI가 type을 분류했을 때)
    if (type === "image_generations" || type === "image_readings" || type === "video_analysis") {
      const productKey = type === "image_generations"
        ? "서버 이미지 생성 토큰 구매"
        : type === "image_readings"
        ? "서버 이미지 검토 토큰 구매"
        : "서버 비디오 판독 토큰 구매";
      const product = SERVER_IMAGE_TOKEN_PRODUCTS[productKey];
      
      // 수량(count) 처리: AI가 추출한 숫자를 우선 사용, 없으면 1
      let count = parseInt(args.count, 10);
      if (isNaN(count) || count <= 0) count = 1;

      const totalPrice = product.price * count;

      const now = getKstNow();
      const hours = String(now.getHours()).padStart(2, "0");
      const minutes = String(now.getMinutes()).padStart(2, "0");
      const timeStr = `${hours}${minutes}`;
      const depositName = `${timeStr}-${count}-${message.guildId.slice(-4)}`;
      const tokens = await getServerImageTokens(message.guildId);

      const dmContent = [
        `## ${product.label} 구매 안내`,
        `${message.guild.name} 서버에서 사용할 ${product.label} ${count}개 구매 안내입니다.`,
        "",
        "**입금 계좌**",
        "- 토스뱅크",
        "- `1908-8961-3017`",
        "- 예금주: 전민재",
        "",
        "**상품**",
        `- 상품명: ${product.label}`,
        `- 수량: ${count}개`,
        `- 총 입금액: **${totalPrice.toLocaleString("ko-KR")}원** (1개당 ${product.price.toLocaleString("ko-KR")}원)`,
        `- 입금자명: \`${depositName}\``,
        "",
        "**현재 서버 토큰**",
        `- 이미지 검토: ${tokens.image_readings}개`,
        `- 이미지 생성: ${tokens.image_generations}개`,
        `- 비디오 판독: ${tokens.video_analysis}개`,
      ].join("\n");

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`server_token_complete:${product.type}:${message.guildId}:${message.author.id}:${timeStr}:${count}`)
          .setLabel(product.buttonLabel)
          .setStyle(ButtonStyle.Success),
      );

      try {
        await message.author.send({ content: dmContent, components: [row] });
      } catch (error) {
        console.error("Failed to send DM to user:", error);
        await sendResponse(`❌ ${message.author.username}님에게 DM을 보낼 수 없습니다. 디스코드 설정에서 '서버 멤버가 보내는 개인 메시지 허용'이 켜져 있는지 확인해주세요.`);
        return true;
      }
      await sendResponse(`${message.author.username}님, ${product.label} ${count}개 구매 안내를 DM으로 보냈어요.`);
      return true;
    }

    // 2. 플래티넘 서버 구매 요청인 경우 (AI가 type을 'platinum'으로 분류)
    if (type === "platinum") {
      return await sendPlatinumGuide(message, sendResponse);
    }

    // 3. 일반 등급(Tier) 후원 안내인 경우
    return await sendDonationGuide(message, sendResponse);
  }

  if (action === "grant") {
    if (message.author.id !== ADMIN_USER_ID) {
      await sendResponse("이 작업은 개발자만 사용할 수 있어요.");
      return true;
    }

    const targetUserId = String(args.targetUserId || "").replace(/[<@!>]/g, "");
    const targetTier = String(args.tier || "").toLowerCase();
    const days = Number.parseInt(args.days ?? "30", 10);

    if (!targetUserId || !["free", "basic", "premium"].includes(targetTier) || !Number.isInteger(days) || days <= 0) {
      await sendResponse(`사용법: \`${PREFIX} 등급부여 <유저ID> <free|basic|premium> [일수]\``);
      return true;
    }

    const { tier, expiresAt } = await updateUserSubscription(targetUserId, targetTier, days);
    const displayExpiry = expiresAt ? `${expiresAt} (KST)` : "무제한";
    await syncTierRole(message.client, targetUserId, tier);
    await sendResponse([
      "등급을 변경했어요.",
      `- 대상 유저 ID: ${targetUserId}`,
      `- 부여 등급: \`${tier.toUpperCase()}\``,
      `- 만료 일자: \`${displayExpiry}\``,
    ].join("\n"));
    return true;
  }

  await sendResponse("등급 작업을 이해하지 못했어요. 등급 조회, 후원, 등급 부여 중 하나로 말해 주세요.");
  return true;
}

/**
 * 구독/등급 관련 채팅 명령어를 처리합니다.
 * @param {import("discord.js").Message} message 
 * @param {string} userPrompt 
 * @param {import("discord.js").Message} [loadingMessage=null]
 * @returns {Promise<boolean>} 처리 여부
 */
export async function handleSubscriptionCommand(message, userPrompt, loadingMessage = null) {
  const trimmed = userPrompt.trim();

  // 응답 유틸리티: 로딩 메시지가 있으면 수정하고, 없으면 새로 답장합니다.
  const sendResponse = async (payload) => {
    const options = typeof payload === "string" ? { content: payload } : payload;
    if (loadingMessage) return await loadingMessage.edit(options);
    return await message.reply(options);
  };

  // 1. 나의 등급 조회
  if (trimmed === "나의 등급" || trimmed === "나의등급" || trimmed === "등급") {
    const sub = await getUserSubscription(message.author.id);
    const usage = await getDailyUsage(message.author.id);
    const limits = TIER_LIMITS[sub.tier];

    const tierName = limits.name;
    const expiresAt = sub.expires_at ? `${sub.expires_at} (KST)` : "무제한 (만료일 없음)";
    
    // 하루 남은 사용량 정보도 친절히 표시
    const aiCallLimit = limits.ai_calls === Infinity ? "무제한" : `${limits.ai_calls}회`;
    
    let replyText = `### 👤 ${message.author.username}님의 등급 정보\n`;
    replyText += `* **현재 등급**: \`${tierName}\`\n`;
    replyText += `* **만료 일자**: \`${expiresAt}\`\n\n`;
    replyText += `**📅 오늘 사용 현황 (남은 횟수 / 일일 제한)**\n`;
    replyText += `- 💬 **AI 호출 (텍스트 챗)**: ${usage.ai_calls} / ${aiCallLimit}\n`;
    replyText += `- 🎨 **이미지 생성**: ${usage.image_generations} / ${limits.image_generations}회\n`;
    replyText += `- 🔍 **이미지 판독**: ${usage.image_readings} / ${limits.image_readings}회\n`;
    replyText += `- 🎬 **비디오 판독**: ${usage.video_analysis || 0} / ${limits.video_analysis}회\n\n`;
    replyText += `*※ 후원을 통해 등급을 받으려면 \`${PREFIX} 후원\`을 입력해보세요.*`;

    await sendResponse({ content: replyText });
    return true;
  }

  // 2. 후원 / 등급 구매 안내
  if (trimmed === "후원" || trimmed === "후원하기" || trimmed === "후원 안내" || trimmed === "후원안내" ||
      trimmed === "등급 구매" || trimmed === "등급구매" || trimmed === "구매" ||
      trimmed.includes("플래티넘 서버 구매") || trimmed.includes("플래티넘서버구매")) {
    if (trimmed.includes("플래티넘 서버 구매") || trimmed.includes("플래티넘서버구매")) {
      return await sendPlatinumGuide(message, sendResponse);
    }
    return await sendDonationGuide(message, sendResponse);
  }

  // 3. 등급 부여 (개발자 전용)
  // 형식: !FLUX 등급부여 <유저ID> <free|basic|premium> [기간(일)]
  // 4. 서버 등급 부여 (개발자 전용)
  // 형식: !FLUX 서버등급부여 <길드ID> <free|platinum> [기간(일)]
  if (trimmed.startsWith("서버등급부여") || trimmed.startsWith("서버 등급 부여")) {
    if (message.author.id !== ADMIN_USER_ID) {
      await sendResponse("❌ 이 명령어는 개발자만 사용할 수 있습니다.");
      return true;
    }

    const args = trimmed.split(/\s+/).slice(1);
    if (args.length < 2) {
      await sendResponse(`⚠️ 사용법: \`${PREFIX} 서버등급부여 <길드ID> <free|platinum> [기간(일, 기본30일)]\``);
      return true;
    }

    const targetGuildId = args[0].trim();
    const targetTier = args[1].toLowerCase();
    const days = args[2] ? parseInt(args[2], 10) : 30;

    if (!["free", "platinum"].includes(targetTier)) {
      await sendResponse("❌ 존재하지 않는 서버 등급입니다. (선택형 등급: `free`, `platinum`)");
      return true;
    }

    if (isNaN(days) || days <= 0) {
      await sendResponse("❌ 기간(일)은 양의 정수여야 합니다.");
      return true;
    }

    try {
      const { updateServerSubscription } = await import("../services/subscription.js");
      const { tier, expiresAt } = await updateServerSubscription(targetGuildId, targetTier, days);
      const displayExpiry = expiresAt ? `${expiresAt} (KST)` : "무제한";
      
      await sendResponse(`✅ 성공적으로 서버 등급이 변경되었습니다.\n- **대상 길드 ID**: ${targetGuildId}\n- **부여된 등급**: \`${tier.toUpperCase()}\`\n- **만료 일자**: \`${displayExpiry}\``);
    } catch (error) {
      console.error("Failed to update server subscription:", error);
      await sendResponse("❌ 서버 등급 부여 중 데이터베이스 오류가 발생했습니다.");
    }
    return true;
  }

  if (trimmed.startsWith("등급부여") || trimmed.startsWith("등급 부여")) {
    // 개발자 권한 체크
    if (message.author.id !== ADMIN_USER_ID) {
      await sendResponse("❌ 이 명령어는 개발자만 사용할 수 있습니다.");
      return true;
    }

    const args = trimmed.split(/\s+/).slice(1);
    if (args.length < 2) {
      await sendResponse(`⚠️ 사용법: \`${PREFIX} 등급부여 <유저ID> <free|basic|premium> [기간(일, 기본30일)]\``);
      return true;
    }

    const targetUserId = args[0].replace(/[<@!>]/g, ""); // 멘션일 경우 ID 추출
    const targetTier = args[1].toLowerCase();
    const days = args[2] ? parseInt(args[2], 10) : 30;

    if (!["free", "basic", "premium"].includes(targetTier)) {
      await sendResponse("❌ 존재하지 않는 등급입니다. (선택형 등급: `free`, `basic`, `premium`)");
      return true;
    }

    if (isNaN(days) || days <= 0) {
      await sendResponse("❌ 기간(일)은 양의 정수여야 합니다.");
      return true;
    }

    try {
      const { tier, expiresAt } = await updateUserSubscription(targetUserId, targetTier, days);
      const displayExpiry = expiresAt ? `${expiresAt} (KST)` : "무제한";
      
      await sendResponse(`✅ 성공적으로 등급이 변경되었습니다.\n- **대상 유저 ID**: ${targetUserId}\n- **부여된 등급**: \`${tier.toUpperCase()}\`\n- **만료 일자**: \`${displayExpiry}\``);
      
      // 등급이 부여된 사용자에게 안내 DM 발송 시도
      try {
        const targetUser = await message.client.users.fetch(targetUserId);
        if (targetUser) {
          await targetUser.send(`🎉 **FLUX봇 등급 부여 완료**\n\n안녕하세요, **${targetUser.username}**님! 개발자가 입금을 확인하고 등급을 부여했습니다.\n- **등급**: \`${tier.toUpperCase()}\`\n- **만료일**: \`${displayExpiry}\`\n\n지금부터 혜택이 적용됩니다. 이용해주셔서 감사합니다!`);
        }
      } catch (dmErr) {
        console.log("Failed to send subscription confirmation DM to user:", dmErr.message);
      }

    } catch (error) {
      console.error("Failed to update user subscription:", error);
      await sendResponse("❌ 등급 부여 중 데이터베이스 오류가 발생했습니다.");
    }
    return true;
  }

  // 5. 관리자 전용 등급 설정 명령어 (set)
  // 형식: !FLUX <유저ID> <free|basic|premium> set
  const adminSetRegex = /^(\d{17,19})\s+(free|basic|premium)\s+set$/i;
  const adminSetMatch = trimmed.match(adminSetRegex);
  if (adminSetMatch) {
    if (message.author.id !== ADMIN_USER_ID) {
      await sendResponse("❌ 이 명령어는 개발자만 사용할 수 있습니다.");
      return true;
    }

    const targetUserId = adminSetMatch[1];
    const targetTier = adminSetMatch[2].toLowerCase();
    const days = 30;

    try {
      const { tier, expiresAt } = await updateUserSubscription(targetUserId, targetTier, days);
      const displayExpiry = expiresAt ? `${expiresAt} (KST)` : "무제한";

      await sendResponse(`✅ 성공적으로 등급이 설정되었습니다.\n- **대상 유저 ID**: ${targetUserId}\n- **설정된 등급**: \`${tier.toUpperCase()}\`\n- **만료 일자**: \`${displayExpiry}\``);

      try {
        const targetUser = await message.client.users.fetch(targetUserId);
        if (targetUser) {
          await targetUser.send(`🎉 **FLUX봇 등급 설정 완료**\n\n안녕하세요, **${targetUser.username}**님! 관리자가 등급을 설정했습니다.\n- **등급**: \`${tier.toUpperCase()}\`\n- **만료일**: \`${displayExpiry}\`\n\n지금부터 혜택이 적용됩니다!`);
        }
      } catch (dmErr) {
        console.log("Failed to send subscription confirmation DM to user:", dmErr.message);
      }
    } catch (error) {
      console.error("Failed to update user subscription:", error);
      await sendResponse("❌ 등급 설정 중 데이터베이스 오류가 발생했습니다.");
    }
    return true;
  }

  return false;
}
