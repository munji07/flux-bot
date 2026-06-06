import { GoogleGenerativeAI } from "@google/generative-ai";
import { GEMINI_SEARCH_MODEL } from "../config.js";
import { logError } from "../logger.js";

/**
 * Google Search Grounding을 사용하여 웹 검색 결과를 바탕으로 응답을 생성합니다.
 * @param {string} query - 사용자로부터 받은 검색 질문
 * @returns {Promise<string>} - 검색 결과가 반영된 생성 텍스트
 */
export async function handleGoogleSearch(query) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY가 설정되어 있지 않습니다.");
  }

  const genAI = new GoogleGenerativeAI(apiKey);

  try {
    const model = genAI.getGenerativeModel({
      model: GEMINI_SEARCH_MODEL,
      tools: [
        {
          googleSearchRetrieval: {},
        },
      ],
    });

    const result = await model.generateContent(query);
    const response = result?.response;
    const text = response?.text?.();

    if (!text) {
      throw new Error("Google 검색에서 응답 텍스트를 받지 못했습니다.");
    }

    return text.trim();
  } catch (error) {
    logError("google_search_handler_error", null, error, { query });
    throw new Error("웹 검색 정보를 가져오는 중 오류가 발생했습니다.");
  }
}