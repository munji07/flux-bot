import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const DATA_DIR = fileURLToPath(new URL("../../data/", import.meta.url));
const DB_FILE = path.join(DATA_DIR, "kkutu.sqlite");
const JSON_FILE = path.join(DATA_DIR, "kkutu.json");

let db;
let statements;
let wordMap;
let wordsByFirst;

export function preloadWordCache() {
  load();
}

function load() {
  if (db) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS words (
      word TEXT PRIMARY KEY,
      first TEXT NOT NULL,
      last TEXT NOT NULL,
      length INTEGER NOT NULL,
      type INTEGER NOT NULL DEFAULT 0,
      theme INTEGER NOT NULL DEFAULT 0,
      hit INTEGER NOT NULL DEFAULT 0,
      isNorth INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_words_first ON words(first);
  `);

  if (db.prepare("SELECT COUNT(*) AS count FROM words").get().count === 0 && fs.existsSync(JSON_FILE)) {
    const raw = JSON.parse(fs.readFileSync(JSON_FILE, "utf8"));
    const insert = db.prepare("INSERT OR IGNORE INTO words VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    db.exec("BEGIN");
    try {
      for (const bucket of Object.values(raw)) {
        for (const w of bucket) insert.run(w.word, w.first, w.last, w.length, w.type ?? 0, w.theme ?? 0, w.hit ?? 0, w.isNorth ? 1 : 0);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  statements = {
    byFirst: db.prepare("SELECT word, first, last, length, type, theme, hit, isNorth FROM words WHERE first = ? ORDER BY word"),
    byWord: db.prepare("SELECT word, first, last, length, type, theme, hit, isNorth FROM words WHERE word = ?"),
    all: db.prepare("SELECT word, first, last, length, type, theme, hit, isNorth FROM words ORDER BY word"),
    firstChars: db.prepare("SELECT DISTINCT first FROM words ORDER BY first"),
    insert: db.prepare("INSERT INTO words VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
    remove: db.prepare("DELETE FROM words WHERE word = ?"),
  };
  const words = statements.all.all().map(toWord);
  wordMap = new Map(words.map((word) => [word.word, word]));
  wordsByFirst = new Map();
  for (const word of words) {
    const bucket = wordsByFirst.get(word.first);
    if (bucket) bucket.push(word);
    else wordsByFirst.set(word.first, [word]);
  }
}

function toWord(row) {
  return row && { ...row, isNorth: Boolean(row.isNorth) };
}

export function getWordsByFirstChar(first) {
  load();
  return wordsByFirst.get(first) ?? [];
}

export function hasWordsByFirstChar(first) {
  load();
  return (wordsByFirst.get(first)?.length ?? 0) > 0;
}

export function isKnownWord(word) {
  load();
  return wordMap.has(word);
}

export function getUnusedWordsByFirstChar(first, used) {
  return getWordsByFirstChar(first).filter((w) => !used.has(w.word));
}

export function getRandomWord() {
  const words = getAllWords();
  return words[Math.floor(Math.random() * words.length)];
}

export function getAllWords() {
  load();
  return statements.all.all().map(toWord);
}

export function getFirstChars() {
  load();
  return statements.firstChars.all().map((row) => row.first);
}

export function addWord(word) {
  load();
  if (isKnownWord(word)) return false;
  const item = { word, first: word[0], last: word[word.length - 1], length: word.length, type: 0, theme: 0, hit: 0, isNorth: false };
  statements.insert.run(item.word, item.first, item.last, item.length, item.type, item.theme, item.hit, 0);
  wordMap.set(item.word, item);
  const bucket = wordsByFirst.get(item.first);
  if (bucket) bucket.push(item);
  else wordsByFirst.set(item.first, [item]);
  return true;
}

export function getWordInfo(word) {
  load();
  return toWord(statements.byWord.get(word));
}

export function removeWord(word) {
  load();
  if (!isKnownWord(word)) return false;
  statements.remove.run(word);
  wordMap.delete(word);
  const bucket = wordsByFirst.get(word[0]);
  if (bucket) {
    const index = bucket.findIndex((item) => item.word === word);
    if (index !== -1) bucket.splice(index, 1);
    if (!bucket.length) wordsByFirst.delete(word[0]);
  }
  return true;
}

export function getCacheStats() {
  return { firstChars: getFirstChars().length, words: getAllWords().length };
}
