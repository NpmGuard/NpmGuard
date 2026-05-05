import type { LanguageModel } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { config } from "./config.js";

/**
 * When the backend is openai_compatible (e.g. OpenRouter) and the model name
 * is a bare Anthropic/Google model ID without a provider prefix, prepend the
 * provider so the router resolves it correctly.
 */
function normalizeForOpenAICompat(modelName: string): string {
  if (modelName.includes("/")) return modelName;
  if (modelName.startsWith("claude-")) return `anthropic/${modelName}`;
  if (modelName.startsWith("gemini-")) return `google/${modelName}`;
  return modelName;
}

export function getModel(modelName: string): LanguageModel {
  if (config.llmBackend === "anthropic") {
    return anthropic(modelName);
  }
  if (config.llmBackend === "google") {
    const google = createGoogleGenerativeAI({
      apiKey: config.llmApiKey ?? "",
    });
    return google(modelName);
  }
  if (!config.llmBaseUrl) {
    throw new Error("NPMGUARD_LLM_BASE_URL is required for openai_compatible backend");
  }
  const openai = createOpenAI({
    baseURL: config.llmBaseUrl,
    apiKey: config.llmApiKey ?? "",
  });
  return openai.chat(normalizeForOpenAICompat(modelName));
}
