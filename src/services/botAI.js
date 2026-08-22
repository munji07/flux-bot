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

function contCount(char) {
  let n = countStartingWith(char);
  const subs = getAcceptableStarts(char);
  for (const s of subs) {
    if (s !== char) n += countStartingWith(s);
  }
  return n;
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
