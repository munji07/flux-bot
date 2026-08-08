import { getWordsByFirstChar, getUnusedWordsByFirstChar, isKnownWord } from "./wordCache.js";

/**
 * WordEngine
 *
 * 끝말잇기 순수 로직을 담당한다.
 * - 단어 검증 (한글, 길이, 시작 글자, 사전 존재, 중복)
 * - 후보 검색 (두음법칙을 포함한 시작 글자 매칭)
 * - 위험도(Danger) 계산
 * - 두음법칙 처리
 *
 * Discord.js 관련 코드는 포함하지 않아 재사용 가능하다.
 */

// ── 두음법칙 변환 테이블 ─────────────────────────────────────────────
// 유니코드: 초성 ㄹ(0x1105) + 중성 조합 → ㄴ/ㅇ 로 변경되는 중성 집합
const RIEUL_TO_NIEUN = [4449, 4450, 4457, 4460, 4462, 4467]; // ㄹ → ㄴ (린→인, 람→남...)
const RIEUL_TO_IEUNG = [4451, 4455, 4456, 4461, 4466, 4469]; // ㄹ → ㅇ (라→나, 룡→용...)
const NIEUN_TO_IEUNG = [4455, 4461, 4466, 4469]; // ㄴ → ㅇ (니→이, 뇨→요...)

const CHO_RIEUL = 4357; // ㄹ (0x1105)
const CHO_NIEUN = 4354; // ㄴ (0x1102)
const CHO_IEUNG = 4363; // ㅇ (0x110B)

/**
 * 두음법칙 적용 후의 시작 글자를 반환한다.
 * 예) "린" → "인", "라" → "나", "니" → "이"
 * 변환이 필요 없으면 null을 반환한다.
 * @param {string} char 검사할 글자
 * @returns {string|null}
 */
export function getSubChar(char) {
  const code = char.charCodeAt(0);
  const offset = code - 0xac00;
  if (offset < 0 || offset > 11171) return null;

  const cho = Math.floor(offset / 588);
  const jung = Math.floor((offset % 588) / 28);
  const jong = offset % 28;
  const choJamo = cho + 0x1100;
  const jungJamo = jung + 0x1161;

  let newCho = choJamo;
  if (choJamo === CHO_RIEUL) {
    if (RIEUL_TO_NIEUN.includes(jungJamo)) newCho = CHO_NIEUN;
    else if (RIEUL_TO_IEUNG.includes(jungJamo)) newCho = CHO_IEUNG;
    else return null;
  } else if (choJamo === CHO_NIEUN) {
    if (NIEUN_TO_IEUNG.includes(jungJamo)) newCho = CHO_IEUNG;
    else return null;
  } else {
    return null;
  }

  return String.fromCharCode(((newCho - 0x1100) * 588) + (jung * 28) + jong + 0xac00);
}

/**
 * 주어진 글자로 시작할 수 있는 시작 글자 목록을 반환한다.
 * 두음법칙이 적용되면 [원본, 변환] 두 글자를 반환한다.
 * @param {string} char 마지막 글자
 * @returns {string[]}
 */
export function getAcceptableStarts(char) {
  const sub = getSubChar(char);
  return sub && sub !== char ? [char, sub] : [char];
}

/**
 * 마지막 글자에 이어갈 수 있는 후보 단어 목록을 반환한다.
 * 두음법칙(예: 술 → 술로 시작)을 고려하며, 이미 사용된 단어는 제외한다.
 * @param {string} lastChar 마지막 글자
 * @param {Set<string>} used 이미 사용된 단어 집합
 * @returns {Array<object>} 후보 단어 객체 배열
 */
export function getCandidates(lastChar, used) {
  const candidates = [];
  for (const start of getAcceptableStarts(lastChar)) {
    candidates.push(...getUnusedWordsByFirstChar(start, used));
  }
  return candidates;
}

/**
 * 위험도(Danger) 계산.
 *
 * 위험도 = "해당 단어의 마지막 글자로 시작하는, 아직 사용되지 않은 단어의 개수"
 *
 * - 위험도 0 = 한방단어 (이어갈 단어가 없음)
 * - 위험도가 높을수록 상대가 이어가기 쉬운 안전한 단어
 *
 * @param {object} word 단어 객체
 * @param {Set<string>} used 이미 사용된 단어 집합
 * @returns {number} 위험도
 */
export function getDanger(word, used) {
  let count = 0;
  for (const start of getAcceptableStarts(word.last)) {
    count += getUnusedWordsByFirstChar(start, used).length;
  }
  return count;
}

/**
 * 상대가 즉시 이길 수 있는 한방 단어의 개수를 계산한다.
 *
 * 주어진 마지막 글자로 시작하는 미사용 단어 중에서,
 * 그 단어의 마지막 글자로 봇이 이어갈 단어가 없는 경우를 센다.
 * (0이면 상대가 한방 단어로 이길 수 없다는 뜻)
 *
 * @param {string} lastChar 봇 단어의 마지막 글자
 * @param {Set<string>} used 이미 사용된 단어 집합
 * @returns {number}
 */
export function countKillerMoves(lastChar, used) {
  let count = 0;
  for (const start of getAcceptableStarts(lastChar)) {
    for (const w of getUnusedWordsByFirstChar(start, used)) {
      const nextUsed = new Set(used);
      nextUsed.add(w.word);
      if (!hasContinuation(w.last, nextUsed)) count++;
    }
  }
  return count;
}

/**
 * 해당 마지막 글자로 이어갈 수 있는 단어의 수를 반환한다.
 * (2수 내다보기 등 전략 평가용)
 * @param {string} lastChar 마지막 글자
 * @param {Set<string>} used 이미 사용된 단어 집합
 * @returns {number} 이어갈 수 있는 단어 수
 */
export function countContinuations(lastChar, used) {
  let count = 0;
  for (const start of getAcceptableStarts(lastChar)) {
    count += getUnusedWordsByFirstChar(start, used).length;
  }
  return count;
}

/**
 * 해당 마지막 글자로 이어갈 수 있는 단어가 남아있는지 확인한다.
 * (게임 시작 단어 선정 및 게임 종료 판정용)
 * @param {string} lastChar 마지막 글자
 * @param {Set<string>} used 이미 사용된 단어 집합
 * @returns {boolean}
 */
export function hasContinuation(lastChar, used) {
  for (const start of getAcceptableStarts(lastChar)) {
    const bucket = getWordsByFirstChar(start);
    for (const w of bucket) {
      if (!used.has(w.word)) return true;
    }
  }
  return false;
}

// ── 사용 단어 색인 기반 고속 계산 ─────────────────────────────────
// 불가능(impossible) 난이도의 2수 시뮬레이션이 턴마다 수만 번 호출하므로,
// used 집합을 한 번 색인(buildUsedIndex)해 두고 Set 복제/버킷 재스캔 없이
// 위험도·한방·이어갈 수 있는지 여부를 O(1)로 계산한다.

/**
 * 사용된 단어 집합의 색인을 생성한다. (시작 글자 → 사용된 단어 수)
 * @param {Set<string>} used 사용된 단어 집합
 * @returns {Map<string, number>} 시작 글자별 사용된 단어 수
 */
export function buildUsedIndex(used) {
  const byFirst = new Map();
  for (const w of used) {
    const first = w[0];
    byFirst.set(first, (byFirst.get(first) ?? 0) + 1);
  }
  return byFirst;
}

/**
 * 시작 글자로 시작하는 미사용 단어 수. (색인 기반 O(1))
 * @param {string} first 시작 글자
 * @param {Map<string, number>} usedIndex buildUsedIndex 결과
 * @param {string[]} extraWords 추가로 사용된 것으로 간주할 단어 (시뮬레이션용)
 * @param {string} [extraWord] 추가로 사용된 것으로 간주할 단어 1개 (할당 없는 고속 경로)
 * @returns {number}
 */
function countUnusedByFirst(first, usedIndex, extraWords, extraWord) {
  let count = getWordsByFirstChar(first).length - (usedIndex.get(first) ?? 0);
  if (extraWords) for (const w of extraWords) if (w[0] === first) count--;
  if (extraWord && extraWord[0] === first) count--;
  return count;
}

/**
 * 후보 단어 목록을 반환한다. (사용 단어 + extra 단어 제외)
 * @param {string} lastChar 마지막 글자
 * @param {Set<string>} used 이미 사용된 단어 집합
 * @param {string[]} extraWords 추가로 제외할 단어
 * @returns {Array<object>} 후보 단어 객체 배열
 */
export function getCandidatesExcluding(lastChar, used, extraWords = []) {
  const result = [];
  for (const start of getAcceptableStarts(lastChar)) {
    for (const w of getWordsByFirstChar(start)) {
      if (used.has(w.word)) continue;
      if (extraWords.includes(w.word)) continue;
      result.push(w);
    }
  }
  return result;
}

/**
 * 해당 마지막 글자로 이어갈 단어가 남아있는지 확인한다. (색인 기반)
 * @param {string} lastChar 마지막 글자
 * @param {Map<string, number>} usedIndex buildUsedIndex 결과
 * @param {string[]} extraWords 추가로 사용된 것으로 간주할 단어
 * @param {string} [extraWord] 추가로 사용된 것으로 간주할 단어 1개 (할당 없는 고속 경로)
 * @returns {boolean}
 */
export function hasContinuationWithIndex(lastChar, usedIndex, extraWords = [], extraWord) {
  for (const start of getAcceptableStarts(lastChar)) {
    if (countUnusedByFirst(start, usedIndex, extraWords, extraWord) > 0) return true;
  }
  return false;
}

/**
 * 위험도(Danger) 계산. (색인 기반)
 * @param {object} word 단어 객체
 * @param {Map<string, number>} usedIndex buildUsedIndex 결과
 * @param {string[]} extraWords 추가로 사용된 것으로 간주할 단어
 * @returns {number} 위험도
 */
export function getDangerWithIndex(word, usedIndex, extraWords = []) {
  let count = 0;
  for (const start of getAcceptableStarts(word.last)) {
    count += countUnusedByFirst(start, usedIndex, extraWords);
  }
  return count;
}

/**
 * 상대가 즉시 이길 수 있는 한방 단어의 개수 계산. (색인 기반, Set 복제 없음)
 * @param {string} lastChar 봇 단어의 마지막 글자
 * @param {Set<string>} used 이미 사용된 단어 집합
 * @param {Map<string, number>} usedIndex buildUsedIndex 결과
 * @param {string[]} extraWords 추가로 사용된 것으로 간주할 단어
 * @returns {number}
 */
export function countKillerMovesWithIndex(lastChar, used, usedIndex, extraWords = []) {
  let count = 0;
  for (const start of getAcceptableStarts(lastChar)) {
    for (const w of getWordsByFirstChar(start)) {
      if (used.has(w.word)) continue;
      if (extraWords.includes(w.word)) continue;
      if (!hasContinuationWithIndex(w.last, usedIndex, extraWords, w.word)) count++;
    }
  }
  return count;
}

/**
 * 유저가 입력한 단어의 유효성을 검증한다.
 * @param {string} text 입력 단어
 * @param {string} lastChar 이어야 하는 마지막 글자
 * @param {Set<string>} used 이미 사용된 단어 집합
 * @returns {{ ok: boolean, reason?: string }}
 */
export function validateWord(text, lastChar, used) {
  if (!/^[가-힣]+$/.test(text)) {
    return { ok: false, reason: "한글 단어만 사용할 수 있어요!" };
  }
  if (text.length < 2) {
    return { ok: false, reason: "두 글자 이상의 단어를 입력해야 해요!" };
  }
  if (used.has(text)) {
    return { ok: false, reason: `**${text}**은(는) 이미 사용한 단어예요!` };
  }

  const acceptable = getAcceptableStarts(lastChar);
  if (!acceptable.includes(text[0])) {
    const sub = getSubChar(lastChar);
    const suffix = sub ? ` 또는 **${sub}**` : "";
    return { ok: false, reason: `**${lastChar}**(으)로 시작해야 해요${suffix}!` };
  }

  if (!isKnownWord(text)) {
    return { ok: false, reason: `**${text}**은(는) 사전에 없는 단어예요!` };
  }

  return { ok: true };
}
