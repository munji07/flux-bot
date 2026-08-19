import { checkWordExists, fetchWordsStartingWith } from "./openDictService.js";

/**
 * WordEngine
 *
 * 우리말샘 OpenAPI 실시간 검색 기반 끝말잇기 로직.
 */

// ── 두음법칙 변환 테이블 ─────────────────────────────────────────────
const RIEUL_TO_NIEUN = [4449, 4450, 4457, 4460, 4462, 4467];
const RIEUL_TO_IEUNG = [4451, 4455, 4456, 4461, 4466, 4469];
const NIEUN_TO_IEUNG = [4455, 4461, 4466, 4469];

const CHO_RIEUL = 4357;
const CHO_NIEUN = 4354;
const CHO_IEUNG = 4363;

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

export function getAcceptableStarts(char) {
  const sub = getSubChar(char);
  return sub && sub !== char ? [char, sub] : [char];
}

/**
 * 시작 글자에 맞게 API에서 후보 단어들을 실시간 조회한다.
 * @param {string} lastChar
 * @param {Set<string>} used
 * @returns {Promise<Array<{word: string, first: string, last: string, length: number}>>}
 */
export async function getCandidates(lastChar, used) {
  const starts = getAcceptableStarts(lastChar);
  const fetched = await Promise.all(starts.map((s) => fetchWordsStartingWith(s)));
  const combined = fetched.flat();
  return combined.filter((w) => !used.has(w.word));
}

/**
 * 실시간 API 기반 단어 검증
 */
export async function validateWord(text, lastChar, used) {
  if (!/^[가-힣]+$/.test(text)) {
    return { ok: false, reason: "한글 단어만 사용할 수 있어요!" };
  }
  if (text.length < 2) {
    return { ok: false, reason: "두 글자 이상의 단어를 입력해야 해요!" };
  }
  if (used.has(text)) {
    return { ok: false, reason: `**${text}**은(는) 이미 사용한 단어예요!` };
  }

  if (lastChar) {
    const acceptable = getAcceptableStarts(lastChar);
    if (!acceptable.includes(text[0])) {
      const sub = getSubChar(lastChar);
      const suffix = sub ? ` 또는 **${sub}**` : "";
      return { ok: false, reason: `**${lastChar}**(으)로 시작해야 해요${suffix}!` };
    }
  }

  // 실시간 우리말샘 API로 단어 존재 여부 확인
  const exists = await checkWordExists(text);
  if (!exists) {
    return { ok: false, reason: `**${text}**은(는) 우리말샘 사전에 없는 단어예요!` };
  }

  return { ok: true };
}
