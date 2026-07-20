import { db } from "./database.js";
import { logError, logInfo } from "../logger.js";

const DEFAULT_RAID_ROLE_NAME = "레이드 참여자";

export async function ensureRaidRole(guild, roleName = DEFAULT_RAID_ROLE_NAME) {
  if (!guild) return null;
  try {
    let role = null;
    const existing = await db.get("SELECT role_id FROM raid_config WHERE guild_id = $1", [guild.id]);
    if (existing?.role_id) {
      role = guild.roles.cache.get(existing.role_id) || await guild.roles.fetch(existing.role_id).catch(() => null);
    }
    if (!role) {
      role = guild.roles.cache.find(r => r.name === roleName);
    }
    if (!role) {
      role = await guild.roles.create({
        name: roleName,
        color: 0x5ce4ff,
        reason: "FLUX 레이드 참여 역할 자동 생성",
      });
      logInfo("raid_role_created", { guildId: guild.id, roleId: role.id, roleName });
    } else if (role.name !== roleName) {
      await role.edit({ name: roleName }, "FLUX 레이드 참여 역할 이름 변경").catch(() => {});
    }
    await db.run(
      "INSERT INTO raid_config (guild_id, channel_id, role_id, updated_at) VALUES ($1, $2, $3, TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS')) ON CONFLICT (guild_id) DO UPDATE SET role_id = $3, updated_at = TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS')",
      [guild.id, "", role.id]
    );
    return role;
  } catch (e) {
    logError("raid_role_ensure_failed", guild?.id, e);
    return null;
  }
}

export async function getRaidRoleId(guildId) {
  try {
    const row = await db.get("SELECT role_id FROM raid_config WHERE guild_id = $1", [guildId]);
    return row?.role_id || null;
  } catch {
    return null;
  }
}

export async function addRaidRoleToMember(guild, userId) {
  try {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return false;
    const roleId = await getRaidRoleId(guild.id);
    let role = roleId ? (guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null)) : null;
    if (!role) role = await ensureRaidRole(guild);
    if (!role) return false;
    if (member.roles.cache.has(role.id)) return true;
    await member.roles.add(role.id, "FLUX 레이드 참여");
    return true;
  } catch (e) {
    logError("raid_role_add_failed", guild?.id, e);
    return false;
  }
}

export function mentionRaidRole(roleId) {
  return roleId ? `<@&${roleId}>` : "";
}
