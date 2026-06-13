import { db } from "./database.js";

// 등급별 하루 사용 한도 설정
export const TIER_LIMITS = {
  free: {
    name: "Free",
    ai_calls: 10,
    image_generations: 3,
    image_readings: 5,
  },
  basic: {
    name: "Basic",
    ai_calls: 30,
    image_generations: 6,
    image_readings: 10,
  },
  premium: {
    name: "Premium",
    ai_calls: Infinity, // 무제한
    image_generations: 15,
    image_readings: 30,
  },
};

// KST(한국 표준시) 날짜 및 시간 반환 함수들
export function getKstNow() {
  const utc = Date.now();
  const kstOffset = 9 * 60 * 60 * 1000;
  return new Date(utc + kstOffset);
}

export function getKstDateString(date = null) {
  const d = date || getKstNow();
  return d.toISOString().substring(0, 10); // YYYY-MM-DD
}

export function getKstDateTimeString(date = null) {
  const d = date || getKstNow();
  return d.toISOString().replace("T", " ").substring(0, 19); // YYYY-MM-DD HH:mm:ss
}

export function getExpiryKstDateTimeString(days = 30) {
  const utc = Date.now();
  const kstOffset = 9 * 60 * 60 * 1000;
  const daysMs = days * 24 * 60 * 60 * 1000;
  const expiryDate = new Date(utc + kstOffset + daysMs);
  return expiryDate.toISOString().replace("T", " ").substring(0, 19);
}

/**
 * 사용자의 구독 정보를 조회합니다. 만료일이 지난 경우 자동으로 free 등급으로 업데이트합니다.
 */
export function getUserSubscription(userId) {
  const row = db.prepare("SELECT tier, expires_at FROM user_subscriptions WHERE user_id = ?").get(userId);
  
  if (!row) {
    return { tier: "free", expires_at: null };
  }
  
  // 만료일 체크
  if (row.expires_at) {
    const nowStr = getKstDateTimeString();
    if (row.expires_at < nowStr) {
      // 구독 만료됨 -> free 등급으로 업데이트
      db.prepare(`
        UPDATE user_subscriptions 
        SET tier = 'free', expires_at = NULL, updated_at = ? 
        WHERE user_id = ?
      `).run(getKstDateTimeString(), userId);
      return { tier: "free", expires_at: null };
    }
  }
  
  return { tier: row.tier, expires_at: row.expires_at };
}

/**
 * 사용자의 등급을 수동으로 변경(부여)합니다. (개발자 어드민 기능)
 */
export function updateUserSubscription(userId, tier, days = 30) {
  const kstNow = getKstDateTimeString();
  const expiresAt = tier === "free" ? null : getExpiryKstDateTimeString(days);
  
  db.prepare(`
    INSERT INTO user_subscriptions (user_id, tier, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      tier = excluded.tier,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
  `).run(userId, tier, expiresAt, kstNow, kstNow);
  
  return { tier, expiresAt };
}

/**
 * 오늘의 사용량을 조회합니다.
 */
export function getDailyUsage(userId) {
  const todayStr = getKstDateString();
  
  const row = db.prepare(`
    SELECT ai_calls, image_generations, image_readings 
    FROM user_daily_usage 
    WHERE user_id = ? AND usage_date = ?
  `).get(userId, todayStr);
  
  if (!row) {
    return { ai_calls: 0, image_generations: 0, image_readings: 0 };
  }
  
  return row;
}

/**
 * 사용량을 체크하고, 한도를 초과하지 않았다면 사용량을 1 증가시킵니다.
 * @param {string} userId 
 * @param {'ai_calls' | 'image_generations' | 'image_readings'} type 
 * @returns {{allowed: boolean, current: number, limit: number, tier: string}}
 */
export function checkAndIncrementUsage(userId, type) {
  const sub = getUserSubscription(userId);
  const limits = TIER_LIMITS[sub.tier];
  const todayStr = getKstDateString();
  
  // 오늘 날짜의 레코드가 없는 경우 먼저 생성
  db.prepare(`
    INSERT OR IGNORE INTO user_daily_usage (user_id, usage_date, ai_calls, image_generations, image_readings)
    VALUES (?, ?, 0, 0, 0)
  `).run(userId, todayStr);
  
  const usage = db.prepare(`
    SELECT ai_calls, image_generations, image_readings 
    FROM user_daily_usage 
    WHERE user_id = ? AND usage_date = ?
  `).get(userId, todayStr);
  
  const currentCount = usage[type];
  const maxLimit = limits[type];
  
  if (currentCount >= maxLimit) {
    return {
      allowed: false,
      current: currentCount,
      limit: maxLimit,
      tier: sub.tier,
    };
  }
  
  // 사용량 1 증가
  db.prepare(`
    UPDATE user_daily_usage
    SET ${type} = ${type} + 1
    WHERE user_id = ? AND usage_date = ?
  `).run(userId, todayStr);
  
  return {
    allowed: true,
    current: currentCount + 1,
    limit: maxLimit,
    tier: sub.tier,
  };
}

/**
 * 사용량을 1 감소시킵니다. (오류 발생 시 롤백용)
 * @param {string} userId 
 * @param {'ai_calls' | 'image_generations' | 'image_readings'} type 
 */
export function decrementUsage(userId, type) {
  const todayStr = getKstDateString();
  
  db.prepare(`
    UPDATE user_daily_usage
    SET ${type} = CASE WHEN ${type} > 0 THEN ${type} - 1 ELSE 0 END
    WHERE user_id = ? AND usage_date = ?
  `).run(userId, todayStr);
}

