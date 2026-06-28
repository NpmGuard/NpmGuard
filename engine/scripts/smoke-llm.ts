import { generateObject, generateText } from "ai";
import { z } from "zod";
import { config } from "../src/config.js";
import { getModel } from "../src/llm.js";

const modelName = process.argv[2] ?? config.triageModel;
const model = getModel(modelName);

console.log(`[smoke:llm] backend=${config.llmBackend} model=${modelName}`);

const text = await generateText({
  model,
  prompt: "Reply with exactly: npmguard-llm-ok",
  // Reasoning models can spend a small budget before emitting final text.
  maxOutputTokens: 256,
});

console.log(`[smoke:llm] text=${JSON.stringify(text.text.trim())}`);

const structured = await generateObject({
  model,
  schema: z.object({
    status: z.literal("ok"),
    model: z.string(),
  }),
  prompt: `Return JSON with status "ok" and model "${modelName}".`,
});

console.log(`[smoke:llm] object=${JSON.stringify(structured.object)}`);
