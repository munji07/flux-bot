import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");

let allWords = null;
let wordsByFirstChar = null;
let wordsByLastChar = null;
let continuationsCache = null;
let loadingPromise = null;

function loadDictionarySync() {
  if (allWords) return;
  if (loadingPromise) return loadingPromise;
  loadingPromise = doLoad();
  return loadingPromise;
}

async function doLoad() {
  const t0 = Date.now();
  const files = await readdir(DATA_DIR);
  const wordSet = new Set();
  const byFirst = new Map();
  const byLast = new Map();

  for (const file of files) {
    const content = await readFile(join(DATA_DIR, file), "utf-8");
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const word = line.trim();
      if (!word || !/^[가-힣]+$/.test(word)) continue;
      if (word.length < 2) continue;
      if (wordSet.has(word)) continue;

      wordSet.add(word);
      const first = word[0];
      const last = word[word.length - 1];
      if (!byFirst.has(first)) byFirst.set(first, []);
      byFirst.get(first).push({ word, first, last, length: word.length });
      if (!byLast.has(last)) byLast.set(last, new Set());
      byLast.get(last).add(word);
    }
  }

  allWords = wordSet;
  wordsByFirstChar = byFirst;
  wordsByLastChar = byLast;
  console.log(`[Dict] Loaded ${wordSet.size.toLocaleString()} words from ${files.length} files in ${Date.now() - t0}ms`);
}

/**
 * 봇 시작 시 미리 사전을 로드한다. blocking.
 */
export async function preloadDictionary() {
  await loadDictionarySyncSync();
}

/**
 * 특정 글자로 끝나는 단어 목록을 반환한다.
 */
export async function fetchWordsEndingWith(char) {
  await loadDictionarySyncSync();
  return [...(wordsByLastChar.get(char) || [])];
}

/**
 * 특정 글자로 끝나는 단어의 개수를 반환한다.
 */
export async function countEndingWith(char) {
  await loadDictionarySync();
  return (wordsByLastChar.get(char) || new Set()).size;
}

/**
 * 특정 글자 뒤에 이어갈 수 있는 단어 수를 센다 (두음법칙 포함).
 */
export async function countContinuationsForChar(char) {
  await loadDictionarySync();
  const sub = getSubCharLocal(char);
  const targets = sub && sub !== char ? [char, sub] : [char];
  let total = 0;
  for (const t of targets) {
    total += (wordsByFirstChar.get(t) || []).length;
  }
  return total;
}

// wordEngine의 getSubChar를 복사 (순환 참조 방지)
const CHO_RIEUL = 4357;
const CHO_NIEUN = 4354;
const CHO_IEUNG = 4363;
const RIEUL_TO_NIEUN = [4449, 4450, 4457, 4460, 4462, 4467];
const RIEUL_TO_IEUNG = [4451, 4455, 4456, 4461, 4466, 4469];
const NIEUN_TO_IEUNG = [4455, 4461, 4466, 4469];

function getSubCharLocal(char) {
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
 * 사전 전체 분석: 각 글자별 이어갈 수 있는 단어 수를 계산한다.
 */
export async function getCharContinuations() {
  await loadDictionarySync();
  if (continuationsCache) return continuationsCache;

  const result = new Map();
  for (const [char] of wordsByFirstChar) {
    result.set(char, await countContinuationsForChar(char));
  }
  continuationsCache = result;
  return result;
}

/**
 * 해당 단어의 전략적 분류를 분석한다.
 * - 공격단어: 마지막 글자로 이어갈 수 있는 단어가 적은 단어
 * - 방어단어: 마지막 글자로 이어갈 수 있는 단어가 많은 단어
 * - 돌림당어: 마지막 글자로 이어갈 수 있는 단어가 0개인 단어 (게임 종료)
 * - 양보단어: 상대방에게 쉬운 선택지를 주는 단어 (긴 단어)
 */
export async function classifyWord(word) {
  await loadDictionarySync();
  if (!allWords.has(word)) return null;

  const last = word[word.length - 1];
  const conts = await countContinuationsForChar(last);
  const sub = getSubCharLocal(last);
  const subConts = sub ? await countContinuationsForChar(sub) : 0;
  const totalConts = conts + subConts;

  let type;
  if (totalConts === 0) type = "deadend";
  else if (totalConts <= 10) type = "attack";
  else if (totalConts <= 50) type = "balanced";
  else type = "defense";

  return {
    word,
    last,
    sub,
    continuations: totalConts,
    type,
    length: word.length,
  };
}

/**
 * 특정 글자의 끝말잇기 분석 정보를 반환한다.
 */
export async function analyzeChar(char) {
  await loadDictionarySync();
  const starting = wordsByFirstChar.get(char) || [];
  const ending = [...(wordsByLastChar.get(char) || [])];
  const conts = await countContinuationsForChar(char);
  const sub = getSubCharLocal(char);
  const subConts = sub ? await countContinuationsForChar(sub) : 0;

  // 돌림당어: 이 글자로 끝나는 단어 중 이어갈 수 있는 단어가 없는 것
  const deadEnds = [];
  for (const w of ending) {
    const wLast = w[w.length - 1];
    const wConts = await countContinuationsForChar(wLast);
    if (wConts === 0) deadEnds.push(w);
  }

  // 공격 단어: 이 글자로 시작하는 단어 중 이어갈 수 있는 단어가 적은 것
  const attackWords = [];
  for (const w of starting) {
    const wLast = w.last;
    const wConts = await countContinuationsForChar(wLast);
    if (wConts <= 10) attackWords.push({ word: w.word, continuations: wConts });
  }
  attackWords.sort((a, b) => a.continuations - b.continuations);

  // 방어 단어: 이 글자로 시작하는 단어 중 이어갈 수 있는 단어가 많은 것
  const defenseWords = [];
  for (const w of starting) {
    const wLast = w.last;
    const wConts = await countContinuationsForChar(wLast);
    defenseWords.push({ word: w.word, continuations: wConts });
  }
  defenseWords.sort((a, b) => b.continuations - a.continuations);

  return {
    char,
    sub,
    totalStarting: starting.length,
    totalEnding: ending.length,
    continuations: conts,
    subContinuations: subConts,
    deadEnds: deadEnds.slice(0, 10),
    attackWords: attackWords.slice(0, 10),
    defenseWords: defenseWords.slice(0, 10),
    shortest: starting.length > 0 ? starting.reduce((a, b) => a.length <= b.length ? a : b) : null,
    longest: starting.length > 0 ? starting.reduce((a, b) => a.length >= b.length ? a : b) : null,
  };
}

/**
 * 해당 단어가 로컬 사전에 존재하는지 검사한다.
 */
export async function checkWordExists(word) {
  await loadDictionarySync();
  return allWords.has(word);
}

/**
 * 특정 글자로 시작하는 단어 목록을 로컬 사전에서 가져온다.
 */
export async function fetchWordsStartingWith(startChar) {
  await loadDictionarySync();
  return wordsByFirstChar.get(startChar) || [];
}

/**
 * 특정 글자로 시작하는 단어의 개수를 반환한다.
 */
export async function countStartingWith(startChar) {
  await loadDictionarySync();
  return (wordsByFirstChar.get(startChar) || []).length;
}

/**
 * 로컬 사전 통계 정보
 */
export async function getDictStats() {
  await loadDictionarySync();
  return {
    totalWords: allWords.size,
    firstChars: wordsByFirstChar.size,
    lastChars: wordsByLastChar.size,
  };
}
