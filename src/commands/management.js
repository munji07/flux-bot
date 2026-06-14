import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  AutoModerationActionType,
  AutoModerationRuleEventType,
  AutoModerationRuleTriggerType,
  ChannelType,
  GuildVerificationLevel,
  PermissionFlagsBits,
} from "discord.js";
import { PREFIX, ADMIN_USER_ID } from "../config.js";
import { UserFacingError } from "../errors.js";
import { logError, logInfo } from "../logger.js";
import { extractDiscordId, normalizeCommand, splitArgs } from "../utils/command.js";
import { getDisplayName } from "../utils/message.js";
import { matchServerMember } from "../services/ai.js";
import { db } from "../services/database.js";
import { updateUserSubscription, TIER_LIMITS } from "../services/subscription.js";

const CONFIRMATION_TIMEOUT_MS = 30_000;
const DANGEROUS_COMMANDS = new Set([
  "kickMember",
  "banMember",
  "addRole",
  "removeRole",
  "addRolePermission",
  "removeRolePermission",
  "setVerificationLevel",
  "autoMod",
  "changeNickname",
]);
const pendingConfirmations = new Map();

function getPendingConfirmationKey(message) {
  return `${message.guildId}:${message.channelId}:${message.author.id}`;
}

function isConfirmTrigger(input) {
  return ["확인", "ok", "예", "응", "ㅇㅇ"].includes(normalizeCommand(input));
}

function isCancelTrigger(input) {
  return ["취소", "cancel", "아니요", "아니"].includes(normalizeCommand(input));
}

function getConfirmationPrompt(command, args) {
  const descriptions = {
    kickMember: "이 작업은 유저를 서버에서 추방하는 위험한 명령입니다.",
    banMember: "이 작업은 유저를 차단하는 위험한 명령입니다.",
    addRole: "이 작업은 유저에게 역할을 부여하는 위험한 명령입니다.",
    removeRole: "이 작업은 유저에게서 역할을 제거하는 위험한 명령입니다.",
    addRolePermission: "이 작업은 역할 권한을 변경하는 위험한 명령입니다.",
    removeRolePermission: "이 작업은 역할 권한을 변경하는 위험한 명령입니다.",
    setVerificationLevel: "이 작업은 서버 인증 단계를 변경하는 위험한 명령입니다.",
    autoMod: "이 작업은 서버 AutoMod 규칙을 변경하는 위험한 명령입니다.",
    changeNickname: "이 작업은 유저의 닉네임을 변경하는 위험한 명령입니다.",
  };

  const description = descriptions[command] ?? "이 작업은 위험할 수 있는 명령입니다.";
  const target = args.length > 0 ? `
요청한 대상: ${args.join(" ")}` : "";

  return `${description}${target}
계속하려면 30초 이내에 \`${PREFIX} 확인\`을 입력해주세요. 취소하려면 \`${PREFIX} 취소\`을 입력하거나 기다려주세요.`;
}

function createPendingConfirmation(message, command, args) {
  const key = getPendingConfirmationKey(message);
  const existing = pendingConfirmations.get(key);
  if (existing) {
    clearTimeout(existing.timeout);
  }

  const timeout = setTimeout(() => pendingConfirmations.delete(key), CONFIRMATION_TIMEOUT_MS);
  const pending = { command, args, timeout };
  pendingConfirmations.set(key, pending);
  return pending;
}

function clearPendingConfirmation(key) {
  const pending = pendingConfirmations.get(key);
  if (!pending) return null;
  clearTimeout(pending.timeout);
  pendingConfirmations.delete(key);
  return pending;
}

const COMMANDS = {
  help: "help",
  deleteMessage: "deleteMessage",
  purgeMessages: "purgeMessages",
  setSlowMode: "setSlowMode",
  timeoutMember: "timeoutMember",
  kickMember: "kickMember",
  banMember: "banMember",
  muteMember: "muteMember",
  deafenMember: "deafenMember",
  moveMember: "moveMember",
  disconnectMember: "disconnectMember",
  changeNickname: "changeNickname",
  autoMod: "autoMod",
  auditLog: "auditLog",
  setVerificationLevel: "setVerificationLevel",
  addRole: "addRole",
  removeRole: "removeRole",
  addRolePermission: "addRolePermission",
  removeRolePermission: "removeRolePermission",
};

const COMMAND_ALIASES = {
  관리도움말: COMMANDS.help,
  서버관리도움말: COMMANDS.help,
  help: COMMANDS.help,
  modhelp: COMMANDS.help,
  삭제: COMMANDS.deleteMessage,
  메시지삭제: COMMANDS.deleteMessage,
  deletemessage: COMMANDS.deleteMessage,
  delete: COMMANDS.deleteMessage,
  청소: COMMANDS.purgeMessages,
  일괄삭제: COMMANDS.purgeMessages,
  clear: COMMANDS.purgeMessages,
  purge: COMMANDS.purgeMessages,
  purgemessages: COMMANDS.purgeMessages,
  저속모드: COMMANDS.setSlowMode,
  슬로우: COMMANDS.setSlowMode,
  slowmode: COMMANDS.setSlowMode,
  setslowmode: COMMANDS.setSlowMode,
  타임아웃: COMMANDS.timeoutMember,
  대화금지: COMMANDS.timeoutMember,
  timeout: COMMANDS.timeoutMember,
  timeoutmember: COMMANDS.timeoutMember,
  추방: COMMANDS.kickMember,
  킥: COMMANDS.kickMember,
  kick: COMMANDS.kickMember,
  kickmember: COMMANDS.kickMember,
  차단: COMMANDS.banMember,
  밴: COMMANDS.banMember,
  영구추방: COMMANDS.banMember,
  ban: COMMANDS.banMember,
  banmember: COMMANDS.banMember,
  뮤트: COMMANDS.muteMember,
  서버뮤트: COMMANDS.muteMember,
  mute: COMMANDS.muteMember,
  mutemember: COMMANDS.muteMember,
  청각차단: COMMANDS.deafenMember,
  서버청각차단: COMMANDS.deafenMember,
  deaf: COMMANDS.deafenMember,
  deafen: COMMANDS.deafenMember,
  deafenmember: COMMANDS.deafenMember,
  이동: COMMANDS.moveMember,
  멤버이동: COMMANDS.moveMember,
  move: COMMANDS.moveMember,
  movemember: COMMANDS.moveMember,
  연결끊기: COMMANDS.disconnectMember,
  음성연결끊기: COMMANDS.disconnectMember,
  disconnect: COMMANDS.disconnectMember,
  disconnectmember: COMMANDS.disconnectMember,
  닉네임: COMMANDS.changeNickname,
  닉변: COMMANDS.changeNickname,
  changenickname: COMMANDS.changeNickname,
  오토모드: COMMANDS.autoMod,
  automod: COMMANDS.autoMod,
  감사로그: COMMANDS.auditLog,
  auditlog: COMMANDS.auditLog,
  보안수준: COMMANDS.setVerificationLevel,
  인증단계: COMMANDS.setVerificationLevel,
  verification: COMMANDS.setVerificationLevel,
  setverificationlevel: COMMANDS.setVerificationLevel,
  역할부여: COMMANDS.addRole,
  역할추가: COMMANDS.addRole,
  addrole: COMMANDS.addRole,
  역할제거: COMMANDS.removeRole,
  removerole: COMMANDS.removeRole,
  권한추가: COMMANDS.addRolePermission,
  권한부여: COMMANDS.addRolePermission,
  addpermission: COMMANDS.addRolePermission,
  addrolepermission: COMMANDS.addRolePermission,
  권한제거: COMMANDS.removeRolePermission,
  removepermission: COMMANDS.removeRolePermission,
  removerolepermission: COMMANDS.removeRolePermission,
};

export async function handleManagementCommand(message, userPrompt, loadingMessage) {
  const pendingKey = getPendingConfirmationKey(message);
  const pending = pendingConfirmations.get(pendingKey);

  if (pending && isConfirmTrigger(userPrompt)) {
    clearPendingConfirmation(pendingKey);
    if (loadingMessage) await loadingMessage.edit("확인을 받았습니다. 위험한 작업을 실행합니다.");

    try {
      await executeCommand(message, pending.command, pending.args, userPrompt, loadingMessage);
      logInfo("management_command_completed", {
        guildId: message.guildId,
        guildName: message.guild.name,
        channelId: message.channelId,
        userId: message.author.id,
        userName: getDisplayName(message),
        userTag: message.author.tag,
        command: pending.command,
        commandText: userPrompt,
      });
    } catch (error) {
      logError(`management_${pending.command}`, message.guildId, error, {
        guildName: message.guild.name,
        channelId: message.channelId,
        userId: message.author.id,
        userTag: message.author.tag,
        command: pending.command,
        commandText: userPrompt,
      });

      const replyText =
        error instanceof UserFacingError
          ? error.message
          : "위험한 작업을 실행하는 중 문제가 발생했어요. 권한이나 대상 상태를 확인해주세요.";

      if (loadingMessage) {
        await loadingMessage.edit(replyText).catch(() => message.reply(replyText));
        return true;
      }
      await message.reply(replyText).catch((replyError) => {
        logError("management_error_reply", message.guildId, replyError, {
          guildName: message.guild.name,
          channelId: message.channelId,
          userId: message.author.id,
          userTag: message.author.tag,
          command: pending.command,
        });
      });
    }

    return true;
  }

  if (pending && isCancelTrigger(userPrompt)) {
    clearPendingConfirmation(pendingKey);
    if (loadingMessage) await loadingMessage.edit("위험한 작업을 취소했어요.");
    return true;
  }

  const parsed = parseManagementCommand(userPrompt);
  if (!parsed) return false;

  const { command, args } = parsed;

  logInfo("management_command_detected", {
    guildId: message.guildId,
    guildName: message.guild.name,
    channelId: message.channelId,
    userId: message.author.id,
    userName: getDisplayName(message),
    userTag: message.author.tag,
    command,
    commandText: userPrompt,
  });

  if (DANGEROUS_COMMANDS.has(command)) {
    const confirmationText = getConfirmationPrompt(command, args);
    createPendingConfirmation(message, command, args);
    logInfo("management_confirmation_requested", {
      guildId: message.guildId,
      guildName: message.guild.name,
      channelId: message.channelId,
      userId: message.author.id,
      userName: getDisplayName(message),
      userTag: message.author.tag,
      command,
      commandText: userPrompt,
    });
    if (loadingMessage) await loadingMessage.edit(confirmationText);
    return true;
  }

  try {
    await executeCommand(message, command, args, userPrompt, loadingMessage);
    logInfo("management_command_completed", {
      guildId: message.guildId,
      guildName: message.guild.name,
      channelId: message.channelId,
      userId: message.author.id,
      userName: getDisplayName(message),
      userTag: message.author.tag,
      command,
      commandText: userPrompt,
    });
  } catch (error) {
    logError(`management_${command}`, message.guildId, error, {
      guildName: message.guild.name,
      channelId: message.channelId,
      userId: message.author.id,
      userTag: message.author.tag,
      command,
      commandText: userPrompt,
    });

    const replyText =
      error instanceof UserFacingError
        ? error.message
        : "관리 명령을 처리하는 중 문제가 발생했어요. 권한이나 대상 상태를 확인해주세요.";

    if (loadingMessage) {
      await loadingMessage.edit(replyText).catch(() => message.reply(replyText));
      return true;
    }
    await message.reply(replyText).catch((replyError) => {
      logError("management_error_reply", message.guildId, replyError, {
        guildName: message.guild.name,
        channelId: message.channelId,
        userId: message.author.id,
        userTag: message.author.tag,
        command,
      });
    });
  }

  return true;
}

export async function handleManagementToolCall(message, intent, userPrompt, loadingMessage) {
  const pendingKey = getPendingConfirmationKey(message);
  const pending = pendingConfirmations.get(pendingKey);
  const tool = intent?.tool;

  if (pending && tool === "confirm_management") {
    clearPendingConfirmation(pendingKey);
    if (loadingMessage) await loadingMessage.edit("확인했어요. 위험 작업을 실행할게요.");
    await executeCommand(message, pending.command, pending.args, userPrompt, loadingMessage);
    logInfo("management_command_completed", {
      guildId: message.guildId,
      guildName: message.guild.name,
      channelId: message.channelId,
      userId: message.author.id,
      userName: getDisplayName(message),
      userTag: message.author.tag,
      command: pending.command,
      commandText: userPrompt,
    });
    return true;
  }

  if (pending && tool === "cancel_management") {
    clearPendingConfirmation(pendingKey);
    if (loadingMessage) await loadingMessage.edit("위험 작업을 취소했어요.");
    return true;
  }

  if (tool !== "run_management") return false;

  const argsObject = intent?.arguments ?? {};
  const command = argsObject.command;
  const args = Array.isArray(argsObject.args) ? argsObject.args.map((arg) => String(arg)) : [];

  if (!Object.values(COMMANDS).includes(command)) {
    if (loadingMessage) await loadingMessage.edit("관리 작업을 이해하지 못했어요. 조금 더 구체적으로 말해 주세요.");
    return true;
  }

  logInfo("management_command_detected", {
    guildId: message.guildId,
    guildName: message.guild.name,
    channelId: message.channelId,
    userId: message.author.id,
    userName: getDisplayName(message),
    userTag: message.author.tag,
    command,
    commandText: userPrompt,
  });

  if (DANGEROUS_COMMANDS.has(command)) {
    const confirmationText = getConfirmationPrompt(command, args);
    createPendingConfirmation(message, command, args);
    logInfo("management_confirmation_requested", {
      guildId: message.guildId,
      guildName: message.guild.name,
      channelId: message.channelId,
      userId: message.author.id,
      userName: getDisplayName(message),
      userTag: message.author.tag,
      command,
      commandText: userPrompt,
    });
    if (loadingMessage) await loadingMessage.edit(confirmationText);
    return true;
  }

  await executeCommand(message, command, args, userPrompt, loadingMessage);
  logInfo("management_command_completed", {
    guildId: message.guildId,
    guildName: message.guild.name,
    channelId: message.channelId,
    userId: message.author.id,
    userName: getDisplayName(message),
    userTag: message.author.tag,
    command,
    commandText: userPrompt,
  });
  return true;
}

async function executeCommand(message, command, args, userPrompt, loadingMessage) {
  switch (command) {
    case COMMANDS.help:
      await loadingMessage.edit(getManagementHelpText());
      break;
    case COMMANDS.deleteMessage:
      await deleteMessageCommand(message, args, loadingMessage);
      break;
    case COMMANDS.purgeMessages:
      await purgeMessagesCommand(message, args, loadingMessage);
      break;
    case COMMANDS.setSlowMode:
      await slowModeCommand(message, args, loadingMessage);
      break;
    case COMMANDS.timeoutMember:
      await timeoutCommand(message, args, loadingMessage);
      break;
    case COMMANDS.kickMember:
      await kickCommand(message, args, loadingMessage);
      break;
    case COMMANDS.banMember:
      await banCommand(message, args, false, loadingMessage);
      break;
    case COMMANDS.muteMember:
      await voiceMuteCommand(message, args, loadingMessage);
      break;
    case COMMANDS.deafenMember:
      await voiceDeafenCommand(message, args, loadingMessage);
      break;
    case COMMANDS.moveMember:
      await moveMemberCommand(message, args, loadingMessage);
      break;
    case COMMANDS.disconnectMember:
      await disconnectMemberCommand(message, args, loadingMessage);
      break;
    case COMMANDS.changeNickname:
      await changeNicknameCommand(message, args, loadingMessage);
      break;
    case COMMANDS.autoMod:
      await autoModCommand(message, args, loadingMessage);
      break;
    case COMMANDS.auditLog:
      await auditLogCommand(message, args, loadingMessage);
      break;
    case COMMANDS.setVerificationLevel:
      await verificationLevelCommand(message, args, loadingMessage);
      break;
    case COMMANDS.addRole:
      await roleMemberCommand(message, args, "add", loadingMessage);
      break;
    case COMMANDS.removeRole:
      await roleMemberCommand(message, args, "remove", loadingMessage);
      break;
    case COMMANDS.addRolePermission:
      await rolePermissionCommand(message, args, "add", loadingMessage);
      break;
    case COMMANDS.removeRolePermission:
      await rolePermissionCommand(message, args, "remove", loadingMessage);
      break;
    default:
      throw new UserFacingError("알 수 없는 관리 명령이에요.");
  }
}

export function parseManagementCommand(input) {
  const tokens = splitArgs(input);
  if (tokens.length === 0) return null;

  const first = normalizeCommand(tokens[0]);
  const second = normalizeCommand(tokens[1] ?? "");

  if (first === "관리" && second === "도움말") {
    return { command: COMMANDS.help, args: tokens.slice(2) };
  }

  const command = COMMAND_ALIASES[first];
  if (command) {
    return { command, args: tokens.slice(1) };
  }

  if (tokens.length > 1) {
    const secondCommand = COMMAND_ALIASES[second];
    // 뒤에 '로그', '기록', '찾아', '검색' 등 조회성 단어가 붙으면 관리 명령이 아님
    // 예: "최근 타임아웃 로그 찾아줘" → timeoutMember 로 잘못 라우팅되는 문제 방지
    const trailingText = normalizeCommand(tokens.slice(2).join(""));
    const isQueryContext = ["로그", "기록", "찾아", "검색", "조회", "보여", "알려"].some((kw) => trailingText.includes(kw));
    if (secondCommand && !isQueryContext) {
      return { command: secondCommand, args: [tokens[0], ...tokens.slice(2)] };
    }
  }

  const naturalCommand = parseNaturalManagementCommand(tokens);
  if (naturalCommand) return naturalCommand;

  return null;
}

function parseNaturalManagementCommand(tokens) {
  const normalizedText = normalizeCommand(tokens.join(""));
  const amount = findCountArg(tokens);
  const mentionsCurrentChannel =
    normalizedText.includes("이채널") ||
    normalizedText.includes("이체널") ||
    normalizedText.includes("현재채널") ||
    normalizedText.includes("채널");
  const mentionsRecentMessages =
    normalizedText.includes("최근메시지") ||
    normalizedText.includes("최근글") ||
    normalizedText.includes("메시지") ||
    normalizedText.includes("채팅");
  const asksDelete =
    normalizedText.includes("삭제") ||
    normalizedText.includes("지워") ||
    normalizedText.includes("청소") ||
    normalizedText.includes("정리");

  if (amount && mentionsCurrentChannel && mentionsRecentMessages && asksDelete) {
    return {
      command: COMMANDS.purgeMessages,
      args: [amount],
    };
  }

  if (amount && normalizedText.includes("최근") && asksDelete) {
    return {
      command: COMMANDS.purgeMessages,
      args: [amount],
    };
  }

  return null;
}

function findCountArg(tokens) {
  for (const token of tokens) {
    const value = token
      .replace("개를", "")
      .replace("개만", "")
      .replace("개", "");
    const count = Number.parseInt(value, 10);

    if (String(count) === value && count >= 1 && count <= 100) {
      return String(count);
    }
  }

  return null;
}

async function assertGuildPermissions(message, userPermission, botPermission = userPermission) {
  const isAdmin = message.author.id === ADMIN_USER_ID;

  if (!isAdmin && !message.member?.permissions.has(userPermission)) {
    throw new UserFacingError("이 명령을 실행할 권한이 없어요.");
  }

  const botMember = message.guild.members.me ?? (await message.guild.members.fetchMe());

  if (!botMember.permissions.has(botPermission)) {
    throw new UserFacingError("먼지에게 이 작업을 수행할 권한이 없어요. 봇 역할 권한을 확인해주세요.");
  }

  return botMember;
}

async function deleteMessageCommand(message, args, loadingMessage) {
  await assertGuildPermissions(message, PermissionFlagsBits.ManageMessages);

  const messageId = args[0] ?? message.reference?.messageId;
  if (!messageId) {
    throw new UserFacingError(`삭제할 메시지 ID를 알려주시거나, 삭제할 메시지에 답장으로 \`${PREFIX} 삭제\`를 입력해주세요.`);
  }

  const targetMessage = await message.channel.messages.fetch(messageId).catch(() => null);
  if (!targetMessage) {
    throw new UserFacingError("삭제할 메시지를 찾지 못했어요. 같은 채널의 메시지 ID인지 확인해주세요.");
  }

  await targetMessage.delete();
  await loadingMessage.edit("메시지를 삭제했어요.");
}

async function purgeMessagesCommand(message, args, loadingMessage) {
  await assertGuildPermissions(message, PermissionFlagsBits.ManageMessages);

  const amount = Number.parseInt(args[0], 10);
  if (!Number.isInteger(amount) || amount < 1 || amount > 100) {
    throw new UserFacingError(`삭제할 개수를 1~100 사이로 입력해주세요. 예: \`${PREFIX} 청소 20\``);
  }

  if (typeof message.channel.bulkDelete !== "function") {
    throw new UserFacingError("이 채널에서는 일괄 삭제를 사용할 수 없어요.");
  }

  const deleted = await message.channel.bulkDelete(amount, true);
  await loadingMessage.edit(`최근 메시지 ${deleted.size}개를 정리했어요.`);
}

async function slowModeCommand(message, args, loadingMessage) {
  await assertGuildPermissions(message, PermissionFlagsBits.ManageMessages);

  const seconds = parseSlowModeSeconds(args[0]);
  if (typeof message.channel.setRateLimitPerUser !== "function") {
    throw new UserFacingError("이 채널에서는 저속 모드를 설정할 수 없어요.");
  }

  await message.channel.setRateLimitPerUser(seconds, createReason(message, "slow mode"));
  await loadingMessage.edit(seconds === 0 ? "저속 모드를 해제했어요." : `저속 모드를 ${seconds}초로 설정했어요.`);
}

async function timeoutCommand(message, args, loadingMessage) {
  await assertGuildPermissions(message, PermissionFlagsBits.ModerateMembers);

  const target = await resolveMember(message, args[0], "타임아웃할 유저를 멘션하거나 ID로 입력해주세요.");
  const durationMs = parseDurationMs(args[1]);
  const reason = args.slice(2).join(" ") || createReason(message, "timeout");

  if (!target.moderatable) {
    throw new UserFacingError("먼지가 해당 멤버를 타임아웃할 수 없어요. 역할 순서를 확인해주세요.");
  }

  await target.timeout(durationMs, reason);
  logInfo("member_timed_out", {
    guildId: message.guildId,
    guildName: message.guild.name,
    channelId: message.channelId,
    userId: message.author.id,
    userName: getDisplayName(message),
    userTag: message.author.tag,
    targetUserId: target.id,
    targetUserName: target.displayName,
    targetUserTag: target.user.tag,
    durationMs,
    reason,
    commandText: args.join(" "),
  });
  await loadingMessage.edit(`${target}님을 ${formatDurationMs(durationMs)} 동안 타임아웃했어요.`);
}

async function kickCommand(message, args, loadingMessage) {
  await assertGuildPermissions(message, PermissionFlagsBits.KickMembers);

  const target = await resolveMember(message, args[0], "추방할 유저를 멘션하거나 ID로 입력해주세요.");
  const reason = args.slice(1).join(" ") || createReason(message, "kick");

  if (!target.kickable) {
    throw new UserFacingError("먼지가 해당 멤버를 추방할 수 없어요. 역할 순서를 확인해주세요.");
  }

  await target.kick(reason);
  await loadingMessage.edit(`${target}님을 서버에서 추방했어요.`);
}

async function banCommand(message, args, isIpBanRequest, loadingMessage) {
  await assertGuildPermissions(message, PermissionFlagsBits.BanMembers);

  let targetMember = null;
  const userId = extractDiscordId(args[0]);

  if (userId) {
    targetMember = await message.guild.members.fetch(userId).catch(() => null);
  } else {
    targetMember = await resolveMember(message, args[0], "차단할 유저를 멘션하거나 ID로 입력해주세요.");
  }

  if (targetMember && !targetMember.bannable) {
    throw new UserFacingError("먼지가 해당 멤버를 차단할 수 없어요. 역할 순서를 확인해주세요.");
  }

  const reasonPrefix = isIpBanRequest ? "IP ban requested; Discord API supports account ban only. " : "";
  const reason = `${reasonPrefix}${args.slice(1).join(" ") || createReason(message, "ban")}`;

  await message.guild.members.ban(targetMember?.id ?? userId, {
    deleteMessageSeconds: 0,
    reason,
  });

  if (targetMember) {
    await loadingMessage.edit(
      isIpBanRequest
        ? `${targetMember}님을 차단했어요. 다만 Discord API는 봇에게 별도의 IP 차단 옵션을 제공하지 않아서 계정 차단으로 처리했어요.`
        : `${targetMember}님을 차단했어요.`,
    );
  } else {
    await loadingMessage.edit(
      isIpBanRequest
        ? "유저를 차단했어요. 다만 Discord API는 봇에게 별도의 IP 차단 옵션을 제공하지 않아서 계정 차단으로 처리했어요."
        : "유저를 차단했어요.",
    );
  }
}

async function voiceMuteCommand(message, args, loadingMessage) {
  await assertGuildPermissions(message, PermissionFlagsBits.MuteMembers);

  const target = await resolveMember(message, args[0], "서버 뮤트할 유저를 멘션하거나 ID로 입력해주세요.");
  const enabled = parseOnOff(args[1], true);

  if (!target.voice.channel) {
    throw new UserFacingError("해당 멤버가 음성 채널에 접속해 있지 않아요.");
  }

  await target.voice.setMute(enabled, createReason(message, "server mute"));
  await loadingMessage.edit(`${target}님의 서버 뮤트를 ${enabled ? "적용" : "해제"}했어요.`);
}

async function voiceDeafenCommand(message, args, loadingMessage) {
  await assertGuildPermissions(message, PermissionFlagsBits.DeafenMembers);

  const target = await resolveMember(message, args[0], "서버 청각 차단할 유저를 멘션하거나 ID로 입력해주세요.");
  const enabled = parseOnOff(args[1], true);

  if (!target.voice.channel) {
    throw new UserFacingError("해당 멤버가 음성 채널에 접속해 있지 않아요.");
  }

  await target.voice.setDeaf(enabled, createReason(message, "server deafen"));
  await loadingMessage.edit(`${target}님의 서버 청각 차단을 ${enabled ? "적용" : "해제"}했어요.`);
}

async function moveMemberCommand(message, args, loadingMessage) {
  await assertGuildPermissions(message, PermissionFlagsBits.MoveMembers);

  const target = await resolveMember(message, args[0], "이동할 유저를 멘션하거나 ID로 입력해주세요.");
  const channel = await resolveVoiceChannel(message, args.slice(1).join(" "));

  if (!target.voice.channel) {
    throw new UserFacingError("해당 멤버가 음성 채널에 접속해 있지 않아요.");
  }

  await target.voice.setChannel(channel, createReason(message, "move member"));
  await loadingMessage.edit(`${target}님을 ${channel.name} 채널로 이동했어요.`);
}

async function disconnectMemberCommand(message, args, loadingMessage) {
  await assertGuildPermissions(message, PermissionFlagsBits.MoveMembers);

  const target = await resolveMember(message, args[0], "연결을 끊을 유저를 멘션하거나 ID로 입력해주세요.");

  if (!target.voice.channel) {
    throw new UserFacingError("해당 멤버가 음성 채널에 접속해 있지 않아요.");
  }

  await target.voice.disconnect(createReason(message, "disconnect member"));
  await loadingMessage.edit(`${target}님의 음성 연결을 끊었어요.`);
}

async function changeNicknameCommand(message, args, loadingMessage) {
  await assertGuildPermissions(message, PermissionFlagsBits.ManageNicknames);

  const target = await resolveMember(message, args[0], "닉네임을 바꿀 유저를 멘션하거나 ID로 입력해주세요.");
  const nickname = args.slice(1).join(" ");
  const oldNickname = target.nickname ?? target.displayName ?? target.user.username;

  if (!target.manageable) {
    throw new UserFacingError("먼지가 해당 멤버의 닉네임을 변경할 수 없어요. 역할 순서를 확인해주세요.");
  }

  if (!nickname) {
    throw new UserFacingError(`새 닉네임을 입력해주세요. 예: \`${PREFIX} 닉네임 @유저 새닉네임\``);
  }

  const newNickname = ["초기화", "reset", "none"].includes(nickname.toLowerCase()) ? null : nickname;
  await target.setNickname(newNickname, createReason(message, "change nickname"));
  logInfo("nickname_changed", {
    guildId: message.guildId,
    guildName: message.guild.name,
    channelId: message.channelId,
    userId: message.author.id,
    userName: getDisplayName(message),
    userTag: message.author.tag,
    targetUserId: target.id,
    targetUserName: target.displayName,
    targetUserTag: target.user.tag,
    oldNickname,
    newNickname,
    commandText: args.join(" "),
  });
  await loadingMessage.edit(`${target}님의 닉네임을 변경했어요.`);
}

async function autoModCommand(message, args, loadingMessage) {
  await assertGuildPermissions(message, PermissionFlagsBits.ManageGuild);

  const subCommand = normalizeCommand(args[0] ?? "");

  if (["목록", "list"].includes(subCommand)) {
    const rules = await message.guild.autoModerationRules.fetch();
    const lines = rules.size
      ? [...rules.values()].slice(0, 10).map((rule) => `- ${rule.name} (${rule.enabled ? "켜짐" : "꺼짐"})`)
      : ["등록된 AutoMod 규칙이 없어요."];

    await loadingMessage.edit(lines.join("\n"));
    return;
  }

  if (!["키워드", "keyword"].includes(subCommand)) {
    throw new UserFacingError(`사용법: \`${PREFIX} 오토모드 키워드 단어1,단어2\` 또는 \`${PREFIX} 오토모드 목록\``);
  }

  const keywordFilter = args
    .slice(1)
    .join(" ")
    .split(/[,\s]+/)
    .map((keyword) => keyword.trim())
    .filter(Boolean)
    .slice(0, 100);

  if (keywordFilter.length === 0) {
    throw new UserFacingError("차단할 키워드를 1개 이상 입력해주세요.");
  }

  const rule = await message.guild.autoModerationRules.create({
    name: `먼지 키워드 차단 ${new Date().toISOString().slice(0, 10)}`,
    enabled: true,
    eventType: AutoModerationRuleEventType.MessageSend,
    triggerType: AutoModerationRuleTriggerType.Keyword,
    triggerMetadata: {
      keywordFilter,
    },
    actions: [
      {
        type: AutoModerationActionType.BlockMessage,
        metadata: {
          customMessage: "서버 AutoMod 규칙에 의해 차단되었어요.",
        },
      },
    ],
    reason: createReason(message, "create automod keyword rule"),
  });

  await loadingMessage.edit(`AutoMod 규칙 "${rule.name}"을 만들었어요.`);
}

async function auditLogCommand(message, args, loadingMessage) {
  await assertGuildPermissions(message, PermissionFlagsBits.ViewAuditLog);

  const limit = Math.min(Math.max(Number.parseInt(args[0] ?? "5", 10) || 5, 1), 10);
  const auditLogs = await message.guild.fetchAuditLogs({ limit });
  const lines = [...auditLogs.entries.values()].map((entry) => {
    const executor = entry.executor?.tag ?? entry.executorId ?? "알 수 없음";
    const target = entry.target?.tag ?? entry.target?.name ?? entry.targetId ?? "알 수 없음";
    return `- ${entry.action}: ${executor} -> ${target}`;
  });

  await loadingMessage.edit(lines.length > 0 ? lines.join("\n") : "감사 로그를 찾지 못했어요.");
}

async function verificationLevelCommand(message, args, loadingMessage) {
  await assertGuildPermissions(message, PermissionFlagsBits.ManageGuild);

  const level = resolveVerificationLevel(args[0]);
  await message.guild.setVerificationLevel(level, createReason(message, "set verification level"));
  await loadingMessage.edit(`서버 인증 단계를 ${GuildVerificationLevel[level]}(으)로 설정했어요.`);
}

async function roleMemberCommand(message, args, action, loadingMessage) {
  await assertGuildPermissions(message, PermissionFlagsBits.ManageRoles);

  const target = await resolveMember(message, args[0], "역할을 설정할 유저를 멘션하거나 ID로 입력해주세요.");
  const role = await resolveRole(message, args.slice(1).join(" "));

  if (action === "add") {
    await target.roles.add(role, createReason(message, "add role"));
    await loadingMessage.edit(`${target}님에게 ${role.name} 역할을 부여했어요.`);
    return;
  }

  await target.roles.remove(role, createReason(message, "remove role"));
  await loadingMessage.edit(`${target}님에게서 ${role.name} 역할을 제거했어요.`);
}

async function rolePermissionCommand(message, args, action, loadingMessage) {
  await assertGuildPermissions(message, PermissionFlagsBits.ManageRoles);

  const role = await resolveRole(message, args[0]);
  const permission = resolvePermissionFlag(args[1]);
  const permissions = role.permissions;

  if (action === "add") {
    await role.setPermissions(permissions.add(permission), createReason(message, "add role permission"));
    await loadingMessage.edit(`${role.name} 역할에 ${args[1]} 권한을 추가했어요.`);
    return;
  }

  await role.setPermissions(permissions.remove(permission), createReason(message, "remove role permission"));
  await loadingMessage.edit(`${role.name} 역할에서 ${args[1]} 권한을 제거했어요.`);
}

async function resolveMember(message, token, missingMessage) {
  const id = extractDiscordId(token);
  if (id) {
    const member = await message.guild.members.fetch(id).catch(() => null);
    if (!member) throw new UserFacingError("해당 멤버를 서버에서 찾지 못했어요.");
    return member;
  }

  if (!token) throw new UserFacingError(missingMessage);

  const normalizedToken = normalizeName(token);
  const exactMember = findExactMember(message, normalizedToken);
  if (exactMember) return exactMember;

  const fuzzyMember = await findBestMemberMatch(message, normalizedToken);
  if (fuzzyMember) return fuzzyMember;

  const aiMember = await findAiMemberMatch(message, token, normalizedToken);
  if (aiMember) return aiMember;

  throw new UserFacingError("해당 멤버를 서버에서 찾지 못했어요.");
}

function normalizeName(value) {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N} ]+/gu, "")
    .trim();
}

function findExactMember(message, normalizedToken) {
  return message.guild.members.cache.find((member) => {
    const username = normalizeName(member.user.username);
    const displayName = normalizeName(member.displayName);
    const tag = normalizeName(member.user.tag);
    return username === normalizedToken || displayName === normalizedToken || tag === normalizedToken;
  });
}

async function findBestMemberMatch(message, normalizedToken) {
  const candidates = [];
  const cachedMatches = [...message.guild.members.cache.values()].map((member) => ({
    member,
    score: getNameSimilarity(normalizedToken, normalizeName(member.displayName)) || getNameSimilarity(normalizedToken, normalizeName(member.user.username)) || getNameSimilarity(normalizedToken, normalizeName(member.user.tag)),
  }));

  candidates.push(...cachedMatches.filter((item) => item.score > 0));

  if (candidates.length < 5) {
    const fetchedMembers = await message.guild.members
      .fetch({ query: normalizedToken, limit: 10 })
      .catch(() => new Map());

    for (const member of fetchedMembers.values()) {
      if (message.guild.members.cache.has(member.id)) continue;
      const score =
        getNameSimilarity(normalizedToken, normalizeName(member.displayName)) ||
        getNameSimilarity(normalizedToken, normalizeName(member.user.username)) ||
        getNameSimilarity(normalizedToken, normalizeName(member.user.tag));
      if (score > 0) {
        candidates.push({ member, score });
    }
  }
}

  const best = candidates
    .sort((a, b) => b.score - a.score)
    .find((item) => item.score >= 0.4);

  return best?.member ?? null;
}

async function findAiMemberMatch(message, token, normalizedToken) {
  const candidates = await gatherAIMemberCandidates(message, token, normalizedToken);
  if (candidates.length === 0) return null;

  const match = await matchServerMember({
    guildName: message.guild.name,
    targetText: token,
    candidates,
    logContext: {
      guildId: message.guildId,
      userId: message.author.id,
      userName: getDisplayName(message),
    },
  });

  if (!match?.memberId) return null;

  return (
    message.guild.members.cache.get(match.memberId) ??
    (await message.guild.members.fetch(match.memberId).catch(() => null))
      );
    }

async function gatherAIMemberCandidates(message, token, normalizedToken) {
  const candidateById = new Map();

  // 유사도 점수로 정렬된 후보 수집 (점수 0인 멤버도 포함해 AI가 약칭/별명을 판단할 수 있도록)
  const allCached = [...message.guild.members.cache.values()]
    .map((member) => ({
      member,
      score:
        getNameSimilarity(normalizedToken, normalizeName(member.displayName)) ||
        getNameSimilarity(normalizedToken, normalizeName(member.user.username)) ||
        getNameSimilarity(normalizedToken, normalizeName(member.user.tag)),
    }))
    .sort((a, b) => b.score - a.score);

  // 유사도 있는 후보 우선, 없으면 전체에서 최대 30명
  const topCandidates = allCached.filter((item) => item.score > 0).slice(0, 20);
  const fallbackCandidates = topCandidates.length < 5
    ? allCached.slice(0, 30)
    : topCandidates;

  for (const item of fallbackCandidates) {
    candidateById.set(item.member.id, item.member);
  }

  // Discord API 검색으로 추가 후보 확보
  const fetchedMembers = await message.guild.members
    .fetch({ query: token, limit: 15 })
    .catch(() => new Map());

  for (const member of fetchedMembers.values()) {
    if (!candidateById.has(member.id)) {
      candidateById.set(member.id, member);
    }
  }

  return [...candidateById.values()].slice(0, 30);
}

function getNameSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;

  if (a.includes(b) || b.includes(a)) return 0.85;

  const distance = levenshteinDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 0 : Math.max(0, 1 - distance / maxLen);
}

function levenshteinDistance(a, b) {
  const matrix = Array.from({ length: b.length + 1 }, (_, i) => Array(a.length + 1).fill(0));

  for (let i = 0; i <= b.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= a.length; j += 1) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i += 1) {
    for (let j = 1; j <= a.length; j += 1) {
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + (a[j - 1] === b[i - 1] ? 0 : 1),
      );
    }
  }

  return matrix[b.length][a.length];
}

async function resolveVoiceChannel(message, input) {
  const id = extractDiscordId(input);
  const channel =
    (id ? await message.guild.channels.fetch(id).catch(() => null) : null) ??
    message.guild.channels.cache.find((guildChannel) => guildChannel.name === input);

  if (![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel?.type)) {
    throw new UserFacingError("이동할 음성 채널을 멘션, ID, 또는 정확한 이름으로 입력해주세요.");
  }

  return channel;
}

async function resolveRole(message, input) {
  const id = extractDiscordId(input);
  const role =
    (id ? await message.guild.roles.fetch(id).catch(() => null) : null) ??
    message.guild.roles.cache.find((guildRole) => guildRole.name === input);

  if (!role) {
    throw new UserFacingError("역할을 멘션, ID, 또는 정확한 이름으로 입력해주세요.");
  }

  return role;
}

function parseSlowModeSeconds(value) {
  if (!value) throw new UserFacingError(`초 단위 값을 입력해주세요. 예: \`${PREFIX} 저속모드 5\``);
  const seconds = Number.parseInt(value, 10);

  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 21600) {
    throw new UserFacingError("저속 모드는 0~21600초 사이로 설정할 수 있어요.");
  }

  return seconds;
}

function parseDurationMs(value) {
  if (!value) throw new UserFacingError(`시간을 입력해주세요. 예: \`${PREFIX} 타임아웃 @유저 10m 사유\``);

  const match = value.match(/^(\d+)(초|s|분|m|시간|h|일|d)?$/i);
  if (!match) {
    throw new UserFacingError("시간 형식은 `30s`, `10m`, `2h`, `1d`처럼 입력해주세요.");
  }

  const amount = Number.parseInt(match[1], 10);
  const unit = (match[2] ?? "m").toLowerCase();
  const multiplier = {
    초: 1000,
    s: 1000,
    분: 60 * 1000,
    m: 60 * 1000,
    시간: 60 * 60 * 1000,
    h: 60 * 60 * 1000,
    일: 24 * 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  }[unit];

  const durationMs = amount * multiplier;
  const maxDurationMs = 28 * 24 * 60 * 60 * 1000;

  if (!Number.isFinite(durationMs) || durationMs < 1000 || durationMs > maxDurationMs) {
    throw new UserFacingError("타임아웃은 1초 이상 28일 이하로 설정할 수 있어요.");
  }

  return durationMs;
}

function formatDurationMs(durationMs) {
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}시간`;
  return `${Math.round(hours / 24)}일`;
}

function parseOnOff(value, defaultValue) {
  if (!value) return defaultValue;
  const normalized = normalizeCommand(value);

  if (["on", "켜기", "적용", "true", "1"].includes(normalized)) return true;
  if (["off", "끄기", "해제", "false", "0"].includes(normalized)) return false;

  throw new UserFacingError("상태는 `on` 또는 `off`로 입력해주세요.");
}

function resolveVerificationLevel(value) {
  const levels = {
    없음: GuildVerificationLevel.None,
    none: GuildVerificationLevel.None,
    낮음: GuildVerificationLevel.Low,
    low: GuildVerificationLevel.Low,
    보통: GuildVerificationLevel.Medium,
    중간: GuildVerificationLevel.Medium,
    medium: GuildVerificationLevel.Medium,
    높음: GuildVerificationLevel.High,
    high: GuildVerificationLevel.High,
    매우높음: GuildVerificationLevel.VeryHigh,
    최고: GuildVerificationLevel.VeryHigh,
    veryhigh: GuildVerificationLevel.VeryHigh,
  };

  const level = levels[normalizeCommand(value ?? "")];
  if (level === undefined) {
    throw new UserFacingError(`인증 단계를 입력해주세요. 예: \`${PREFIX} 보안수준 높음\``);
  }

  return level;
}

function resolvePermissionFlag(value) {
  const aliases = {
    메시지관리: "ManageMessages",
    멤버타임아웃: "ModerateMembers",
    추방: "KickMembers",
    차단: "BanMembers",
    서버관리: "ManageGuild",
    감사로그: "ViewAuditLog",
    역할관리: "ManageRoles",
    닉네임관리: "ManageNicknames",
    서버뮤트: "MuteMembers",
    서버청각차단: "DeafenMembers",
    멤버이동: "MoveMembers",
  };

  const normalized = normalizeCommand(value ?? "");
  const permissionName =
    aliases[normalized] ??
    Object.keys(PermissionFlagsBits).find((key) => key.toLowerCase() === (value ?? "").toLowerCase());

  const permission = PermissionFlagsBits[permissionName];
  if (!permission) {
    throw new UserFacingError("권한 이름을 찾지 못했어요. 예: `ManageMessages`, `BanMembers`, `역할관리`");
  }

  return permission;
}

function createReason(message, action) {
  return `${action} by ${message.author.tag} (${message.author.id})`;
}

function getManagementHelpText() {
  return [
    "**먼지 관리 명령 도움말**",
    `\`${PREFIX} 삭제 <메시지ID>\` 또는 답장 후 \`${PREFIX} 삭제\``,
    `\`${PREFIX} 청소 <1~100>\`, \`${PREFIX} 저속모드 <초>\``,
    `\`${PREFIX} 타임아웃 @유저 10m 사유\`, \`${PREFIX} 추방 @유저 사유\`, \`${PREFIX} 차단 @유저 사유\``,
    `\`${PREFIX} 뮤트 @유저 on/off\`, \`${PREFIX} 청각차단 @유저 on/off\`, \`${PREFIX} 이동 @유저 <음성채널>\`, \`${PREFIX} 연결끊기 @유저\``,
    `\`${PREFIX} 닉네임 @유저 새닉네임\`, \`${PREFIX} 오토모드 키워드 단어1,단어2\`, \`${PREFIX} 감사로그 5\`, \`${PREFIX} 보안수준 높음\``,
    `\`${PREFIX} 역할부여 @유저 @역할\`, \`${PREFIX} 역할제거 @유저 @역할\`, \`${PREFIX} 권한추가 @역할 ManageMessages\`, \`${PREFIX} 권한제거 @역할 ManageMessages\``,
  ].join("\n");
}

