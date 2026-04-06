import type { LanguageModel } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { config } from "./config.js";

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
  return openai(modelName);
}
