// src/services/usage.js
const usageLimit = new Map(); // { userId: { count: number, date: string } }

export function checkAndIncrementVideoUsage(userId) {
  const today = new Date().toISOString().split('T')[0];
  const current = usageLimit.get(userId) || { count: 0, date: today };

  if (current.date !== today) {
    current.count = 0;
    current.date = today;
  }

  if (current.count >= 3) return false;

  current.count += 1;
  usageLimit.set(userId, current);
  return true;
}

export function decrementVideoUsage(userId) {
  const today = new Date().toISOString().split('T')[0];
  const current = usageLimit.get(userId);

  if (current && current.date === today && current.count > 0) {
    current.count -= 1;
    usageLimit.set(userId, current);
  }
}

