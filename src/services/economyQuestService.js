import { db } from "./database.js";
import { ECONOMY_CONFIG } from "../config/economyConfig.js";
import { EconomyService } from "./economyService.js";
import { logError } from "../logger.js";

export class EconomyQuestService {
  /**
   * 유저의 오늘의 일일 퀘스트 진행 현황을 가져옵니다.
   * 없으면 기본값으로 삽입해줍니다.
   * @param {string} userId
   * @returns {Array<{quest_id: string, progress: number, completed: number, name: string, target: number, reward: number, description: string}>}
   */
  static getDailyQuests(userId) {
    try {
      const todayStr = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD
      const stored = db.prepare("SELECT * FROM eco_quests WHERE user_id = ? AND quest_date = ?").all(userId, todayStr);

      if (stored.length === 0) {
        // 오늘자 퀘스트 데이터 생성
        const insertStmt = db.prepare(`
          INSERT INTO eco_quests (user_id, quest_id, progress, completed, quest_date)
          VALUES (?, ?, 0, 0, ?)
        `);

        for (const quest of ECONOMY_CONFIG.dailyQuests) {
          insertStmt.run(userId, quest.id, todayStr);
        }

        return ECONOMY_CONFIG.dailyQuests.map(q => ({
          quest_id: q.id,
          progress: 0,
          completed: 0,
          name: q.name,
          target: q.target,
          reward: q.reward,
          description: q.description,
        }));
      }

      return stored.map(s => {
        const definition = ECONOMY_CONFIG.dailyQuests.find(q => q.id === s.quest_id);
        return {
          quest_id: s.quest_id,
          progress: s.progress,
          completed: s.completed,
          name: definition ? definition.name : s.quest_id,
          target: definition ? definition.target : 1,
          reward: definition ? definition.reward : 0,
          description: definition ? definition.description : "",
        };
      });
    } catch (error) {
      logError("economy_get_daily_quests", null, error, { userId });
      return [];
    }
  }

  /**
   * 특정 행동 타입(daily, gamble, work)에 대한 퀘스트 진행도를 1 올립니다.
   * 조건 충족 시 완료 가능 상태가 됩니다.
   * @param {string} userId
   * @param {"daily"|"gamble"|"work"} actionType
   * @returns {Promise<Array<string>>} 새롭게 목표를 채운 퀘스트 이름 목록
   */
  static incrementProgress(userId, actionType) {
    const newlyCompletedQuestNames = [];
    try {
      const todayStr = new Date().toLocaleDateString("en-CA");
      const quests = this.getDailyQuests(userId);

      // 설정 상 해당 퀘스트의 ID 추출
      const matchedQuests = ECONOMY_CONFIG.dailyQuests.filter(q => q.type === actionType);

      for (const matched of matchedQuests) {
        const userProgress = quests.find(uq => uq.quest_id === matched.id);
        if (!userProgress || userProgress.completed) continue;

        const newProgress = userProgress.progress + 1;
        
        db.prepare(`
          UPDATE eco_quests
          SET progress = ?
          WHERE user_id = ? AND quest_id = ? AND quest_date = ?
        `).run(newProgress, userId, matched.id, todayStr);

        if (newProgress >= matched.target) {
          newlyCompletedQuestNames.push(matched.name);
        }
      }
    } catch (error) {
      logError("economy_increment_quest_progress", null, error, { userId, actionType });
    }
    return newlyCompletedQuestNames;
  }

  /**
   * 완료된 일일 퀘스트의 보상을 수령합니다.
   * @param {string} userId
   * @param {string} questId
   * @returns {{success: boolean, reward: number, message: string}}
   */
  static claimQuestReward(userId, questId) {
    const todayStr = new Date().toLocaleDateString("en-CA");
    const definition = ECONOMY_CONFIG.dailyQuests.find(q => q.id === questId);
    
    if (!definition) {
      return { success: false, reward: 0, message: "존재하지 않는 퀘스트입니다." };
    }

    const transaction = db.transaction(() => {
      const quest = db.prepare("SELECT * FROM eco_quests WHERE user_id = ? AND quest_id = ? AND quest_date = ?").get(userId, questId, todayStr);
      
      if (!quest) {
        return { success: false, reward: 0, message: "오늘 생성된 퀘스트 기록이 없습니다." };
      }
      if (quest.completed) {
        return { success: false, reward: 0, message: "이미 보상을 수령한 퀘스트입니다." };
      }
      if (quest.progress < definition.target) {
        return { success: false, reward: 0, message: "아직 퀘스트 목표를 달성하지 못했습니다." };
      }

      // 완료 처리
      db.prepare("UPDATE eco_quests SET completed = 1 WHERE user_id = ? AND quest_id = ? AND quest_date = ?").run(userId, questId, todayStr);
      
      // 코인 지급
      EconomyService.updateCoins(userId, definition.reward);

      return { success: true, reward: definition.reward, message: "보상을 받았습니다!" };
    });

    try {
      return transaction();
    } catch (error) {
      logError("economy_claim_quest_reward", null, error, { userId, questId });
      return { success: false, reward: 0, message: "보상 수령 도중 DB 오류가 발생했습니다." };
    }
  }

  /**
   * 특정 업적의 달성 상태를 체크하고 해제합니다.
   * @param {string} userId
   * @param {string} achievementId
   * @returns {Promise<boolean>} 새로 업적이 달성되었으면 true, 아니면 false
   */
  static async checkAndUnlockAchievement(userId, achievementId) {
    try {
      // 이미 획득한 업적인지 확인
      const hasUnlock = db.prepare("SELECT 1 FROM eco_achievements WHERE user_id = ? AND achievement_id = ?").get(userId, achievementId);
      if (hasUnlock) return false;

      const definition = ECONOMY_CONFIG.achievements.find(a => a.id === achievementId);
      if (!definition) return false;

      // 업적 해제 등록
      db.prepare("INSERT INTO eco_achievements (user_id, achievement_id) VALUES (?, ?)").run(userId, achievementId);
      
      // 코인 보상 지급
      EconomyService.updateCoins(userId, definition.reward);
      return true;
    } catch (error) {
      logError("economy_unlock_achievement", null, error, { userId, achievementId });
      return false;
    }
  }

  /**
   * 유저가 달성한 업적 목록을 가져옵니다.
   * @param {string} userId
   * @returns {Array<{achievement_id: string, name: string, description: string, reward: number, unlocked_at: string}>}
   */
  static getUnlockedAchievements(userId) {
    try {
      const unlocked = db.prepare("SELECT achievement_id, unlocked_at FROM eco_achievements WHERE user_id = ?").all(userId);
      return unlocked.map(u => {
        const definition = ECONOMY_CONFIG.achievements.find(a => a.id === u.achievement_id);
        return {
          achievement_id: u.achievement_id,
          name: definition ? definition.name : u.achievement_id,
          description: definition ? definition.description : "달성 완료",
          reward: definition ? definition.reward : 0,
          unlocked_at: u.unlocked_at,
        };
      });
    } catch (error) {
      logError("economy_get_unlocked_achievements", null, error, { userId });
      return [];
    }
  }
}
