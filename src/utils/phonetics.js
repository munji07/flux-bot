import { UserFacingError } from "../errors.js";

const KOREAN_SYLLABLE_START = 0xac00;
const KOREAN_INITIALS = [
  "g",
  "kk",
  "n",
  "d",
  "tt",
  "r",
  "m",
  "b",
  "pp",
  "s",
  "ss",
  "ng",
  "j",
  "jj",
  "ch",
  "k",
  "t",
  "p",
  "h",
];
const KOREAN_MEDIALS = [
  "a",
  "ae",
  "ya",
  "yae",
  "eo",
  "e",
  "yeo",
  "ye",
  "o",
  "wa",
  "wae",
  "oe",
  "yo",
  "u",
  "weo",
  "we",
  "wi",
  "yu",
  "eu",
  "ui",
  "i",
];
const KOREAN_FINALS = [
  "",
  "k",
  "k",
  "ks",
  "n",
  "nj",
  "nh",
  "t",
  "l",
  "lk",
  "lm",
  "lb",
  "ls",
  "lt",
  "lp",
  "lh",
  "m",
  "p",
  "ps",
  "t",
  "t",
  "ng",
  "t",
  "ch",
  "k",
  "t",
  "p",
  "h",
];

const ENGLISH_VOWELS = new Set(["a", "e", "i", "o", "u"]);
const ENGLISH_ONSETS = {
  b: "ㅂ",
  c: "ㅋ",
  d: "ㄷ",
  f: "ㅍ",
  g: "ㄱ",
  h: "ㅎ",
  j: "ㅈ",
  k: "ㅋ",
  l: "ㄹ",
  m: "ㅁ",
  n: "ㄴ",
  p: "ㅍ",
  q: "ㅋ",
  r: "ㄹ",
  s: "ㅅ",
  t: "ㅌ",
  v: "ㅂ",
  w: "ㅂ",
  x: "ㄱ",
  y: "ㅇ",
  z: "ㅈ",
};
const ENGLISH_VOWEL_TO_MEDIAL = {
  a: "ㅏ",
  e: "ㅔ",
  i: "ㅣ",
  o: "ㅗ",
  u: "ㅜ",
};
const CONSONANT_NAME = {
  b: "브",
  c: "크",
  d: "드",
  f: "프",
  g: "그",
  h: "흐",
  j: "즈",
  k: "크",
  l: "르",
  m: "므",
  n: "은",
  p: "프",
  q: "큐",
  r: "르",
  s: "스",
  t: "트",
  v: "브",
  w: "우",
  x: "엑스",
  y: "와이",
  z: "즈",
};

const ENGLISH_PHRASE_OVERRIDES = [
  [/\bhello\b/gi, "헬로"],
  [/\bhi\b/gi, "하이"],
  [/\bhelp\b/gi, "헬프"],
  [/\bchatgpt\b/gi, "챗지피티"],
  [/\bthank(s|you)?\b/gi, "땡크"],
  [/\bworld\b/gi, "월드"],
  [/\bexample\b/gi, "이그젬플"],
  [/\bpronounce\b/gi, "프러넌스"],
];

export function isPronunciationRequest(userPrompt) {
  return /^\s*발음(?:으로|로)?(?:\s|$)/i.test(userPrompt);
}

export function getPronunciationReply(userPrompt) {
  const commandText = userPrompt.replace(/^\s*발음(?:으로|로)?(?:\s|$)/i, "").trim();
  if (!commandText) {
    throw new UserFacingError("변환할 문장을 입력해주세요. 예: `!먼지야 발음 hello` 또는 `!먼지야 발음 안녕하세요`");
  }

  const containsKorean = /[\u3131-\u318E\uAC00-\uD7AF]/.test(commandText);
  const containsEnglish = /[A-Za-z]/.test(commandText);

  if (containsKorean && !containsEnglish) {
    return `한국어 발음을 영어로: ${romanizeKorean(commandText)}`;
  }

  if (containsEnglish && !containsKorean) {
    return `영어 발음을 한글로: ${transliterateEnglishToKorean(commandText)}`;
  }

  return `발음 변환 결과:
${convertMixedPronunciation(commandText)}`;
}

function romanizeKorean(text) {
  return [...text]
    .map((char) => (isHangulSyllable(char) ? romanizeSyllable(char) : char))
    .join("");
}

function isHangulSyllable(char) {
  const code = char.codePointAt(0);
  return code >= 0xac00 && code <= 0xd7a3;
}

function romanizeSyllable(char) {
  const code = char.codePointAt(0) - KOREAN_SYLLABLE_START;
  const initialIndex = Math.floor(code / 588);
  const medialIndex = Math.floor((code % 588) / 28);
  const finalIndex = code % 28;

  const initial = initialIndex === 11 ? "" : KOREAN_INITIALS[initialIndex] ?? "";
  const medial = KOREAN_MEDIALS[medialIndex] ?? "";
  const finalRom = KOREAN_FINALS[finalIndex] ?? "";

  return `${initial}${medial}${finalRom}`;
}

function convertMixedPronunciation(text) {
  return text
    .split(/(\s+)/)
    .map((token) => {
      const hasKorean = /[\u3131-\u318E\uAC00-\uD7AF]/.test(token);
      const hasEnglish = /[A-Za-z]/.test(token);
      if (hasKorean && !hasEnglish) return romanizeKorean(token);
      if (hasEnglish && !hasKorean) return transliterateEnglishToKorean(token);
      return token;
    })
    .join("");
}

function transliterateEnglishToKorean(text) {
  const normalized = text.trim();
  if (!normalized) return "";

  let result = normalized;
  for (const [pattern, replacement] of ENGLISH_PHRASE_OVERRIDES) {
    result = result.replace(pattern, replacement);
  }

  result = result.replace(/\b([A-Za-z]+)\b/g, (_, word) => transliterateEnglishWord(word));
  return result;
}

function transliterateEnglishWord(word) {
  const completed = word
    .toLowerCase()
    .replace(/ough/g, "오")
    .replace(/ight/g, "이트")
    .replace(/tion/g, "션")
    .replace(/sion/g, "션")
    .replace(/cian/g, "션")
    .replace(/ph/g, "프")
    .replace(/qu/g, "쿠")
    .replace(/ck/g, "크")
    .replace(/sh/g, "쉬")
    .replace(/ch/g, "치")
    .replace(/th/g, "스")
    .replace(/ng/g, "응")
    .replace(/ae/g, "에")
    .replace(/ai/g, "에이")
    .replace(/ea/g, "이")
    .replace(/ee/g, "이")
    .replace(/ie/g, "이")
    .replace(/oa/g, "오아")
    .replace(/oi/g, "오이")
    .replace(/ou/g, "아우")
    .replace(/ow/g, "오우")
    .replace(/ar/g, "아")
    .replace(/er/g, "어")
    .replace(/or/g, "오")
    .replace(/ur/g, "어")
    .replace(/ir/g, "어");

  if (!/[A-Za-z]/.test(completed)) {
    return completed;
  }

  const letters = [...completed];
  let output = "";
  let pendingConsonant = null;

  for (let i = 0; i < letters.length; i += 1) {
    const char = letters[i];
    const isVowel = ENGLISH_VOWELS.has(char);

    if (isVowel) {
      const onset = pendingConsonant ? ENGLISH_ONSETS[pendingConsonant] : "ㅇ";
      const medial = ENGLISH_VOWEL_TO_MEDIAL[char] ?? "ㅔ";
      const nextChar = letters[i + 1];
      const nextIsConsonant = nextChar && !ENGLISH_VOWELS.has(nextChar);
      let finalJamo = null;

      if (nextIsConsonant && i + 2 === letters.length) {
        finalJamo = ENGLISH_ONSETS[nextChar] || null;
        i += 1;
      }

      output += composeHangul(onset, medial, finalJamo);
      pendingConsonant = null;
      continue;
    }

    if (!pendingConsonant) {
      pendingConsonant = char;
      continue;
    }

    output += CONSONANT_NAME[pendingConsonant] ?? "";
    pendingConsonant = char;
  }

  if (pendingConsonant) {
    output += CONSONANT_NAME[pendingConsonant] ?? "";
  }

  return output || word;
}

function composeHangul(onset, medial, finalJamo) {
  const initialIndex = KOREAN_INITIALS.indexOf(onset);
  const medialIndex = KOREAN_MEDIALS.indexOf(medial);
  const finalIndex = finalJamo ? KOREAN_FINALS.indexOf(finalJamo) : 0;

  if (initialIndex === -1 || medialIndex === -1) {
    return (onset ? CONSONANT_NAME[Object.keys(ENGLISH_ONSETS).find((key) => ENGLISH_ONSETS[key] === onset)] : "") + "";
  }

  return String.fromCodePoint(KOREAN_SYLLABLE_START + initialIndex * 588 + medialIndex * 28 + (finalIndex === -1 ? 0 : finalIndex));
}
