import { XMLParser } from "fast-xml-parser";
import { KOREAN_DICT_API_KEY } from "../config.js";

const BASE_URL = "https://opendict.korean.go.kr/api/search";
const parser = new XMLParser({ ignoreAttributes: false });

/**
 * 우리말샘 API에서 해당 단어가 존재하는지 (명사/의존명사/대명사 등 실질 체언인지) 검사한다.
 * @param {string} word 검사할 단어
 * @returns {Promise<boolean>}
 */
export async function checkWordExists(word) {
  if (!/^[가-힣]+$/.test(word)) return false;

  const url = `${BASE_URL}?key=${KOREAN_DICT_API_KEY}&q=${encodeURIComponent(word)}&req_type=xml&advanced=y&method=exact`;
  try {
    const res = await fetch(url);
    if (!res.ok) return false;

    const xmlText = await res.text();
    const jsonObj = parser.parse(xmlText);
    const items = jsonObj?.channel?.item;

    if (!items) return false;

    const itemArray = Array.isArray(items) ? items : [items];
    return itemArray.some((item) => {
      const itemWord = item?.word || item?.word_info?.word;
      const cleanItemWord = String(itemWord || "").replace(/[^가-힣]/g, "");
      const pos = item?.pos || item?.sense?.pos || item?.word_info?.pos_info?.pos;

      return cleanItemWord === word && (!pos || String(pos).includes("명사"));
    });
  } catch (err) {
    console.error(`[OpenDict API Error] checkWordExists(${word}):`, err.message);
    return false;
  }
}

/**
 * 특정 글자(또는 두음법칙 변환 글자)로 시작하는 단어 목록을 API에서 검색해 온다.
 * @param {string} startChar 시작 글자
 * @returns {Promise<Array<{word: string, first: string, last: string, length: number}>>}
 */
export async function fetchWordsStartingWith(startChar) {
  const url = `${BASE_URL}?key=${KOREAN_DICT_API_KEY}&q=${encodeURIComponent(startChar)}&req_type=xml&start=1&num=100&advanced=y&method=start`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];

    const xmlText = await res.text();
    const jsonObj = parser.parse(xmlText);
    const items = jsonObj?.channel?.item;

    if (!items) return [];

    const itemArray = Array.isArray(items) ? items : [items];
    const result = [];
    const seen = new Set();

    for (const item of itemArray) {
      const rawWord = item?.word || item?.word_info?.word;
      const pos = item?.pos || item?.sense?.pos || item?.word_info?.pos_info?.pos;

      if (!rawWord) continue;
      const cleanWord = String(rawWord).replace(/[^가-힣]/g, "");

      if (
        cleanWord.length >= 2 &&
        cleanWord[0] === startChar &&
        (!pos || String(pos).includes("명사")) &&
        !seen.has(cleanWord)
      ) {
        seen.add(cleanWord);
        result.push({
          word: cleanWord,
          first: cleanWord[0],
          last: cleanWord[cleanWord.length - 1],
          length: cleanWord.length,
        });
      }
    }
    return result;
  } catch (err) {
    console.error(`[OpenDict API Error] fetchWordsStartingWith(${startChar}):`, err.message);
    return [];
  }
}
