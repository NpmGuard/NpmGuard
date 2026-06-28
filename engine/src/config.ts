import "dotenv/config";
import { z } from "zod";

const LLMBackend = z.enum(["anthropic", "google", "openai_compatible"]);
const EnvBoolean = z
  .string()
  .transform((v) => !["0", "false", "no", "off"].includes(v.toLowerCase()))
  .default("true");

const ConfigSchema = z.object({
  llmBackend: LLMBackend.default("anthropic"),
  llmBaseUrl: z.string().url().optional(),
  llmApiKey: z.string().optional(),
  llmTimeoutSeconds: z.coerce.number().positive().default(60),

  apiHost: z.string().default("0.0.0.0"),
  apiPort: z.coerce.number().int().min(1).max(65535).default(8000),

  // Payment (Stripe)
  paymentRequired: EnvBoolean,
  creApiKey: z.string().optional(),
  stripeSecretKey: z.string().optional(),
  stripeWebhookSecret: z.string().optional(),
  auditPriceCents: z.coerce.number().int().min(50).default(500),

  triageModel: z.string().default("claude-haiku-4-5-20251001"),
  triageMaxFiles: z.coerce.number().int().min(1).max(1000).default(80),

  investigationModel: z.string().default("claude-sonnet-4-6"),
  maxAgentTurns: z.coerce.number().int().min(1).max(200).default(30),
  investigationEnabled: z
    .string()
    .transform((v) => v.toLowerCase() !== "false")
    .default("true"),

  testGenModel: z.string().default("claude-sonnet-4-6"),
  testGenMode: z.enum(["openclaw", "direct"]).default("direct"),
  /**
   * Maximum number of findings for which test-gen attempts to generate a
   * reproducer (sorted by confidence: CONFIRMED > LIKELY > SUSPECTED).
   * 0 means unlimited, which is the production default: proof budget should
   * be explicit in tests/cost-constrained runs, not a hidden production cap.
   */
  maxFindingsToProve: z.coerce.number().int().min(0).default(0),
  verifyTimeoutSec: z.coerce.number().int().min(10).max(300).default(60),

  sandboxImage: z.string().default("npmguard-sandbox:v1"),
  sandboxMemoryMb: z.coerce.number().int().min(64).max(4096).default(512),
  sandboxCpus: z.coerce.number().positive().max(4).default(1),
  sandboxNetwork: z.string().default("none"),
  maxDockerExecTimeoutSec: z.coerce.number().int().min(5).max(300).default(30),
});

function loadConfig() {
  const env = process.env;
  const raw = {
    llmBackend: env.NPMGUARD_LLM_BACKEND,
    llmBaseUrl: env.NPMGUARD_LLM_BASE_URL,
    llmApiKey: env.NPMGUARD_LLM_API_KEY,
    llmTimeoutSeconds: env.NPMGUARD_LLM_TIMEOUT_SECONDS,
    apiHost: env.NPMGUARD_API_HOST,
    apiPort: env.NPMGUARD_API_PORT,
    paymentRequired: env.NPMGUARD_PAYMENT_REQUIRED,
    creApiKey: env.NPMGUARD_CRE_API_KEY,
    stripeSecretKey: env.NPMGUARD_STRIPE_SECRET_KEY,
    stripeWebhookSecret: env.NPMGUARD_STRIPE_WEBHOOK_SECRET,
    auditPriceCents: env.NPMGUARD_AUDIT_PRICE_CENTS,
    triageModel: env.NPMGUARD_TRIAGE_MODEL,
    triageMaxFiles: env.NPMGUARD_TRIAGE_MAX_FILES,
    investigationModel: env.NPMGUARD_INVESTIGATION_MODEL,
    maxAgentTurns: env.NPMGUARD_MAX_AGENT_TURNS,
    investigationEnabled: env.NPMGUARD_INVESTIGATION_ENABLED,
    testGenModel: env.NPMGUARD_TEST_GEN_MODEL,
    testGenMode: env.NPMGUARD_TEST_GEN_MODE,
    maxFindingsToProve: env.NPMGUARD_MAX_FINDINGS_TO_PROVE,
    verifyTimeoutSec: env.NPMGUARD_VERIFY_TIMEOUT_SEC,
    sandboxImage: env.NPMGUARD_SANDBOX_IMAGE,
    sandboxMemoryMb: env.NPMGUARD_SANDBOX_MEMORY_MB,
    sandboxCpus: env.NPMGUARD_SANDBOX_CPUS,
    sandboxNetwork: env.NPMGUARD_SANDBOX_NETWORK,
    maxDockerExecTimeoutSec: env.NPMGUARD_MAX_DOCKER_EXEC_TIMEOUT_SEC,
  };

  // Strip undefined keys so Zod defaults apply
  const cleaned = Object.fromEntries(
    Object.entries(raw).filter(([, v]) => v !== undefined),
  );

  const result = ConfigSchema.safeParse(cleaned);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${JSON.stringify(result.error.format(), null, 2)}`);
  }

  // Validate: openai_compatible requires base URL
  if (result.data.llmBackend === "openai_compatible" && !result.data.llmBaseUrl) {
    throw new Error("NPMGUARD_LLM_BASE_URL is required when NPMGUARD_LLM_BACKEND=openai_compatible");
  }

  return result.data;
}

export const config = loadConfig();
export type Config = z.infer<typeof ConfigSchema>;
export const PAYMENT_REQUIRED = config.paymentRequired;
export const STRIPE_ENABLED = !!config.stripeSecretKey;

export const SKIP_DIRS = new Set(["node_modules", ".git", ".svn"]);

/** File types (from classify.ts) that the LLM analyzes in triage. */
export const SOURCE_FILE_TYPES = new Set(["js", "ts"]);
