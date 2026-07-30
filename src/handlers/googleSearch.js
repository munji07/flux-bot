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
          googleSearch: {},
        },
      ],
    });

    // 한국어 응답 및 디스코드 마크다운 형식을 강제하는 프롬프트 구성
    const prompt = `다음 질문에 대해 실시간 검색 결과를 바탕으로 한국어로 답변해줘. 
디스코드 마크다운(### 제목, **굵게** 등)을 사용하여 가독성 있게 작성하고, 질문의 핵심 내용을 잘 정리해줘.

질문: ${query}`;

    const result = await model.generateContent(prompt);
    const response = result?.response;
    let text = response?.text?.();

    if (!text) {
      throw new Error("Google 검색에서 응답 텍스트를 받지 못했습니다.");
    }

    // 검색 출처(Grounding Metadata) 추출 및 하단 추가
    const metadata = response?.candidates?.[0]?.groundingMetadata;
    if (metadata?.groundingChunks) {
      const uniqueDomains = new Map();
      metadata.groundingChunks.forEach((chunk) => {
        if (chunk.web?.uri) {
          try {
            const domain = new URL(chunk.web.uri).hostname.replace(/^www\./, "");
            // 동일한 도메인이 여러 번 나와도 한 번만 추가되도록 설정
            if (!uniqueDomains.has(domain)) {
              uniqueDomains.set(domain, chunk.web.uri);
            }
          } catch {
            // 잘못된 URL 형식인 경우 무시
          }
        }
      });

      if (uniqueDomains.size > 0) {
        const footer = Array.from(uniqueDomains.entries())
          .slice(0, 5) // 최대 5개의 고유 도메인만 표시
          .map(([domain, uri]) => `${domain}`)
          .join(" | ");
        text = `${text.trim()}\n\n-# 🔗 출처: ${footer}`;
      }
    }

    return text.trim();
  } catch (error) {
    logError("google_search_handler_error", null, error, { query });
    throw new Error("웹 검색 정보를 가져오는 중 오류가 발생했습니다.");
  }
}
