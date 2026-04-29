import type { LanguageModel } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { config } from "./config.js";

// MiniMax claims OpenAI compatibility but only at the chat-completions +
// tool-calling level. It does NOT honor `response_format: json_schema` —
// the param is silently ignored and the model replies in free-form
// markdown, which makes the Vercel AI SDK's `generateObject` fail with
// "No object generated".
//
// We work around that with a custom fetch that:
//
//   1. Injects `reasoning_split: true` so MiniMax puts its `<think>` blocks
//      in a separate `reasoning_details` field instead of leaking them into
//      `content`.
//
//   2. Translates `response_format: { type: "json_schema", ... }` into a
//      single-tool function call (which MiniMax DOES honor), so the model
//      is forced to emit a structured response.
//
//   3. Translates the response back: copies `tool_calls[0].function.arguments`
//      into `message.content` so the SDK's `JSON.parse(content)` finds the
//      structured output where it expects it.
//
// The wrapper is only attached when `baseURL` looks like MiniMax — other
// providers (OpenRouter, OpenAI, etc.) bypass it entirely.
const isMiniMax = config.llmBaseUrl?.includes("minimax.io") ?? false;

interface ChatBody {
  model?: string;
  response_format?: {
    type: string;
    json_schema?: { name?: string; description?: string; schema?: unknown };
  };
  tools?: Array<{ type: string; function: { name: string; description?: string; parameters?: unknown } }>;
  tool_choice?: unknown;
  reasoning_split?: boolean;
  [key: string]: unknown;
}

const minimaxFetch: typeof fetch = async (input, init) => {
  let translatedSchemaToTool = false;
  if (init?.body && typeof init.body === "string") {
    try {
      const body: ChatBody = JSON.parse(init.body);
      body.reasoning_split = true;

      // Translate response_format json_schema → tool calling (level 3 → level 2)
      if (body.response_format?.type === "json_schema" && body.response_format.json_schema) {
        translatedSchemaToTool = true;
        const js = body.response_format.json_schema;
        const toolName = (js.name ?? "output_response").replace(/[^A-Za-z0-9_-]/g, "_");
        body.tools = [
          ...(body.tools ?? []),
          {
            type: "function",
            function: {
              name: toolName,
              description: js.description ?? "Return the structured response object",
              parameters: js.schema as object,
            },
          },
        ];
        body.tool_choice = { type: "function", function: { name: toolName } };
        delete body.response_format;
      }

      init = { ...init, body: JSON.stringify(body) };
    } catch {
      // Body wasn't JSON — leave it alone
    }
  }

  const resp = await fetch(input, init);

  // Translate tool_calls back to content so SDK's JSON.parse(content) succeeds.
  // Only translate when WE injected the tool (tracked via flag) — otherwise we'd
  // break `generateText` agent loops that genuinely need tool_calls in the response.
  if (resp.ok && translatedSchemaToTool) {
    try {
      const text = await resp.clone().text();
      const json = JSON.parse(text);
      const tc = json?.choices?.[0]?.message?.tool_calls?.[0];
      if (tc?.function?.arguments && typeof tc.function.arguments === "string") {
        json.choices[0].message.content = tc.function.arguments;
        return new Response(JSON.stringify(json), {
          status: resp.status,
          statusText: resp.statusText,
          headers: resp.headers,
        });
      }
      // No tool_call in the response despite tool_choice required — log so we
      // can debug. Common causes: provider safety filter, malformed schema.
      console.warn(`[minimax-fetch] expected tool_call missing: finish=${json?.choices?.[0]?.finish_reason}`);
    } catch (err) {
      console.warn(`[minimax-fetch] response parse failed: ${err}`);
    }
  }

  return resp;
};

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
    ...(isMiniMax ? { fetch: minimaxFetch } : {}),
  });
  return openai.chat(modelName);
}
