import { db } from "./database.js";
import { logError, logInfo } from "../logger.js";
import { ECONOMY_CONFIG } from "../config/economyConfig.js";
import { getUserSubscriptionTier } from "./subscription.js";

export class EconomyService {
  /**
   * 유저의 정보를 가져옵니다. 없을 경우 기본값을 생성하여 반환합니다.
   * @param {string} userId
   * @returns {{user_id: string, coins: number, last_fishing: string|null, last_mining: string|null, last_farming: string|null, last_daily: string|null}}
   */
  static getOrCreateUser(userId) {
    try {
      let user = db.prepare("SELECT * FROM eco_users WHERE user_id = ?").get(userId);
      if (!user) {
        db.prepare("INSERT OR IGNORE INTO eco_users (user_id, coins) VALUES (?, 0)").run(userId);
        user = db.prepare("SELECT * FROM eco_users WHERE user_id = ?").get(userId);
      }
      return user;
    } catch (error) {
      logError("economy_get_or_create_user", null, error, { userId });
      throw error;
    }
  }

  /**
   * 코인을 증감시킵니다. (마이너스 불가, 음수 전달 시 자동 방지 혹은 수치 검증 가능)
   * 트랜잭션을 적용하여 동시성 이슈를 최소화합니다.
   * @param {string} userId
   * @param {number} amount 양수면 증가, 음수면 차감
   * @returns {{success: boolean, balance: number}}
   */
  static updateCoins(userId, amount) {
    const transaction = db.transaction(() => {
      const user = this.getOrCreateUser(userId);
      const newBalance = user.coins + amount;

      if (newBalance < 0) {
        return { success: false, balance: user.coins };
      }

      db.prepare(`
        UPDATE eco_users
        SET coins = ?, updated_at = datetime('now')
        WHERE user_id = ?
      `).run(newBalance, userId);

      return { success: true, balance: newBalance };
    });

    try {
      return transaction();
    } catch (error) {
      logError("economy_update_coins", null, error, { userId, amount });
      return { success: false, balance: 0 };
    }
  }

  /**
   * 다른 사용자에게 코인을 송금합니다. 등급에 따라 수수료가 부과됩니다.
   * - free / basic: 8% 수수료 (수신자는 송금액 그대로 받고 발신자가 수수료 부담)
   * - premium: 수수료 없음
   * @param {string} senderId
   * @param {string} receiverId
   * @param {number} amount 송금할 코인 (수신자가 받을 금액)
   * @returns {{success: boolean, senderBalance: number, fee: number, errorMessage: string|null}}
   */
  static transferCoins(senderId, receiverId, amount) {
    if (amount <= 0) {
      return { success: false, senderBalance: 0, fee: 0, errorMessage: "올바르지 않은 송금 액수입니다." };
    }
    if (senderId === receiverId) {
      return { success: false, senderBalance: 0, fee: 0, errorMessage: "자기 자신에게는 송금할 수 없습니다." };
    }

    // 발신자 등급 기반 수수료율 결정
    const tier = getUserSubscriptionTier(senderId);
    const feeRate = ECONOMY_CONFIG.transferFee[tier] ?? ECONOMY_CONFIG.transferFee.free;
    const fee = Math.floor(amount * feeRate);
    const totalDeducted = amount + fee; // 발신자가 실제로 내는 금액

    const transaction = db.transaction(() => {
      const sender = this.getOrCreateUser(senderId);
      if (sender.coins < totalDeducted) {
        return {
          success: false,
          senderBalance: sender.coins,
          fee,
          errorMessage: `잔액이 부족합니다. (송금액 ${amount.toLocaleString()} + 수수료 ${fee.toLocaleString()} = 합계 ${totalDeducted.toLocaleString()} 코인 필요)`,
        };
      }

      this.getOrCreateUser(receiverId);

      // 발신자: 송금액 + 수수료 차감
      db.prepare("UPDATE eco_users SET coins = coins - ?, updated_at = datetime('now') WHERE user_id = ?").run(totalDeducted, senderId);
      // 수신자: 송금액만 수령
      db.prepare("UPDATE eco_users SET coins = coins + ?, updated_at = datetime('now') WHERE user_id = ?").run(amount, receiverId);

      const updatedSender = this.getOrCreateUser(senderId);
      return { success: true, senderBalance: updatedSender.coins, fee, errorMessage: null };
    });

    try {
      return transaction();
    } catch (error) {
      logError("economy_transfer_coins", null, error, { senderId, receiverId, amount, fee });
      return { success: false, senderBalance: 0, fee: 0, errorMessage: "송금 도중 시스템 에러가 발생했습니다." };
    }
  }

  /**
   * 유저의 인벤토리를 조회합니다.
   * @param {string} userId
   * @returns {Array<{item_id: string, quantity: number, name: string, description: string, sellPrice: number}>}
   */
  static getInventory(userId) {
    try {
      const items = db.prepare("SELECT item_id, quantity FROM eco_inventory WHERE user_id = ? AND quantity > 0").all(userId);
      
      // 설정에 정의된 상세 정보 매핑
      const allItemDefinitions = [
        ...ECONOMY_CONFIG.fishing.rewards,
        ...ECONOMY_CONFIG.mining.rewards,
        ...ECONOMY_CONFIG.farming.rewards,
        ...ECONOMY_CONFIG.shop
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

  /**
   * 아이템을 인벤토리에 추가/차감합니다.
   * @param {string} userId
   * @param {string} itemId
   * @param {number} quantity 양수면 획득, 음수면 소모
   * @returns {boolean}
   */
  static updateInventory(userId, itemId, quantity) {
    try {
      db.prepare(`
        INSERT INTO eco_inventory (user_id, item_id, quantity)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id, item_id) DO UPDATE SET
          quantity = quantity + excluded.quantity
      `).run(userId, itemId, quantity);

      // 수량이 0 이하가 되면 테이블에서 행 정리
      db.prepare("DELETE FROM eco_inventory WHERE user_id = ? AND item_id = ? AND quantity <= 0").run(userId, itemId);
      return true;
    } catch (error) {
      logError("economy_update_inventory", null, error, { userId, itemId, quantity });
      return false;
    }
  }

  /**
   * 특정 카테고리 쿨다운을 검사하고 통과 시 갱신합니다.
   * @param {string} userId
   * @param {"fishing"|"mining"|"farming"|"daily"} actionType
   * @returns {{isCooldown: boolean, remaining: number}}
   */
  static checkAndSetCooldown(userId, actionType) {
    const cooldownDuration = ECONOMY_CONFIG.cooldowns[actionType];
    if (!cooldownDuration) return { isCooldown: false, remaining: 0 };

    const transaction = db.transaction(() => {
      const user = this.getOrCreateUser(userId);
      const lastActionTime = user[`last_${actionType}`] ? new Date(user[`last_${actionType}`]).getTime() : 0;
      const now = Date.now();

      if (now - lastActionTime < cooldownDuration) {
        return { isCooldown: true, remaining: cooldownDuration - (now - lastActionTime) };
      }

      db.prepare(`
        UPDATE eco_users
        SET last_${actionType} = datetime('now')
        WHERE user_id = ?
      `).run(userId);

      return { isCooldown: false, remaining: 0 };
    });

    return transaction();
  }

  /**
   * 랭킹 목록을 조회합니다.
   * @param {number} limit
   * @returns {Array<{user_id: string, coins: number}>}
   */
  static getRankings(limit = 10) {
    try {
      return db.prepare("SELECT user_id, coins FROM eco_users ORDER BY coins DESC LIMIT ?").all(limit);
    } catch (error) {
      logError("economy_get_rankings", null, error, { limit });
      return [];
    }
  }
}
