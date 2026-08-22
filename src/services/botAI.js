import { getCandidates, getAcceptableStarts } from "./wordEngine.js";
import { countStartingWith } from "./localDictService.js";

export const DIFFICULTIES = ["easy", "normal", "hard", "impossible"];
export const DIFFICULTY_LABELS = {
  easy: "쉬움",
  normal: "보통",
  hard: "어려움",
  impossible: "불가능",
};

const IMPOSSIBLE_SAMPLE = 40;

/**
 * 특정 글자 뒤에 이어갈 수 있는 단어 수 (동기, 즉시 계산).
 */
function contCount(char) {
  let n = countStartingWith(char);
  const subs = getAcceptableStarts(char);
  for (const s of subs) {
    if (s !== char) n += countStartingWith(s);
  }
  return n;
}

/**
 * 후보 단어 목록에서 난이도에 맞는 한 단어를 선택한다.
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
      candidates.sort((a, b) => b.length - a.length);
      return candidates[0];

    case "hard":
      candidates.sort((a, b) => a.length - b.length);
      return candidates[0];

    case "impossible": {
      const evalCount = Math.min(candidates.length, IMPOSSIBLE_SAMPLE);
      let bestWord = candidates[0];
      let bestScore = Infinity;
      const cache = new Map();

      for (let i = 0; i < evalCount; i++) {
        const c = candidates[i];
        if (!cache.has(c.last)) {
          cache.set(c.last, contCount(c.last));
        }
        const conts = cache.get(c.last);
        const score = conts * 1000 + c.length;
        if (score < bestScore) {
          bestScore = score;
          bestWord = c;
        }
      }
      return bestWord;
    }

    case "normal":
    default: {
      const idx = Math.floor(Math.random() * candidates.length);
      return candidates[idx];
    }
  }
}
