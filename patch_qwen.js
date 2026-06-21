import fs from 'fs';

// 1. config/models.js 수정
let modelsContent = fs.readFileSync('src/config/models.js', 'utf8');
modelsContent = modelsContent
  .replace(/"qwen\/qwen3-32b"/g, '"qwen-2.5-coder-32b"')
  .replace(/"nvidia\/nemotron-3-nano-30b-a3b"/g, '"qwen-2.5-coder-32b"');
fs.writeFileSync('src/config/models.js', modelsContent, 'utf8');
console.log("config/models.js updated.");

// 2. services/ai.js 수정
let aiContent = fs.readFileSync('src/services/ai.js', 'utf8');

// getClientForModel 수정
const clientFuncTarget = `function getClientForModel(model) {
  if (model && model.startsWith("gemini-")) {
    return geminiClient;
  }
  // NVIDIA NIM 모델들(DeepSeek, Llama 3.3, Nemotron 등)은 nvidiaClient 사용
  return nvidiaClient;
}`;
const clientFuncReplacement = `function getClientForModel(model) {
  if (model && model.startsWith("gemini-")) {
    return geminiClient;
  }
  if (model && (model.startsWith("qwen-") || model.includes("qwen"))) {
    return groqClient;
  }
  // NVIDIA NIM 모델들(DeepSeek, Llama 3.3, Nemotron 등)은 nvidiaClient 사용
  return nvidiaClient;
}`;
aiContent = aiContent.replace(clientFuncTarget, clientFuncReplacement);

// getChatModel 수정
aiContent = aiContent.replace(
  `return imageUrls.length > 0 ? "meta/llama-4-maverick-17b-128e-instruct" : "nvidia/nemotron-3-nano-30b-a3b";`,
  `return imageUrls.length > 0 ? "meta/llama-4-maverick-17b-128e-instruct" : "qwen-2.5-coder-32b";`
);

// normalizeChatModel 수정
const normalizeTarget = `function normalizeChatModel(model) {
  if (!model) return model;

  if (model === "qwen/qwen3-32b" || model === "qwen3" || model === "qwen") {
    return "nvidia/nemotron-3-nano-30b-a3b";
  }

  return model;
}`;
const normalizeReplacement = `function normalizeChatModel(model) {
  if (!model) return model;

  if (model === "qwen/qwen3-32b" || model === "qwen3" || model === "qwen" || model === "groq/qwen3" || model === "qwen-2.5-coder-32b") {
    return "qwen-2.5-coder-32b";
  }

  return model;
}`;
aiContent = aiContent.replace(normalizeTarget, normalizeReplacement);

// createChatCompletion / createChatCompletionStream 등의 하드코딩 교체
aiContent = aiContent.replace(
  `model = normalizeChatModel(userModel) || (imageUrls.length > 0 ? "meta/llama-4-maverick-17b-128e-instruct" : "nvidia/nemotron-3-nano-30b-a3b");`,
  `model = normalizeChatModel(userModel) || (imageUrls.length > 0 ? "meta/llama-4-maverick-17b-128e-instruct" : "qwen-2.5-coder-32b");`
);
aiContent = aiContent.replace(
  `model = normalizeChatModel(userModel) || "nvidia/nemotron-3-nano-30b-a3b";`,
  `model = normalizeChatModel(userModel) || "qwen-2.5-coder-32b";`
);
aiContent = aiContent.replace(
  `const model = "nvidia/nemotron-3-nano-30b-a3b";`,
  `const model = "qwen-2.5-coder-32b";`
);

fs.writeFileSync('src/services/ai.js', aiContent, 'utf8');
console.log("services/ai.js updated.");

// 3. services/subscription.js 수정
let subServiceContent = fs.readFileSync('src/services/subscription.js', 'utf8');
subServiceContent = subServiceContent.replace(
  `if (row.chat_model === 'groq') return 'nvidia/nemotron-3-nano-30b-a3b';`,
  `if (row.chat_model === 'groq') return 'qwen-2.5-coder-32b';`
);
fs.writeFileSync('src/services/subscription.js', subServiceContent, 'utf8');
console.log("services/subscription.js updated.");

// 4. services/database.js 수정
let dbContent = fs.readFileSync('src/services/database.js', 'utf8');
dbContent = dbContent.replace(
  `chat_model TEXT DEFAULT 'nvidia/nemotron-3-nano-30b-a3b',`,
  `chat_model TEXT DEFAULT 'qwen-2.5-coder-32b',`
);
fs.writeFileSync('src/services/database.js', dbContent, 'utf8');
console.log("services/database.js updated.");

// 5. handlers/messageCreate.js 수정
let msgCreateContent = fs.readFileSync('src/handlers/messageCreate.js', 'utf8');
msgCreateContent = msgCreateContent.replace(
  `const usedModel = chatModel || (attachedImageUrls.length > 0 ? "meta/llama-4-maverick-17b-128e-instruct" : "nvidia/nemotron-3-nano-30b-a3b");`,
  `const usedModel = chatModel || (attachedImageUrls.length > 0 ? "meta/llama-4-maverick-17b-128e-instruct" : "qwen-2.5-coder-32b");`
);
fs.writeFileSync('src/handlers/messageCreate.js', msgCreateContent, 'utf8');
console.log("handlers/messageCreate.js updated.");

// 6. commands/management.js 수정 (Nemotron -> Qwen 3)
let manageContent = fs.readFileSync('src/commands/management.js', 'utf8');
manageContent = manageContent
  .replace(/{ label: "Nemotron Chat", value: "nvidia/nemotron-3-nano-30b-a3b"/g, '{ label: "Qwen 3 Chat (Groq)", value: "qwen-2.5-coder-32b"')
  .replace(/nvidia\/nemotron-3-nano-30b-a3b/g, 'qwen-2.5-coder-32b')
  .replace(/Nemotron/g, 'Qwen 3 (Groq)');
fs.writeFileSync('src/commands/management.js', manageContent, 'utf8');
console.log("commands/management.js updated.");
