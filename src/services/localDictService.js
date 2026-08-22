import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");

let allWords = null;
let wordsByFirstChar = null;

async function loadDictionary() {
  if (allWords) return;

  const files = await readdir(DATA_DIR);
  const wordSet = new Set();
  const byFirst = new Map();

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
      if (!byFirst.has(first)) byFirst.set(first, []);
      byFirst.get(first).push({
        word,
        first,
        last: word[word.length - 1],
        length: word.length,
      });
    }
  }

  allWords = wordSet;
  wordsByFirstChar = byFirst;
}

/**
 * 해당 단어가 로컬 사전에 존재하는지 검사한다.
 */
export async function checkWordExists(word) {
  await loadDictionary();
  return allWords.has(word);
}

/**
 * 특정 글자로 시작하는 단어 목록을 로컬 사전에서 가져온다.
 */
export async function fetchWordsStartingWith(startChar) {
  await loadDictionary();
  return wordsByFirstChar.get(startChar) || [];
}

/**
 * 특정 글자로 시작하는 단어의 개수를 반환한다.
 */
export async function countStartingWith(startChar) {
  await loadDictionary();
  return (wordsByFirstChar.get(startChar) || []).length;
}

/**
 * 로컬 사전 통계 정보
 */
export async function getDictStats() {
  await loadDictionary();
  return {
    totalWords: allWords.size,
    firstChars: wordsByFirstChar.size,
  };
}
