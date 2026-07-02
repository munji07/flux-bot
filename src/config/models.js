/**
 * AI model configuration.
 * Keep provider endpoints and model names centralized here.
 */

export const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

export const ADMIN_USER_ID = "1269575955626725390";

export const MODELS = {
  INTENT: "meta/llama-3.1-8b-instruct",
  CONVERSATION: "qwen/qwen3-32b",
  IMAGE_ANALYSIS: "google/diffusiongemma-26b-a4b-it",
  IMAGE_GENERATION_RUNTIME: "gptimage",
  VIDEO_ANALYSIS: "google/diffusiongemma-26b-a4b-it",
  GEMINI_WEB_SEARCH_MODEL: "gemini-3.5-flash",
  GEMINI_SEARCH_MODEL: "gemini-3.1-flash-lite",
  DEEPSEEK_FLASH: "deepseek-ai/deepseek-v4-flash",
  DEEPSEEK_PRO: "deepseek-ai/deepseek-v4-pro",
  LLAMA_33: "meta/llama-3.3-70b-instruct",
  INTENT_FALLBACK: "meta/llama-3.1-8b-instruct",
  CHAT_TEXT: "qwen/qwen3-32b",
  VIDEO_RUNTIME: "nvidia/nemotron-nano-12b-v2-vl",
  LOG_SUMMARY: "qwen/qwen3-32b",
  WEB_SEARCH_CLASSIFIER: "meta/llama-3.1-8b-instruct",
  MEMBER_MATCHER: "meta/llama-3.1-8b-instruct",
  GOOGLE_SEARCH: "gemini-2.5-flash",
};

export default MODELS;

