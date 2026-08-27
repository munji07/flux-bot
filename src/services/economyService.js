import { db } from "./database.js";
import { logError, logInfo } from "../logger.js";
import { ECONOMY_CONFIG } from "../config.js";
import { getUserSubscriptionTier } from "./subscription.js";

export class EconomyService {
  static async getOrCreateUser(userId, query = db) {
    try {
      let user = await query.get("SELECT * FROM eco_users WHERE user_id = $1", [userId]);
      if (!user) {
        await query.run("INSERT INTO eco_users (user_id, coins) VALUES ($1, 0) ON CONFLICT(user_id) DO NOTHING", [userId]);
        user = await query.get("SELECT * FROM eco_users WHERE user_id = $1", [userId]);
      }
      return user;
    } catch (error) {
      logError("economy_get_or_create_user", null, error, { userId });
      throw error;
    }
  }

  static async updateCoins(userId, amount, query = null) {
    try {
      if (query) {
        const user = await this.getOrCreateUser(userId, query);
        const updated = await query.get(
          "UPDATE eco_users SET coins = coins + $1, updated_at = TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS') WHERE user_id = $2 AND coins + $1 >= 0 RETURNING coins",
          [amount, userId],
        );
        if (!updated) return { success: false, balance: user.coins };
        return { success: true, balance: updated.coins };
      }
      return await db.transact(tx => this.updateCoins(userId, amount, tx));
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
        const sender = await this.getOrCreateUser(senderId, tx);
        const senderUpdate = await tx.get(
          "UPDATE eco_users SET coins = coins - $1, updated_at = TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS') WHERE user_id = $2 AND coins >= $1 RETURNING coins",
          [totalDeducted, senderId],
        );
        if (!senderUpdate) {
          return {
            success: false,
            senderBalance: sender.coins,
            fee,
            errorMessage: `잔액이 부족합니다. (송금액 ${amount.toLocaleString()} + 수수료 ${fee.toLocaleString()} = 합계 ${totalDeducted.toLocaleString()} 코인 필요)`,
          };
        }

        await this.getOrCreateUser(receiverId, tx);

        await tx.run("UPDATE eco_users SET coins = coins + $1, updated_at = TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS') WHERE user_id = $2", [amount, receiverId]);

        return { success: true, senderBalance: senderUpdate.coins, fee, errorMessage: null };
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
        ...ECONOMY_CONFIG.mining.rewards,
        ...ECONOMY_CONFIG.farming.rewards,
        ...ECONOMY_CONFIG.shop,
        { id: "wordchain_hint_ticket", name: "힌트권", description: "끝말잇기에서 단어 힌트를 확인합니다." },
        { id: "wordchain_pass_ticket", name: "패스권", description: "끝말잇기에서 봇의 차례로 넘깁니다." },
      ];

      return items
        .map(invItem => {
          const definition = allItemDefinitions.find(def => def.id === invItem.item_id);
          if (!definition) return null;
          return {
            item_id: invItem.item_id,
            quantity: invItem.quantity,
            name: definition.name,
            description: definition.description || "상세 설명이 없습니다.",
            sellPrice: definition.sellPrice || 0,
          };
        })
        .filter(Boolean);
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

  static async purchaseItem(userId, itemId, price) {
    try {
      return await db.transact(async (tx) => {
        await this.getOrCreateUser(userId, tx);
        const updated = await tx.get(
          "UPDATE eco_users SET coins = coins - $1, updated_at = TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS') WHERE user_id = $2 AND coins >= $1 RETURNING coins",
          [price, userId],
        );
        if (!updated) return { success: false, balance: 0 };

        await tx.run(
          `INSERT INTO eco_inventory (user_id, item_id, quantity)
           VALUES ($1, $2, 1)
           ON CONFLICT(user_id, item_id) DO UPDATE SET quantity = eco_inventory.quantity + 1`,
          [userId, itemId],
        );
        return { success: true, balance: updated.coins };
      });
    } catch (error) {
      logError("economy_purchase_item", null, error, { userId, itemId, price });
      return { success: false, balance: 0 };
    }
  }

  static async sellItems(userId, items) {
    try {
      return await db.transact(async (tx) => {
        let total = 0;
        for (const item of items) {
          const quantity = Number(item.quantity);
          const updated = await tx.get(
            "UPDATE eco_inventory SET quantity = quantity - $1 WHERE user_id = $2 AND item_id = $3 AND quantity >= $1 RETURNING quantity",
            [quantity, userId, item.item_id],
          );
          if (!updated) return { success: false, total: 0, balance: 0 };
          total += Number(item.sellPrice) * quantity;
        }

        await tx.run("DELETE FROM eco_inventory WHERE user_id = $1 AND quantity <= 0", [userId]);
        const balance = await tx.get(
          "UPDATE eco_users SET coins = coins + $1, updated_at = TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS') WHERE user_id = $2 RETURNING coins",
          [total, userId],
        );
        return { success: true, total, balance: Number(balance?.coins ?? 0) };
      });
    } catch (error) {
      logError("economy_sell_items", null, error, { userId });
      return { success: false, total: 0, balance: 0 };
    }
  }

  static async checkAndSetCooldown(userId, actionType) {
    const cooldownColumns = {
      fishing: "last_fishing",
      mining: "last_mining",
      farming: "last_farming",
      daily: "last_daily",
    };
    const column = cooldownColumns[actionType];
    const cooldownDuration = ECONOMY_CONFIG.cooldowns[actionType];
    if (!cooldownDuration) return { isCooldown: false, remaining: 0 };
    if (!column) return { isCooldown: true, remaining: 0 };

    try {
      return await db.transact(async (tx) => {
        await this.getOrCreateUser(userId, tx);
        const updated = await tx.get(
          `UPDATE eco_users
           SET ${column} = TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS'),
               updated_at = TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS')
           WHERE user_id = $1
             AND (
               ${column} IS NULL
                OR EXTRACT(EPOCH FROM (
                  (NOW() AT TIME ZONE 'Asia/Seoul') -
                  (TO_TIMESTAMP(${column}, 'YYYY-MM-DD HH24:MI:SS') AT TIME ZONE 'Asia/Seoul')
                )) * 1000 >= $2
             )
           RETURNING ${column}`,
          [userId, cooldownDuration],
        );

        if (updated) return { isCooldown: false, remaining: 0 };

        const user = await tx.get(`SELECT ${column} FROM eco_users WHERE user_id = $1`, [userId]);
        const lastActionTime = user?.[column]
          ? Date.parse(`${user[column].replace(" ", "T")}+09:00`)
          : Date.now();
        const remaining = Math.max(0, cooldownDuration - (Date.now() - lastActionTime));
        return { isCooldown: true, remaining };
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
