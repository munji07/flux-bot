import { db } from "./database.js";
import { logError, logInfo } from "../logger.js";
import { ECONOMY_CONFIG } from "../config/economyConfig.js";
import { getUserSubscriptionTier } from "./subscription.js";

export class EconomyService {
  static async getOrCreateUser(userId) {
    try {
      let user = await db.get("SELECT * FROM eco_users WHERE user_id = $1", [userId]);
      if (!user) {
        await db.run("INSERT INTO eco_users (user_id, coins) VALUES ($1, 0) ON CONFLICT(user_id) DO NOTHING", [userId]);
        user = await db.get("SELECT * FROM eco_users WHERE user_id = $1", [userId]);
      }
      return user;
    } catch (error) {
      logError("economy_get_or_create_user", null, error, { userId });
      throw error;
    }
  }

  static async updateCoins(userId, amount) {
    try {
      return await db.transact(async (tx) => {
        const user = await this.getOrCreateUser(userId);
        const newBalance = user.coins + amount;

        if (newBalance < 0) {
          return { success: false, balance: user.coins };
        }

        await tx.run("UPDATE eco_users SET coins = $1, updated_at = TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS') WHERE user_id = $2", [newBalance, userId]);

        return { success: true, balance: newBalance };
      });
    } catch (error) {
      logError("economy_update_coins", null, error, { userId, amount });
      return { success: false, balance: 0 };
    }
  }

  static async transferCoins(senderId, receiverId, amount) {
    if (amount <= 0) {
      return { success: false, senderBalance: 0, fee: 0, errorMessage: "올바르지 않은 송금 액수입니다." };
    }
    if (senderId === receiverId) {
      return { success: false, senderBalance: 0, fee: 0, errorMessage: "자기 자신에게는 송금할 수 없습니다." };
    }

    const tier = await getUserSubscriptionTier(senderId);
    const feeRate = ECONOMY_CONFIG.transferFee[tier] ?? ECONOMY_CONFIG.transferFee.free;
    const fee = Math.floor(amount * feeRate);
    const totalDeducted = amount + fee;

    try {
      return await db.transact(async (tx) => {
        const sender = await this.getOrCreateUser(senderId);
        if (sender.coins < totalDeducted) {
          return {
            success: false,
            senderBalance: sender.coins,
            fee,
            errorMessage: `잔액이 부족합니다. (송금액 ${amount.toLocaleString()} + 수수료 ${fee.toLocaleString()} = 합계 ${totalDeducted.toLocaleString()} 코인 필요)`,
          };
        }

        await this.getOrCreateUser(receiverId);

        await tx.run("UPDATE eco_users SET coins = coins - $1, updated_at = TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS') WHERE user_id = $2", [totalDeducted, senderId]);
        await tx.run("UPDATE eco_users SET coins = coins + $1, updated_at = TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS') WHERE user_id = $2", [amount, receiverId]);

        const updatedSender = await this.getOrCreateUser(senderId);
        return { success: true, senderBalance: updatedSender.coins, fee, errorMessage: null };
      });
    } catch (error) {
      logError("economy_transfer_coins", null, error, { senderId, receiverId, amount, fee });
      return { success: false, senderBalance: 0, fee: 0, errorMessage: "송금 도중 시스템 에러가 발생했습니다." };
    }
  }

  static async getInventory(userId) {
    try {
      const items = await db.all("SELECT item_id, quantity FROM eco_inventory WHERE user_id = $1 AND quantity > 0", [userId]);

      const allItemDefinitions = [
        ...ECONOMY_CONFIG.fishing.rewards,
        ...ECONOMY_CONFIG.shop,
      ];

      return items.map(invItem => {
        const definition = allItemDefinitions.find(def => def.id === invItem.item_id);
        return {
          item_id: invItem.item_id,
          quantity: invItem.quantity,
          name: definition ? definition.name : invItem.item_id,
          description: definition ? definition.description : "상세 설명이 없습니다.",
          sellPrice: definition ? (definition.sellPrice || 0) : 0,
        };
      });
    } catch (error) {
      logError("economy_get_inventory", null, error, { userId });
      return [];
    }
  }

  static async updateInventory(userId, itemId, quantity) {
    try {
      await db.run(
        `INSERT INTO eco_inventory (user_id, item_id, quantity)
         VALUES ($1, $2, $3)
         ON CONFLICT(user_id, item_id) DO UPDATE SET
           quantity = eco_inventory.quantity + EXCLUDED.quantity`,
        [userId, itemId, quantity],
      );

      await db.run("DELETE FROM eco_inventory WHERE user_id = $1 AND item_id = $2 AND quantity <= 0", [userId, itemId]);
      return true;
    } catch (error) {
      logError("economy_update_inventory", null, error, { userId, itemId, quantity });
      return false;
    }
  }

  static async checkAndSetCooldown(userId, actionType) {
    const cooldownDuration = ECONOMY_CONFIG.cooldowns[actionType];
    if (!cooldownDuration) return { isCooldown: false, remaining: 0 };

    try {
      return await db.transact(async (tx) => {
        const user = await this.getOrCreateUser(userId);
        const lastActionTime = user[`last_${actionType}`] ? new Date(user[`last_${actionType}`]).getTime() : 0;
        const now = Date.now();

        if (now - lastActionTime < cooldownDuration) {
          return { isCooldown: true, remaining: cooldownDuration - (now - lastActionTime) };
        }

        await tx.run(
          `UPDATE eco_users SET last_${actionType} = TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS') WHERE user_id = $1`,
          [userId],
        );

        return { isCooldown: false, remaining: 0 };
      });
    } catch (error) {
      logError("economy_check_cooldown", null, error, { userId, actionType });
      return { isCooldown: true, remaining: 0 };
    }
  }

  static async getRankings(limit = 10) {
    try {
      return await db.all("SELECT user_id, coins FROM eco_users ORDER BY coins DESC LIMIT $1", [limit]);
    } catch (error) {
      logError("economy_get_rankings", null, error, { limit });
      return [];
    }
  }
}
