import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data");
const DB_FILE = path.join(DATA_DIR, "kkutu.sqlite");
const XML_FILES = process.argv.slice(2);

function validWord(word) {
  return typeof word === "string" && /^[가-힣]{2,}$/.test(word.trim());
}

function wordsFromXml(xml) {
  const words = [];
  for (const match of xml.matchAll(/<(?:word|lemma|표제어)\b[^>]*>([\s\S]*?)<\/(?:word|lemma|표제어)>/gi)) {
    const word = match[1].replace(/<[^>]+>/g, "").trim();
    if (validWord(word)) words.push(word);
  }
  return words;
}

async function fetchWooriWords() {
  const key = process.env.WOORIMALSAM_API_KEY;
  if (!key) return [];
  const endpoint = process.env.WOORIMALSAM_API_URL || "https://opendict.korean.go.kr/api/search";
  const words = [];
  for (let page = 1; page <= 1000; page++) {
    const url = new URL(endpoint);
    url.search = new URLSearchParams({ key, target: "1", type_search: "search", q: "*", start: String(page), num: "100", sort: "popular", method: "include" });
    const response = await fetch(url);
    if (!response.ok) throw new Error(`우리말샘 API HTTP ${response.status}`);
    const body = await response.text();
    const pageWords = body.trim().startsWith("{")
      ? (JSON.parse(body).channel?.item ?? []).map((item) => item.word)
      : wordsFromXml(body);
    words.push(...pageWords.filter(validWord));
    if (pageWords.length < 100) break;
  }
  return words;
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.exec(`CREATE TABLE IF NOT EXISTS words (word TEXT PRIMARY KEY, first TEXT NOT NULL, last TEXT NOT NULL, length INTEGER NOT NULL, type INTEGER NOT NULL DEFAULT 0, theme INTEGER NOT NULL DEFAULT 0, hit INTEGER NOT NULL DEFAULT 0, isNorth INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS idx_words_first ON words(first);`);
const insert = db.prepare("INSERT OR IGNORE INTO words VALUES (?, ?, ?, ?, 0, 0, 0, 0)");
const words = new Set();
for (const file of XML_FILES) wordsFromXml(fs.readFileSync(file, "utf8")).forEach((word) => words.add(word));
for (const word of await fetchWooriWords()) words.add(word);

db.exec("BEGIN");
try {
  for (const word of words) insert.run(word, word[0], word.at(-1), word.length);
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}
console.log(`[dictionary] imported ${words.size} candidates into ${DB_FILE}`);
