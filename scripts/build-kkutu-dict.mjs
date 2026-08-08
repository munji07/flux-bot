import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../data");
const DB_SQL = process.argv[2] || path.join(DATA_DIR, "kkutu-db.sql");
const OUT_FILE = path.join(DATA_DIR, "kkutu.json");
const DB_SQL_URL = "https://raw.githubusercontent.com/JJoriping/KKuTu/master/db.sql";

if (!fs.existsSync(DB_SQL)) {
  console.log(`[build-kkutu] DB dump not found: ${DB_SQL}`);
  console.log("[build-kkutu] Downloading from GitHub (약 42MB)...");
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const res = await fetch(DB_SQL_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(DB_SQL, buf);
    console.log(`[build-kkutu] Downloaded ${DB_SQL} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
  } catch (err) {
    console.error(`[build-kkutu] Download failed: ${err.message}`);
    console.error("Download db.sql manually from https://github.com/JJoriping/KKuTu and pass its path as an argument.");
    process.exit(1);
  }
}

// 명사만 허용 (KKuTu 깐깐 규칙 = type이 1 또는 INJEONG)
const NOUN_TYPE = /(^|,)(1|INJEONG)(,|$)/;
// 제외: 어인정(2) | 띄어쓰기(4) | 방언(8)
// 포함: 일반어(0), 외래어(1), 문화어/북한어(32), 옛말(16)
const EXCLUDE_FLAG = 2 | 4 | 8;
const MUNHWA_FLAG = 32;

// theme 번호 → 표시 이름 (0 = 일반)
const THEME_NAMES = {
  0: "일반",
  30: "지명",
  320: "인물",
  530: "음식",
  190: "동물",
  270: "식물",
  170: "IT",
  150: "게임",
  430: "수학",
  420: "과학",
  360: "체육",
  350: "영화",
  380: "역사",
  450: "의학",
  490: "천문",
  160: "역사",
};

function unescape(line) {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") {
      const n = line[i + 1];
      if (n === "b") { out += "\b"; i++; }
      else if (n === "f") { out += "\f"; i++; }
      else if (n === "n") { out += "\n"; i++; }
      else if (n === "r") { out += "\r"; i++; }
      else if (n === "t") { out += "\t"; i++; }
      else if (n === "v") { out += "\v"; i++; }
      else if (n === "\\") { out += "\\"; i++; }
      else if (n >= "0" && n <= "7") {
        let j = i + 1; let oct = "";
        while (oct.length < 3 && j < line.length && line[j] >= "0" && line[j] <= "7") { oct += line[j]; j++; }
        out += String.fromCharCode(parseInt(oct, 8)); i = j - 1;
      } else { out += c; }
    } else out += c;
  }
  return out;
}

function themeLabel(themeStr) {
  if (!themeStr) return "일반";
  const first = themeStr.split(",")[0];
  return THEME_NAMES[first] ?? first;
}

const raw = fs.readFileSync(DB_SQL, "utf8");
const start = raw.indexOf("COPY kkutu_ko (_id, type, mean, hit, flag, theme) FROM stdin;");
if (start === -1) {
  console.error("[build-kkutu] COPY section for kkutu_ko not found.");
  process.exit(1);
}
const dataEnd = raw.indexOf("\n\\.\n", start);
const data = raw.slice(start, dataEnd === -1 ? undefined : dataEnd);
const lines = data.split("\n");

const byFirst = {};
let total = 0;
let kept = 0;

for (const line of lines) {
  if (!line) continue;
  const f = unescape(line).split("\t");
  if (f.length < 6) continue;
  const word = f[0];
  const type = f[1];
  const hit = parseInt(f[3], 10) || 0;
  const flag = parseInt(f[4], 10);
  const theme = f[5];

  if (flag & EXCLUDE_FLAG) continue;
  if (word.length < 2) continue;
  if (!/^[가-힣]+$/.test(word)) continue;
  if (!NOUN_TYPE.test(type)) continue;

  const first = word[0];
  const item = {
    word,
    first,
    last: word[word.length - 1],
    length: word.length,
    type: "명사",
    theme: themeLabel(theme),
    hit,
    isNorth: (flag & MUNHWA_FLAG) !== 0,
  };
  (byFirst[first] ??= []).push(item);
  total++;
}

// 동일 단어 중복 제거: hit가 높은(자주 쓰인) 대표 항목을 유지
let deduped = 0;
for (const key of Object.keys(byFirst)) {
  const seen = new Map();
  for (const item of byFirst[key]) {
    const prev = seen.get(item.word);
    if (!prev || item.hit > prev.hit) seen.set(item.word, item);
  }
  byFirst[key] = [...seen.values()].sort((a, b) => (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));
  deduped += byFirst[key].length;
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(byFirst));

console.log(`[build-kkutu] unique nouns after filter: ${deduped} (rows scanned: ${total})`);
console.log(`[build-kkutu] wrote ${OUT_FILE} (${(fs.statSync(OUT_FILE).size / 1024 / 1024).toFixed(2)} MB)`);
