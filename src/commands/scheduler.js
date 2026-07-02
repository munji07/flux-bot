import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, PermissionFlagsBits } from "discord.js";
import { PREFIX } from "../config/config.js";
import { extractDiscordId } from "../utils/command.js";
import {
  cancelScheduledMessage,
  createScheduledMessage,
  formatKstDateTime,
  listScheduledMessages,
  rescheduleMessage,
} from "../services/scheduler.js";
import { getServerSubscriptionTier } from "../services/subscription.js";

export async function handleScheduleCommand(message, userPrompt, loadingMessage) {
  const normalized = userPrompt.trim();
  const hasScheduleKeyword = /예약\s*(?:메시지)?/i.test(normalized);
  if (!hasScheduleKeyword && !isScheduleCommand(normalized)) return false;

  const tier = getServerSubscriptionTier(message.guildId);
  if (tier !== "platinum") {
    await loadingMessage.edit(`❌ 예약 메시지 기능은 **플래티넘 서버(유료)** 전용 기능입니다.\n이 서버는 현재 플래티넘 라이선스가 없습니다. \`${PREFIX} 플래티넘 서버 구매\`를 입력하여 서버를 업그레이드해 보세요!`);
    return true;
  }

  // 목록 / 리스트 / 확인 / 조회 / 등록된
  if (/예약\s*(?:메시지)?\s*(?:리스트|목록|확인|조회|등록)/i.test(normalized)) {
    await handleScheduleList(message, loadingMessage);
    return true;
  }

  const cancelMatch = normalized.match(/예약\s*(?:취소|삭제)\s+(\d+)/i);
  if (cancelMatch) {
    await handleScheduleCancel(message, loadingMessage, Number.parseInt(cancelMatch[1], 10));
    return true;
  }

  const rescheduleMatch = normalized.match(/예약\s*(?:시간변경|변경)\s+(\d+)\s+(.+)/i);
  if (rescheduleMatch) {
    await handleScheduleTimeChange(
      message,
      loadingMessage,
      Number.parseInt(rescheduleMatch[1], 10),
      rescheduleMatch[2],
    );
    return true;
  }

  const createInput = normalized.replace(/^예약(?:메시지)?\s*/i, "").trim();
  if (!createInput) {
    await openScheduleModalButton(message, loadingMessage);
    return true;
  }

  const parsed = parseScheduleCreateInput(createInput);
  if (!parsed) {
    await openScheduleModalButton(message, loadingMessage);
    return true;
  }

  const task = createScheduledMessage({
    guildId: message.guildId,
    channelId: message.channelId,
    userId: message.author.id,
    content: parsed.content,
    executeAt: parsed.executeAt,
  });

  await loadingMessage.edit([
    "예약 메시지를 등록했어요.",
    `- ID: \`${task.id}\``,
    `- 시간: \`${task.execute_at} KST\``,
    `- 채널: <#${task.channel_id}>`,
    `- 내용: ${truncate(task.content, 300)}`,
  ].join("\n"));
  return true;
}

function isScheduleCommand(input) {
  return /^예약(?:메시지)?(?:\s|$)/i.test(input);
}

async function handleScheduleList(message, loadingMessage) {
  const includeAllUsers = message.member?.permissions.has(PermissionFlagsBits.ManageMessages) ?? false;
  const tasks = listScheduledMessages({
    guildId: message.guildId,
    userId: message.author.id,
    includeAllUsers,
  });

  if (tasks.length === 0) {
    await loadingMessage.edit("예약된 메시지가 없어요.");
    return;
  }

  const lines = tasks.map((task) => {
    const owner = includeAllUsers ? ` <@${task.user_id}>` : "";
    return `- \`${task.id}\` ${task.execute_at} KST <#${task.channel_id}>${owner}: ${truncate(task.content, 120)}`;
  });

  await loadingMessage.edit(["예약 메시지 목록이에요.", ...lines].join("\n"));
}

async function handleScheduleCancel(message, loadingMessage, id) {
  const isAdmin = message.member?.permissions.has(PermissionFlagsBits.ManageMessages) ?? false;
  const task = cancelScheduledMessage({
    guildId: message.guildId,
    userId: message.author.id,
    id,
    isAdmin,
  });

  await loadingMessage.edit(
    task
      ? `예약 메시지 \`${id}\`번을 취소했어요.`
      : `취소할 수 있는 예약 메시지 \`${id}\`번을 찾지 못했어요.`,
  );
}

async function handleScheduleTimeChange(message, loadingMessage, id, timeInput) {
  const parsed = parseScheduleTime(timeInput);
  if (!parsed) {
    await loadingMessage.edit("변경할 시간을 이해하지 못했어요. 예: `예약 시간변경 3 내일 09:30`");
    return;
  }

  const isAdmin = message.member?.permissions.has(PermissionFlagsBits.ManageMessages) ?? false;
  const task = rescheduleMessage({
    guildId: message.guildId,
    userId: message.author.id,
    id,
    executeAt: parsed.executeAt,
    isAdmin,
  });

  await loadingMessage.edit(
    task
      ? `예약 메시지 \`${id}\`번 시간을 \`${task.execute_at} KST\`로 변경했어요.`
      : `변경할 수 있는 예약 메시지 \`${id}\`번을 찾지 못했어요.`,
  );
}

function parseScheduleCreateInput(input) {
  const parsedTime = parseScheduleTime(input);
  if (!parsedTime) return null;

  const content = input.slice(parsedTime.consumed).trim();
  if (!content) return null;

  return {
    executeAt: parsedTime.executeAt,
    content,
  };
}

export function parseScheduleTime(input) {
  const trimmed = input.trim();

  const relative = trimmed.match(/^(\d+)\s*(분|시간|일)\s*(?:뒤|후)?(?:에)?/);
  if (relative) {
    const amount = Number.parseInt(relative[1], 10);
    const unitMs = {
      "분": 60_000,
      "시간": 60 * 60_000,
      "일": 24 * 60 * 60_000,
    }[relative[2]];
    return {
      executeAt: formatKstDateTime(new Date(Date.now() + amount * unitMs)),
      consumed: relative[0].length,
    };
  }

  const absolute = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (absolute) {
    return {
      executeAt: toKstString({
        year: Number.parseInt(absolute[1], 10),
        month: Number.parseInt(absolute[2], 10),
        day: Number.parseInt(absolute[3], 10),
        hour: Number.parseInt(absolute[4], 10),
        minute: Number.parseInt(absolute[5], 10),
      }),
      consumed: absolute[0].length,
    };
  }

  const dayRelative = trimmed.match(/^(오늘|내일)\s+(\d{1,2}):(\d{2})/);
  if (dayRelative) {
    const kstOffset = 9 * 60 * 60 * 1000;
    const kstNow = new Date(Date.now() + kstOffset);

    return {
      executeAt: toKstString({
        year: kstNow.getUTCFullYear(),
        month: kstNow.getUTCMonth() + 1,
        day: kstNow.getUTCDate() + (dayRelative[1] === "내일" ? 1 : 0),
        hour: Number.parseInt(dayRelative[2], 10),
        minute: Number.parseInt(dayRelative[3], 10),
      }),
      consumed: dayRelative[0].length,
    };
  }

  return null;
}

function toKstString({ year, month, day, hour, minute }) {
  return [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0"),
  ].join("-") + ` ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
}

function truncate(value, maxLength) {
  const text = String(value ?? "");
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

export const scheduleChannelMap = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [userId, timestamp] of scheduleChannelMap.entries()) {
    if (typeof timestamp === 'number' && now - timestamp > 5 * 60 * 1000) {
      scheduleChannelMap.delete(userId);
    }
  }
}, 60_000);

export async function openScheduleModalButton(message, loadingMessage) {
  const selectMenu = new ChannelSelectMenuBuilder()
    .setCustomId("schedule_channel_select")
    .setPlaceholder("메시지를 보낼 채널을 선택하세요")
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    .setMaxValues(1);

  const row = new ActionRowBuilder().addComponents(selectMenu);
  await loadingMessage.edit({
    content: "예약 메시지를 보낼 채널을 선택해주세요.",
    components: [row],
  });
}

export async function handleScheduleFromIntent(message, args, loadingMessage) {
  const tier = getServerSubscriptionTier(message.guildId);
  if (tier !== "platinum") {
    await loadingMessage.edit(`❌ 예약 메시지 기능은 **플래티넘 서버(유료)** 전용 기능입니다.\n이 서버는 현재 플래티넘 라이선스가 없습니다. \`${PREFIX} 플래티넘 서버 구매\`를 입력하여 서버를 업그레이드해 보세요!`);
    return true;
  }

  const action = args?.action;

  if (action === "list") {
    await handleScheduleList(message, loadingMessage);
    return true;
  }

  if (action === "cancel") {
    const id = Number.parseInt(args?.id, 10);
    if (!id) {
      await loadingMessage.edit(`취소할 예약 번호를 알려주세요. 예: \`${PREFIX} 예약 취소 1\``);
      return true;
    }
    await handleScheduleCancel(message, loadingMessage, id);
    return true;
  }

  if (action === "reschedule") {
    const id = Number.parseInt(args?.id, 10);
    const executeAt = args?.executeAt?.trim();
    if (!id || !executeAt) {
      await loadingMessage.edit(`변경할 예약 번호와 새 시간을 알려주세요. 예: \`${PREFIX} 예약 변경 1 내일 09:30\``);
      return true;
    }
    const isAdmin = message.member?.permissions.has(PermissionFlagsBits.ManageMessages) ?? false;
    const task = rescheduleMessage({
      guildId: message.guildId,
      userId: message.author.id,
      id,
      executeAt: executeAt + ":00",
      isAdmin,
    });
    await loadingMessage.edit(
      task
        ? `예약 메시지 \`${id}\`번 시간을 \`${task.execute_at} KST\`로 변경했어요.`
        : `변경할 수 있는 예약 메시지 \`${id}\`번을 찾지 못했어요.`,
    );
    return true;
  }

  // action === "create" or unspecified
  const executeAt = args?.executeAt?.trim();
  const channelInput = args?.channel?.trim();
  const msgContent = args?.message?.trim();

  if (!executeAt || !msgContent) {
    await openScheduleModalButton(message, loadingMessage);
    return true;
  }

  let targetChannel = message.channel;
  if (channelInput) {
    const rawId = extractDiscordId(channelInput) || channelInput.match(/\b\d{16,22}\b/)?.[0];
    if (rawId) {
      targetChannel = await message.guild.channels.fetch(rawId).catch(() => null);
    }
    if (!targetChannel) {
      targetChannel = message.guild.channels.cache.find(
        c => c.name === channelInput.replace(/^#/, "") && c.isTextBased(),
      );
    }
    if (!targetChannel || !targetChannel.isTextBased()) {
      targetChannel = message.channel;
    }
  }

  const task = createScheduledMessage({
    guildId: message.guildId,
    channelId: targetChannel.id,
    userId: message.author.id,
    content: msgContent,
    executeAt: executeAt + ":00",
  });

  await loadingMessage.edit([
    "예약 메시지를 등록했어요.",
    `- ID: \`${task.id}\``,
    `- 시간: \`${task.execute_at} KST\``,
    `- 채널: <#${targetChannel.id}>`,
    `- 내용: ${truncate(task.content, 300)}`,
  ].join("\n"));
  return true;
}
