import { getCandidates } from "./wordEngine.js";
import { countContinuationsForChar } from "./localDictService.js";

export const DIFFICULTIES = ["easy", "normal", "hard", "impossible"];
export const DIFFICULTY_LABELS = {
  easy: "쉬움",
  normal: "보통",
  hard: "어려움",
  impossible: "불가능",
};

async function contCount(char) {
  return countContinuationsForChar(char);
}

function pickLongest(arr) {
  let best = arr[0];
  for (let i = 1; i < arr.length; i++) {
    if (arr[i].length > best.length) best = arr[i];
  }
  return best;
}

function pickShortest(arr) {
  let best = arr[0];
  for (let i = 1; i < arr.length; i++) {
    if (arr[i].length < best.length) best = arr[i];
  }
  return best;
}

export async function pickWord(lastChar, used, difficulty) {
  const candidates = await getCandidates(lastChar, used);
  if (!candidates.length) return null;

  switch (difficulty) {
    case "easy":
      return pickLongest(candidates);

    case "hard":
      return pickShortest(candidates);

    case "impossible": {
      let bestWord = null;
      let bestScore = Infinity;
      let fallbackWord = null;
      const cache = new Map();

      for (const c of candidates) {
        if (!cache.has(c.last)) {
          cache.set(c.last, await contCount(c.last));
        }
        const conts = cache.get(c.last);
        // 상대가 선택할 수 있는 단어가 적을수록 강한 수입니다.
        // 단, 이어갈 수 없는 단어는 봇의 즉시 패배이므로 다른 선택지가 있으면 제외합니다.
        if (conts === 0) {
          fallbackWord ??= c;
          continue;
        }
        const score = conts * 1000 - c.length;
        if (score < bestScore) {
          bestScore = score;
          bestWord = c;
        }
      }
      return bestWord ?? fallbackWord;
    }

    case "normal":
    default: {
      const idx = Math.floor(Math.random() * candidates.length);
      return candidates[idx];
    }
  }
}
