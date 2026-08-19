import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";
import Database from "better-sqlite3";
import { KOREAN_DICT_API_KEY } from "../src/config.js";

const API_KEY = KOREAN_DICT_API_KEY;
const DATA_DIR = fileURLToPath(new URL("../data/", import.meta.url));
const DB_FILE = path.join(DATA_DIR, "kkutu.sqlite");
const BASE_URL = "https://opendict.korean.go.kr/api/search";

export async function importOpendict() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const db = new Database(DB_FILE);
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

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO words (word, first, last, length, type, theme, hit, isNorth)
    VALUES (?, ?, ?, ?, 0, 0, 0, 0)
  `);

  const parser = new XMLParser({ ignoreAttributes: false });

  const SYLLABLES = [
    "가", "나", "다", "라", "마", "바", "사", "아", "자", "차", "카", "타", "파", "하",
    "고", "노", "도", "로", "모", "보", "소", "오", "조", "초", "코", "토", "포", "호",
    "구", "누", "두", "루", "무", "부", "수", "우", "주", "추", "쿠", "투", "푸", "후",
    "기", "니", "디", "리", "미", "비", "시", "이", "지", "치", "키", "티", "피", "히"
  ];

  let totalAdded = 0;
  console.log(`🚀 [우리말샘 OpenAPI] 단어 수집을 시작합니다... (인증키: ${API_KEY.slice(0, 8)}...)`);

  for (let i = 0; i < SYLLABLES.length; i++) {
    const query = SYLLABLES[i];
    let start = 1;
    const num = 100;
    let queryAdded = 0;

    while (start <= 500) {
      const url = `${BASE_URL}?key=${API_KEY}&q=${encodeURIComponent(query)}&req_type=xml&start=${start}&num=${num}&advanced=y&method=start`;

      try {
        const res = await fetch(url);
        if (!res.ok) {
          console.warn(`⚠️ [${query}] 페이지 ${start} 요청 실패 (${res.status})`);
          break;
        }

        const xmlText = await res.text();
        const jsonObj = parser.parse(xmlText);
        const items = jsonObj?.channel?.item;

        if (!items) break;

        const itemArray = Array.isArray(items) ? items : [items];
        let pageAdded = 0;

        db.exec("BEGIN");
        for (const item of itemArray) {
          const rawWord = item?.word || item?.word_info?.word;
          const pos = item?.pos || item?.word_info?.pos_info?.pos;

          if (!rawWord) continue;

          const cleanWord = String(rawWord).replace(/[^가-힣]/g, "");

          if (cleanWord.length >= 2 && (!pos || String(pos).includes("명사"))) {
            const first = cleanWord[0];
            const last = cleanWord[cleanWord.length - 1];

            const info = insertStmt.run(cleanWord, first, last, cleanWord.length);
            if (info.changes > 0) {
              pageAdded++;
            }
          }
        }
        db.exec("COMMIT");

        queryAdded += pageAdded;
        if (itemArray.length < num) break;
        start += num;
      } catch (err) {
        if (db.inTransaction) db.exec("ROLLBACK");
        console.error(`❌ [${query}] 검색 중 오류:`, err.message);
        break;
      }
    }

    totalAdded += queryAdded;
    console.log(`[${i + 1}/${SYLLABLES.length}] ✅ '${query}' 검색 완료 (+${queryAdded} 단어 추가)`);
  }

  const finalCount = db.prepare("SELECT COUNT(*) AS count FROM words").get().count;
  console.log(`🎉 [우리말샘 API 수집 완료] 총 ${totalAdded}개 신규 단어 추가됨. (DB 전체 단어 수: ${finalCount})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  importOpendict();
}
