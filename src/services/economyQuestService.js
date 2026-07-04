import { db } from "./database.js";
import { ECONOMY_CONFIG } from "../config/economyConfig.js";
import { EconomyService } from "./economyService.js";
import { logError } from "../logger.js";

export class EconomyQuestService {
  static async getDailyQuests(userId) {
    try {
      const todayStr = new Date().toLocaleDateString("en-CA");
      const stored = await db.all("SELECT * FROM eco_quests WHERE user_id = $1 AND quest_date = $2", [userId, todayStr]);

      if (stored.length === 0) {
        for (const quest of ECONOMY_CONFIG.dailyQuests) {
          await db.run(
            "INSERT INTO eco_quests (user_id, quest_id, progress, completed, quest_date) VALUES ($1, $2, 0, 0, $3)",
            [userId, quest.id, todayStr],
          );
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

  static async incrementProgress(userId, actionType) {
    const newlyCompletedQuestNames = [];
    try {
      const todayStr = new Date().toLocaleDateString("en-CA");
      const quests = await this.getDailyQuests(userId);

      const matchedQuests = ECONOMY_CONFIG.dailyQuests.filter(q => q.type === actionType);

      for (const matched of matchedQuests) {
        const userProgress = quests.find(uq => uq.quest_id === matched.id);
        if (!userProgress || userProgress.completed) continue;

        const newProgress = userProgress.progress + 1;

        await db.run(
          "UPDATE eco_quests SET progress = $1 WHERE user_id = $2 AND quest_id = $3 AND quest_date = $4",
          [newProgress, userId, matched.id, todayStr],
        );

        if (newProgress >= matched.target) {
          newlyCompletedQuestNames.push(matched.name);
        }
      }
    } catch (error) {
      logError("economy_increment_quest_progress", null, error, { userId, actionType });
    }
    return newlyCompletedQuestNames;
  }

  static async claimQuestReward(userId, questId) {
    const todayStr = new Date().toLocaleDateString("en-CA");
    const definition = ECONOMY_CONFIG.dailyQuests.find(q => q.id === questId);

    if (!definition) {
      return { success: false, reward: 0, message: "존재하지 않는 퀘스트입니다." };
    }

    try {
      return await db.transact(async (tx) => {
        const quest = await tx.get(
          "SELECT * FROM eco_quests WHERE user_id = $1 AND quest_id = $2 AND quest_date = $3",
          [userId, questId, todayStr],
        );

        if (!quest) {
          return { success: false, reward: 0, message: "오늘 생성된 퀘스트 기록이 없습니다." };
        }
        if (quest.completed) {
          return { success: false, reward: 0, message: "이미 보상을 수령한 퀘스트입니다." };
        }
        if (quest.progress < definition.target) {
          return { success: false, reward: 0, message: "아직 퀘스트 목표를 달성하지 못했습니다." };
        }

        await tx.run(
          "UPDATE eco_quests SET completed = 1 WHERE user_id = $1 AND quest_id = $2 AND quest_date = $3",
          [userId, questId, todayStr],
        );

        await EconomyService.updateCoins(userId, definition.reward);

        return { success: true, reward: definition.reward, message: "보상을 받았습니다!" };
      });
    } catch (error) {
      logError("economy_claim_quest_reward", null, error, { userId, questId });
      return { success: false, reward: 0, message: "보상 수령 도중 DB 오류가 발생했습니다." };
    }
  }

  static async checkAndUnlockAchievement(userId, achievementId) {
    try {
      const hasUnlock = await db.get("SELECT 1 FROM eco_achievements WHERE user_id = $1 AND achievement_id = $2", [userId, achievementId]);
      if (hasUnlock) return false;

      const definition = ECONOMY_CONFIG.achievements.find(a => a.id === achievementId);
      if (!definition) return false;

      await db.run("INSERT INTO eco_achievements (user_id, achievement_id) VALUES ($1, $2)", [userId, achievementId]);

      await EconomyService.updateCoins(userId, definition.reward);
      return true;
    } catch (error) {
      logError("economy_unlock_achievement", null, error, { userId, achievementId });
      return false;
    }
  }

  static async getUnlockedAchievements(userId) {
    try {
      const unlocked = await db.all("SELECT achievement_id, unlocked_at FROM eco_achievements WHERE user_id = $1", [userId]);
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
