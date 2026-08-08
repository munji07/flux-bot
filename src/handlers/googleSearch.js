import { logError } from "../logger.js";
import { MODELS } from "../config.js";
import { groqClient } from "../services/ai.js";

export async function handleGoogleSearch(query) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY가 설정되어 있지 않습니다.");

  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: "fast",
        topic: "general",
        max_results: 5,
        include_answer: true,
        include_raw_content: false,
      }),
    });
    if (!response.ok) throw new Error(`Tavily API ${response.status}`);

    const data = await response.json();
    const results = data.results ?? [];
    if (!data.answer && results.length === 0) throw new Error("Tavily 검색 결과가 비어 있습니다.");

    const sourceText = results
      .map((item, index) => `[${index + 1}] ${item.title}\n${item.content || ""}`)
      .join("\n\n")
      .slice(0, 18000);
    const summaryResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.GEMINI_WEB_SEARCH_MODEL}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: "검색 결과를 근거로 한국어로만 답변하는 도우미입니다. 검색 결과 원문이나 메타데이터를 그대로 복사하지 말고 질문에 직접 답하세요. 확인되지 않은 내용은 추측하지 마세요." }] },
          contents: [{ role: "user", parts: [{ text: `질문: ${query}\n\n검색 결과:\n${sourceText || data.answer}` }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 1200 },
        }),
      },
    );
    if (!summaryResponse.ok) {
      if (summaryResponse.status === 429) {
        const fallbackCompletion = await groqClient.chat.completions.create({
          model: MODELS.LOG_SUMMARY,
          messages: [
            { role: "system", content: "검색 결과를 근거로 한국어로만 답변하세요. 검색 결과의 표, 참고 문구, 출처 목록을 그대로 복사하지 말고 자연스러운 제목과 짧은 문단 또는 항목 목록으로 다시 정리하세요. 확인되지 않은 내용은 '확인되지 않음'으로 표시하고 추측하지 마세요. 핵심 정보만 간결하게 작성하세요." },
            { role: "user", content: `질문: ${query}\n\n검색 결과:\n${sourceText || data.answer}` },
          ],
          temperature: 0.2,
          max_completion_tokens: 1200,
        });
        const fallbackAnswer = fallbackCompletion.choices?.[0]?.message?.content?.trim();
        if (!fallbackAnswer) throw new Error("GPT OSS search summary가 비어 있습니다.");
        const sources = results.slice(0, 5).map((item, index) => `${index + 1}. [${item.title}](${item.url})`).join("\n");
        return `${fallbackAnswer}\n\n### 출처\n${sources}`.trim();
      }
      throw new Error(`Gemini search summary API ${summaryResponse.status}`);
    }
    const summaryData = await summaryResponse.json();
    const answer = summaryData.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
    if (!answer) throw new Error("검색 결과 요약이 비어 있습니다.");
    const sources = results.slice(0, 5).map((item, index) => `${index + 1}. [${item.title}](${item.url})`).join("\n");
    return `${answer}\n\n### 출처\n${sources}`.trim();
  } catch (error) {
    logError("tavily_search_handler_error", null, error, { query });
    throw new Error("웹 검색 중 오류가 발생했습니다.");
  }
}
