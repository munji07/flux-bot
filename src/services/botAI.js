import { getCandidates } from "./wordEngine.js";

export const DIFFICULTIES = ["easy", "normal", "hard", "impossible"];
export const DIFFICULTY_LABELS = {
  easy: "쉬움",
  normal: "보통",
  hard: "어려움",
  impossible: "불가능",
};

/**
 * 실시간 API 후보 단어 목록에서 난이도에 맞는 한 단어를 선택한다.
 * @param {string} lastChar 이어야 하는 마지막 글자
 * @param {Set<string>} used 이미 사용된 단어 집합
 * @param {string} difficulty 난이도
 * @returns {Promise<object|null>} 선택된 단어 객체
 */
export async function pickWord(lastChar, used, difficulty) {
  const candidates = await getCandidates(lastChar, used);
  if (!candidates.length) return null;

  switch (difficulty) {
    case "easy":
      // 길이가 긴 단어 선택 (유저가 이어받기 편한 길고 일반적인 단어)
      candidates.sort((a, b) => b.length - a.length);
      return candidates[0];
    case "hard":
    case "impossible":
      // 길이가 짧고 희귀한 단어 선택
      candidates.sort((a, b) => a.length - b.length);
      return candidates[0];
    case "normal":
    default: {
      const idx = Math.floor(Math.random() * candidates.length);
      return candidates[idx];
    }
  }
}
