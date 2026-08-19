import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";
import Database from "better-sqlite3";

const DATA_DIR = fileURLToPath(new URL("../data/", import.meta.url));
const DB_FILE = path.join(DATA_DIR, "kkutu.sqlite");

// GitHub spellcheck-ko/korean-dict-nikl-stdict Repository XML List
const XML_FILES = [
  "5000.xml", "10000.xml", "15000.xml", "20000.xml", "25000.xml",
  "30000.xml", "35000.xml", "40000.xml", "45000.xml", "50000.xml",
  "55000.xml", "60000.xml", "65000.xml", "70000.xml", "75000.xml",
  "80000.xml", "85000.xml", "90000.xml", "95000.xml", "100000.xml",
  "105000.xml", "110000.xml", "115000.xml", "120000.xml", "125000.xml",
  "130000.xml", "135000.xml", "140000.xml", "145000.xml", "150000.xml",
  "155000.xml", "160000.xml", "165000.xml", "170000.xml", "175000.xml",
  "180000.xml", "185000.xml", "190000.xml", "195000.xml", "200000.xml",
  "205000.xml", "210000.xml", "215000.xml", "220000.xml", "225000.xml",
  "230000.xml", "235000.xml", "240000.xml", "245000.xml", "250000.xml",
  "255000.xml", "260000.xml", "265000.xml", "270000.xml", "275000.xml",
  "280000.xml", "285000.xml", "290000.xml", "295000.xml", "300000.xml",
  "305000.xml", "310000.xml", "315000.xml", "320000.xml", "325000.xml",
  "330000.xml", "335000.xml", "340000.xml", "345000.xml", "350000.xml",
  "355000.xml", "360000.xml", "365000.xml", "370000.xml", "375000.xml",
  "380000.xml", "385000.xml", "390000.xml", "395000.xml", "400000.xml",
  "405000.xml", "410000.xml", "415000.xml", "420000.xml", "425000.xml",
  "430000.xml", "435000.xml", "440000.xml"
];

const BASE_URL = "https://raw.githubusercontent.com/spellcheck-ko/korean-dict-nikl-stdict/master/";

export async function importStdict() {
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
  let totalAdded = 0;

  console.log(`🚀 [표준국어대사전 STDICT] 다운로드 및 파싱을 시작합니다... (총 ${XML_FILES.length}개 파일)`);

  for (let i = 0; i < XML_FILES.length; i++) {
    const fileName = XML_FILES[i];
    const url = `${BASE_URL}${fileName}`;

    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`[${i + 1}/${XML_FILES.length}] ⚠️ ${fileName} 다운로드 실패 (${res.status})`);
        continue;
      }

      const xmlText = await res.text();
      const jsonObj = parser.parse(xmlText);
      const items = jsonObj?.channel?.item;
      if (!items) continue;

      const itemArray = Array.isArray(items) ? items : [items];
      let fileAdded = 0;

      db.exec("BEGIN");
      for (const item of itemArray) {
        const rawWord = item?.word_info?.word;
        const pos = item?.word_info?.pos_info?.pos;

        if (!rawWord) continue;

        // 특수문자(~, -, ^, 등) 제거
        const cleanWord = String(rawWord).replace(/[^가-힣]/g, "");

        // 2글자 이상 한글, 명사 조건
        if (cleanWord.length >= 2 && (!pos || pos === "명사")) {
          const first = cleanWord[0];
          const last = cleanWord[cleanWord.length - 1];

          const info = insertStmt.run(cleanWord, first, last, cleanWord.length);
          if (info.changes > 0) {
            fileAdded++;
          }
        }
      }
      db.exec("COMMIT");

      totalAdded += fileAdded;
      console.log(`[${i + 1}/${XML_FILES.length}] ✅ ${fileName} 처리 완료 (+${fileAdded} 단어 추가)`);
    } catch (err) {
      if (db.inTransaction) db.exec("ROLLBACK");
      console.error(`[${i + 1}/${XML_FILES.length}] ❌ ${fileName} 처리 중 오류:`, err.message);
    }
  }

  const finalCount = db.prepare("SELECT COUNT(*) AS count FROM words").get().count;
  console.log(`🎉 [완료] 총 ${totalAdded}개 신규 단어 추가됨. (DB 전체 단어 수: ${finalCount})`);
}

// 직접 실행 시
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  importStdict();
}
