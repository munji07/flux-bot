import { GoogleGenerativeAI } from "@google/generative-ai";
import { logError } from "../logger.js";

/**
 * Google Search Grounding을 사용하여 웹 검색 결과를 바탕으로 응답을 생성합니다.
 * @param {string} query - 사용자로부터 받은 검색 질문
 * @returns {Promise<string>} - 검색 결과가 반영된 생성 텍스트
 */
export async function handleGoogleSearch(query) {
  // 환경 변수에서 API 키를 가져옵니다.
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

  try {
    // googleSearchRetrieval 도구를 활성화하여 모델을 설정합니다.
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash", // 또는 'gemini-1.5-pro'
      tools: [
        {
          googleSearchRetrieval: {},
        },
      ],
    });

    const result = await model.generateContent(query);
    const response = await result.response;
    
    return response.text();
  } catch (error) {
    logError("google_search_handler_error", null, error, { query });
    throw new Error("웹 검색 정보를 가져오는 중 오류가 발생했습니다.");
  }
}