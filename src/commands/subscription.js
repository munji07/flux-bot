import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { ADMIN_USER_ID, PREFIX } from "../config.js";
import { getUserSubscription, updateUserSubscription, getDailyUsage, TIER_LIMITS, getKstNow } from "../services/subscription.js";

/**
 * 구독/등급 관련 채팅 명령어를 처리합니다.
 * @param {import("discord.js").Message} message 
 * @param {string} userPrompt 
 * @returns {Promise<boolean>} 처리 여부
 */
export async function handleSubscriptionCommand(message, userPrompt) {
  const trimmed = userPrompt.trim();

  // 1. 나의 등급 조회
  if (trimmed === "나의 등급" || trimmed === "나의등급" || trimmed === "등급") {
    const sub = getUserSubscription(message.author.id);
    const usage = getDailyUsage(message.author.id);
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
    replyText += `- 🔍 **이미지 판독**: ${usage.image_readings} / ${limits.image_readings}회\n\n`;
    replyText += `*※ 등급을 변경하려면 \`${PREFIX} 등급 구매\`를 입력해보세요.*`;

    await message.reply(replyText);
    return true;
  }

  // 2. 등급 구매 안내
  if (trimmed === "등급 구매" || trimmed === "등급구매" || trimmed === "구매") {
    const now = getKstNow();
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    const timeStr = `${hours}${minutes}`; // HHMM 형식
    
    const depositNameBasic = `${timeStr}-${message.author.id}`;
    const depositNamePremium = `${timeStr}-${message.author.id}`;

    // DM 내용 구성
    let dmContent = `## ✨ DUST봇 등급 구매 안내서\n\n`;
    dmContent += `안녕하세요, ${message.author.username}님! DUST봇의 유료 등급을 이용해주셔서 감사합니다.\n`;
    dmContent += `아래의 계좌로 구매를 원하시는 등급의 금액을 입금해주신 후, **[송금완료]** 버튼을 클릭해주세요.\n\n`;
    
    dmContent += `### 💳 입금 계좌 정보\n`;
    dmContent += `* **은행**: 토스뱅크\n`;
    dmContent += `* **계좌번호**: \`1908-8961-3017\`\n`;
    dmContent += `* **예금주**: 전민재 (개발자)\n\n`;

    dmContent += `### 🏷️ 등급별 요금 정보\n`;
    dmContent += `1. **Basic 등급 (3,000원 / 30일)**\n`;
    dmContent += `   - 하루 이미지 생성 3회\n`;
    dmContent += `   - 하루 이미지 판독 6회\n`;
    dmContent += `   - 하루 AI 호출량 30회\n\n`;
    dmContent += `2. **Premium 등급 (5,000원 / 30일)**\n`;
    dmContent += `   - 하루 이미지 생성 10회\n`;
    dmContent += `   - 하루 이미지 판독 25회\n`;
    dmContent += `   - 하루 AI 호출량 **무제한**\n\n`;

    dmContent += `### ⚠️ 중요: 입금자명 설정 안내\n`;
    dmContent += `정확하고 빠른 확인을 위해 입금하실 때 **입금자명**을 반드시 아래와 같이 정확하게 설정해 주세요.\n\n`;
    
    dmContent += `* **Basic 구매 시 입금자명**: \`${depositNameBasic}\`\n`;
    dmContent += `* **Premium 구매 시 입금자명**: \`${depositNamePremium}\`\n\n`;
    
    dmContent += `입금이 완료되면 아래 해당하는 등급의 **[송금완료]** 버튼을 눌러주세요. 개발자가 확인 후 등급을 부여해 드립니다.`;

    // 송금 완료 버튼 배치
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`sub_complete:basic:${message.author.id}:${timeStr}`)
        .setLabel("Basic (3,000원) 송금완료")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`sub_complete:premium:${message.author.id}:${timeStr}`)
        .setLabel("Premium (5,000원) 송금완료")
        .setStyle(ButtonStyle.Success)
    );

    try {
      // DM 발송
      await message.author.send({
        content: dmContent,
        components: [row]
      });

      await message.reply(`📩 ${message.author.username}님, 등급 구매 안내서를 **DM**으로 전송했습니다! DM을 확인하여 절차를 진행해 주세요.`);
    } catch (error) {
      console.error("Failed to send DM to user:", error);
      await message.reply(`❌ ${message.author.username}님에게 DM을 보낼 수 없습니다. 디스코드 설정에서 '서버 멤버가 보내는 개인 메시지 허용'이 켜져 있는지 확인해주세요.`);
    }
    return true;
  }

  // 3. 등급 부여 (개발자 전용)
  // 형식: !먼지야 등급부여 <유저ID> <free|basic|premium> [기간(일)]
  if (trimmed.startsWith("등급부여") || trimmed.startsWith("등급 부여")) {
    // 개발자 권한 체크
    if (message.author.id !== ADMIN_USER_ID) {
      await message.reply("❌ 이 명령어는 개발자만 사용할 수 있습니다.");
      return true;
    }

    const args = trimmed.split(/\s+/).slice(1);
    if (args.length < 2) {
      await message.reply(`⚠️ 사용법: \`${PREFIX} 등급부여 <유저ID> <free|basic|premium> [기간(일, 기본30일)]\``);
      return true;
    }

    const targetUserId = args[0].replace(/[<@!>]/g, ""); // 멘션일 경우 ID 추출
    const targetTier = args[1].toLowerCase();
    const days = args[2] ? parseInt(args[2], 10) : 30;

    if (!["free", "basic", "premium"].includes(targetTier)) {
      await message.reply("❌ 존재하지 않는 등급입니다. (선택형 등급: `free`, `basic`, `premium`)");
      return true;
    }

    if (isNaN(days) || days <= 0) {
      await message.reply("❌ 기간(일)은 양의 정수여야 합니다.");
      return true;
    }

    try {
      const { tier, expiresAt } = updateUserSubscription(targetUserId, targetTier, days);
      const displayExpiry = expiresAt ? `${expiresAt} (KST)` : "무제한";
      
      await message.reply(`✅ 성공적으로 등급이 변경되었습니다.\n- **대상 유저 ID**: ${targetUserId}\n- **부여된 등급**: \`${tier.toUpperCase()}\`\n- **만료 일자**: \`${displayExpiry}\``);
      
      // 등급이 부여된 사용자에게 안내 DM 발송 시도
      try {
        const targetUser = await message.client.users.fetch(targetUserId);
        if (targetUser) {
          await targetUser.send(`🎉 **DUST봇 등급 부여 완료**\n\n안녕하세요, **${targetUser.username}**님! 개발자가 입금을 확인하고 등급을 부여했습니다.\n- **등급**: \`${tier.toUpperCase()}\`\n- **만료일**: \`${displayExpiry}\`\n\n지금부터 혜택이 적용됩니다. 이용해주셔서 감사합니다!`);
        }
      } catch (dmErr) {
        console.log("Failed to send subscription confirmation DM to user:", dmErr.message);
      }

    } catch (error) {
      console.error("Failed to update user subscription:", error);
      await message.reply("❌ 등급 부여 중 데이터베이스 오류가 발생했습니다.");
    }
    return true;
  }

  return false;
}
