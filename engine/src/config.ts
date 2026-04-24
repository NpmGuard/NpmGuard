import "dotenv/config";
import { z } from "zod";

const LLMBackend = z.enum(["anthropic", "google", "openai_compatible"]);

const ConfigSchema = z.object({
  llmBackend: LLMBackend.default("anthropic"),
  llmBaseUrl: z.string().url().optional(),
  llmApiKey: z.string().optional(),
  llmTimeoutSeconds: z.coerce.number().positive().default(60),

  apiHost: z.string().default("0.0.0.0"),
  apiPort: z.coerce.number().int().min(1).max(65535).default(8000),

  // Payment (Stripe)
  creApiKey: z.string().optional(),
  stripeSecretKey: z.string().optional(),
  stripeWebhookSecret: z.string().optional(),
  auditPriceCents: z.coerce.number().int().min(50).default(500),

  triageModel: z.string().default("claude-haiku-4-5-20251001"),
  triageRiskThreshold: z.coerce.number().int().min(0).max(10).default(3),

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
   * reproducer. 0 = unlimited (production default). Set a small cap (e.g. 2)
   * in fixture / cost-constrained test runs via `NPMGUARD_MAX_FINDINGS_TO_PROVE`.
   * Capability-based dedup has been removed — two findings with the same
   * capability enum are tested independently. See ARCHITECT_REVIEW_ENGINE.md
   * Finding 4 for why.
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
    creApiKey: env.NPMGUARD_CRE_API_KEY,
    stripeSecretKey: env.NPMGUARD_STRIPE_SECRET_KEY,
    stripeWebhookSecret: env.NPMGUARD_STRIPE_WEBHOOK_SECRET,
    auditPriceCents: env.NPMGUARD_AUDIT_PRICE_CENTS,
    triageModel: env.NPMGUARD_TRIAGE_MODEL,
    triageRiskThreshold: env.NPMGUARD_TRIAGE_RISK_THRESHOLD,
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
export const PAYMENT_ENABLED = !!config.stripeSecretKey;

export const SKIP_DIRS = new Set(["node_modules", ".git", ".svn"]);

/** File types (from classify.ts) that the LLM analyzes in triage. */
export const SOURCE_FILE_TYPES = new Set(["js", "ts"]);
