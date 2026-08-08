import { getCandidates, getDangerWithIndex, countKillerMovesWithIndex, hasContinuationWithIndex, getCandidatesExcluding, buildUsedIndex } from "./wordEngine.js";

/**
 * BotAI
 *
 * 후보 단어 목록에서 난이도에 따라 전략적으로 한 단어를 선택한다.
 *
 * 전략의 핵심은 위험도(Danger):
 *   위험도 0 = 한방단어 (상대가 이어갈 수 없음)
 *   위험도가 높을수록 상대가 이어가기 쉬움
 *
 * 난이도별 선택 기준:
 *   easy       - 위험도가 높은(안전한) 단어를 우선 → 유저가 이어가기 쉬움
 *   normal     - 적당한 위험도의 단어를 선택
 *   hard       - 위험도가 낮은 단어를 우선 → 상대를 압박
 *   impossible - 위협도 순 상위 후보로 2수 내다보기: 한방 우선 → 다음 턴 한방 후보 최대화
 *
 * 위험도가 같을 때 동점 처리 순서:
 *   1. 더 긴 단어
 *   2. 희귀 단어 (hit이 낮을수록 희귀)
 *   3. 북한어
 *   4. 랜덤
 */

export const DIFFICULTIES = ["easy", "normal", "hard", "impossible"];
export const DIFFICULTY_LABELS = {
  easy: "쉬움",
  normal: "보통",
  hard: "어려움",
  impossible: "불가능",
};

/** 난이도별 선택 풀 비율 (hard/easy: 최저/최고 위험도에서 일부만 고려해 약간의 랜덤성 부여) */
// 일반 난이도는 최선 후보에 덜 고정해 실수와 변칙 수를 허용한다.
const POOL_RATIO = 0.5;

// 불가능 난이도의 2수 시뮬레이션 검색 예산.
// 후보 단어 수가 수천 개에 달하므로 위협도 순 상위 N개만 시뮬레이션해
// 턴당 완료 시간을 보장한다. (값이 클수록 강하지만 느려짐)
const MAX_CANDIDATES = 40;
const MAX_OPPONENTS = 25;
const MAX_BOTMOVES = 20;
const MAX_NEXT_MOVES = 35;
// 봇 응답 하나당 한방(위협) 후보를 검사할 최대 단어 수. (버킷이 커도 시간을 보장)
const MAX_KILLER_SCAN = 300;
// 봇 응답 선별 시 한방 수를 근사할 때 검사할 최대 단어 수. (정확한 계산보다 저렴)
const KILLER_PRE_SCAN = 120;

/**
 * 후보 단어 목록에서 난이도에 맞는 한 단어를 선택한다.
 * @param {string} lastChar 이어야 하는 마지막 글자
 * @param {Set<string>} used 이미 사용된 단어 집합
 * @param {string} difficulty 난이도 (easy/normal/hard/impossible)
 * @returns {object|null} 선택된 단어 객체 (후보가 없으면 null)
 */
export function pickWord(lastChar, used, difficulty) {
  const candidates = getCandidates(lastChar, used);
  if (!candidates.length) return null;

  // 사용 단어를 시작 글자별로 색인해 두고, 모든 위험도/한방 계산을 이 색인으로 수행한다.
  const usedIndex = buildUsedIndex(used);
  // 위험도 계산 (동일 마지막 글자의 중복 계산 방지를 위해 캐싱)
  const dangerCache = new Map();
  const killerCache = new Map();
  const scored = candidates.map((word) => {
    if (!dangerCache.has(word.last)) dangerCache.set(word.last, getDangerWithIndex(word, usedIndex));
    if (!killerCache.has(word.last)) killerCache.set(word.last, countKillerMovesWithIndex(word.last, used, usedIndex));
    return { word, danger: dangerCache.get(word.last), killers: killerCache.get(word.last) };
  });

  // hard: 상대에게 한방 단어 기회를 최소화하는 후보를 우선한다.
  if (difficulty === "hard") {
    const minKillers = Math.min(...scored.map((s) => s.killers));
    const filtered = scored.filter((s) => s.killers === minKillers);
    return pickHard(filtered).word;
  }

  // impossible: 공격적인 후보 상위 예산으로 2수 시뮬레이션 평가
  if (difficulty === "impossible") {
    return pickImpossible(scored, used, usedIndex).word;
  }

  switch (difficulty) {
    case "easy":
      return pickEasy(scored).word;
    case "normal":
    default:
      return pickNormal(scored).word;
  }
}

/** easy: 위험도 높은(안전한) 쪽 풀에서 선택 */
function pickEasy(scored) {
  const sorted = [...scored].sort((a, b) => b.danger - a.danger);
  const pool = topPool(sorted, true);
  return tieBreak(pool, true);
}

/** normal: 위험도 중앙값 주변의 후보 선택 */
function pickNormal(scored) {
  const dangers = scored.map((s) => s.danger).sort((a, b) => a - b);
  const median = dangers[Math.floor(dangers.length / 2)];
  const near = scored.filter((s) => Math.abs(s.danger - median) <= 4);
  return tieBreak(near.length ? near : scored, false);
}

/** hard: 위험도 낮은 쪽 풀에서 선택 */
function pickHard(scored) {
  const sorted = [...scored].sort((a, b) => a.danger - b.danger);
  const pool = topPool(sorted, false);
  return pickRandomTop(pool, 8, false);
}

/**
 * impossible: 최강 전략
 *
 * 1순위: 한방 단어 (danger 0) — 즉시 승리
 * 2순위: 봇이 유리한 턴 포지션을 만드는 후보 (2수 시뮬레이션)
 *
 * 각 후보에 대해:
 *   - 유저의 최선 응대 시뮬레이션 (danger 최소 단어 선택)
 *   - 봇의 후속 턴 평가 (danger + killer + 후속 한방 기회)
 */
function pickImpossible(scored, used, usedIndex) {
  const min = Math.min(...scored.map((s) => s.danger));
  if (min === 0) {
    const killers = scored.filter((s) => s.danger === 0);
    return tieBreak(killers, false);
  }

  // 공격적인(위험도·한방 낮고 긴) 후보부터 시뮬레이션하고, 예산 초과 시 상위만 평가한다.
  const prioritized = [...scored].sort(
    (a, b) => a.danger - b.danger || a.killers - b.killers || b.word.length - a.word.length,
  );
  const budget = prioritized.slice(0, MAX_CANDIDATES);

  const evaluated = budget.map((s) => ({
    ...s,
    eval: evaluateForBot(s.word, used, usedIndex),
  }));

  evaluated.sort((a, b) => b.eval - a.eval);

  // 최적 수 하나만 고르면 같은 입력에서 같은 공략 루트가 반복된다.
  // 상위 후보군 안에서 무작위로 선택해 전략의 질은 유지하면서 경로를 분산한다.
  // 불가능 난이도는 동점권에서 운으로 약화하지 않고 최고 평가 수를 선택한다.
  return pickRandomTop(evaluated, 1, false);
}

function pickRandomTop(scored, count, preferHigh) {
  const top = scored.slice(0, Math.min(count, scored.length));
  const selected = top[Math.floor(Math.random() * top.length)];
  return selected ?? tieBreak(scored, preferHigh);
}

/**
 * 봇이 이 단어를 냈을 때, 유저의 최선 응대 후 봇이 받는 점수를 계산한다.
 * 점수가 높을수록 봇에게 유리한 포지션.
 *
 * 성능: 사용 단어 색인(usedIndex)과 시작 글자 버킷 메모(bucketMemo)로
 * Set 복제·버킷 재스캔을 제거하고, 각 단계를 위협도 순으로 상위 N개만
 * 시뮬레이션한다. (위협도 = 상대가 이어갈 수 있는 단어 수)
 */
function evaluateForBot(word, used, usedIndex) {
  // 시작 글자 → (기본 used 제외) 후보 목록 메모. evaluateForBot 1회 내에서 재사용.
  const bucketMemo = new Map();
  const unusedWords = (lastChar) => {
    if (!bucketMemo.has(lastChar)) bucketMemo.set(lastChar, getCandidatesExcluding(lastChar, used));
    return bucketMemo.get(lastChar);
  };

  // 한방 단어 수를 버킷 상위 KILLER_PRE_SCAN개만 검사해 근사한다. (선별용 저렴 경로)
  const countKillersCapped = (lastChar, extraWords) => {
    let count = 0;
    let scanned = 0;
    for (const w of unusedWords(lastChar)) {
      if (extraWords.includes(w.word)) continue;
      if (++scanned > KILLER_PRE_SCAN) break;
      if (!hasContinuationWithIndex(w.last, usedIndex, extraWords, w.word)) count++;
    }
    return count;
  };

  const wordExtras = [word.word];
  // 유저의 최선 응대는 봇에게 가장 위협적인(이어갈 수 있는 단어가 적은) 단어로 근사한다.
  const oppCandidates = unusedWords(word.last)
    .filter((w) => !wordExtras.includes(w.word))
    .map((w) => ({ w, danger: getDangerWithIndex(w, usedIndex, wordExtras) }))
    .sort((a, b) => a.danger - b.danger)
    .slice(0, MAX_OPPONENTS)
    .map((e) => e.w);
  if (!oppCandidates.length) return 10000;

  let worstScore = Infinity;
  for (const oppWord of oppCandidates) {
    const afterOppExtras = [word.word, oppWord.word];
    const allBot = unusedWords(oppWord.last).filter((w) => !afterOppExtras.includes(w.word));
    if (!allBot.length) {
      worstScore = -10000;
      break;
    }
    // 1차: 위협도(저렴)로 상위만 거른 뒤 2차: 한방 수 근사치 기준으로 정렬한다.
    const dangerSorted = allBot
      .map((w) => ({ w, danger: getDangerWithIndex(w, usedIndex, afterOppExtras) }))
      .sort((a, b) => a.danger - b.danger)
      .slice(0, MAX_BOTMOVES * 2);
    const botCandidates = dangerSorted
      .map((e) => ({ w: e.w, killers: countKillersCapped(e.w.last, afterOppExtras) }))
      .sort((a, b) => a.killers - b.killers)
      .slice(0, MAX_BOTMOVES)
      .map((e) => e.w);

    let bestBotScore = -Infinity;
    for (const botWord of botCandidates) {
      const afterBotExtras = [word.word, oppWord.word, botWord.word];

      const botDanger = getDangerWithIndex(botWord, usedIndex, afterBotExtras);
      let botKillers = 0;
      let killerScanned = 0;
      for (const w of unusedWords(botWord.last)) {
        if (afterBotExtras.includes(w.word)) continue;
        if (++killerScanned > MAX_KILLER_SCAN) break;
        if (!hasContinuationWithIndex(w.last, usedIndex, afterBotExtras, w.word)) botKillers++;
      }

      // 다음 턴 유저의 한방 기회가 많을수록 위협적이므로 상위 일부만 확인한다.
      const nextTurnOpp = [];
      for (const w of unusedWords(botWord.last)) {
        if (afterBotExtras.includes(w.word)) continue;
        nextTurnOpp.push(w);
        if (nextTurnOpp.length >= MAX_NEXT_MOVES) break;
      }
      let nextTurnBonus = 0;
      if (!nextTurnOpp.length) {
        nextTurnBonus = 5000;
      } else {
        for (const oppNext of nextTurnOpp) {
          if (!hasContinuationWithIndex(oppNext.last, usedIndex, afterBotExtras, oppNext.word)) {
            nextTurnBonus += 200;
          }
        }
      }

      const score = -botDanger * 10 - botKillers * 50 + nextTurnBonus;
      if (score > bestBotScore) bestBotScore = score;
    }

    if (bestBotScore < worstScore) worstScore = bestBotScore;
  }

  return worstScore;
}

/** 상위(하위) 풀 비율만큼 잘라낸다. preferHigh=true면 위험도 높은 쪽. */
function topPool(sorted, preferHigh) {
  const size = Math.max(1, Math.ceil(sorted.length * POOL_RATIO));
  return preferHigh ? sorted.slice(0, size) : sorted.slice(0, size);
}

/**
 * 동점 처리 기준으로 최선의 후보를 선택한다.
 * 난이도 방향(preferHigh)에 따라 1순위가 달라진다.
 *
 * 정렬 우선순위:
 *   1. 난이도 방향의 위험도
 *   2. 더 긴 단어
 *   3. 희귀 단어 (hit이 낮을수록 희귀)
 *   4. 북한어
 *   5. 랜덤
 */
function tieBreak(scored, preferHigh) {
  let best = scored[0];
  for (const s of scored) {
    if (isBetter(s, best, preferHigh)) best = s;
  }
  return best;
}

function isBetter(a, b, preferHigh) {
  // 1. 난이도 방향의 위험도
  if (a.danger !== b.danger) {
    return preferHigh ? a.danger > b.danger : a.danger < b.danger;
  }
  // 2. 더 긴 단어
  if (a.word.length !== b.word.length) return a.word.length > b.word.length;
  // 3. 희귀 단어 (hit 낮음 우선)
  if (a.word.hit !== b.word.hit) return a.word.hit < b.word.hit;
  // 4. 북한어
  if (a.word.isNorth !== b.word.isNorth) return a.word.isNorth;
  // 5. 랜덤
  return Math.random() < 0.5;
}
