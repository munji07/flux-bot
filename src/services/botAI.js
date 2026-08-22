import { getCandidates } from "./wordEngine.js";
import { countStartingWith } from "./localDictService.js";
import { getAcceptableStarts } from "./wordEngine.js";

export const DIFFICULTIES = ["easy", "normal", "hard", "impossible"];
export const DIFFICULTY_LABELS = {
  easy: "쉬움",
  normal: "보통",
  hard: "어려움",
  impossible: "불가능",
};

/**
 * 후보 단어의 마지막 글자로 이어갈 수 있는 단어 수를 센다.
 * 두음법칙 변환 글자도 함께 고려한다.
 */
async function countContinuations(lastChar) {
  const starts = getAcceptableStarts(lastChar);
  let total = 0;
  for (const s of starts) {
    total += await countStartingWith(s);
  }
  return total;
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
      // 각 후보의 마지막 글자로 이어갈 수 있는 단어 수를 계산
      // 유저의 선택지가 가장 적은 단어를 골라 궁지에 몰아넣는다
      let bestWord = candidates[0];
      let bestScore = Infinity;

      for (const c of candidates) {
        const continuations = await countContinuations(c.last);
        // 점수 = 이어갈 수 있는 단어 수 * 1000 + 단어 길이
        // 단어 수가 적을수록, 길이가 짧을수록 유저에게 불리
        const score = continuations * 1000 + c.length;
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
