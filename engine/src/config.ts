import "dotenv/config";
import { z } from "zod";

const LLMBackend = z.enum(["anthropic", "google", "openai_compatible"]);
const EnvBoolean = z
  .string()
  .transform((v) => !["0", "false", "no", "off"].includes(v.toLowerCase()))
  .default("true");
const EnvBooleanFalse = z
  .string()
  .transform((v) => !["0", "false", "no", "off"].includes(v.toLowerCase()))
  .default("false");

const ConfigSchema = z.object({
  llmBackend: LLMBackend.default("anthropic"),
  llmBaseUrl: z.string().url().optional(),
  llmApiKey: z.string().optional(),
  llmModel: z.string().optional(),
  llmTimeoutSeconds: z.coerce.number().positive().default(60),
  deepseekThinkingEnabled: EnvBooleanFalse,

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

  // GitHub App + repo panel (spec: docs/specs/2026-07-07-github-repo-panel.md)
  githubAppId: z.string().optional(),
  githubAppPrivateKeyPath: z.string().optional(),
  githubClientId: z.string().optional(),
  githubClientSecret: z.string().optional(),
  githubWebhookSecret: z.string().optional(),
  /** 32-byte hex key for AES-256-GCM encryption of stored user tokens. */
  encryptionKey: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
  smtpUrl: z.string().optional(),
  alertFrom: z.string().default("NpmGuard <alerts@npmguard.com>"),
  panelBaseUrl: z.string().url().default("http://localhost:3000"),
  scanConcurrency: z.coerce.number().int().min(1).max(16).default(4),
  watchIntervalMin: z.coerce.number().int().min(1).default(15),
  betaMaxProtectedRepos: z.coerce.number().int().min(0).default(10),
  betaMaxAuditsMonth: z.coerce.number().int().min(0).default(5000),
});

function loadConfig() {
  const env = process.env;
  const raw = {
    llmBackend: env.NPMGUARD_LLM_BACKEND,
    llmBaseUrl: env.NPMGUARD_LLM_BASE_URL,
    llmApiKey: env.NPMGUARD_LLM_API_KEY,
    llmModel: env.NPMGUARD_LLM_MODEL,
    llmTimeoutSeconds: env.NPMGUARD_LLM_TIMEOUT_SECONDS,
    deepseekThinkingEnabled: env.NPMGUARD_DEEPSEEK_THINKING_ENABLED,
    apiHost: env.NPMGUARD_API_HOST,
    apiPort: env.NPMGUARD_API_PORT,
    paymentRequired: env.NPMGUARD_PAYMENT_REQUIRED,
    creApiKey: env.NPMGUARD_CRE_API_KEY,
    stripeSecretKey: env.NPMGUARD_STRIPE_SECRET_KEY,
    stripeWebhookSecret: env.NPMGUARD_STRIPE_WEBHOOK_SECRET,
    auditPriceCents: env.NPMGUARD_AUDIT_PRICE_CENTS,
    triageModel: env.NPMGUARD_TRIAGE_MODEL ?? env.NPMGUARD_LLM_MODEL,
    triageMaxFiles: env.NPMGUARD_TRIAGE_MAX_FILES,
    investigationModel: env.NPMGUARD_INVESTIGATION_MODEL ?? env.NPMGUARD_LLM_MODEL,
    maxAgentTurns: env.NPMGUARD_MAX_AGENT_TURNS,
    investigationEnabled: env.NPMGUARD_INVESTIGATION_ENABLED,
    testGenModel: env.NPMGUARD_TEST_GEN_MODEL ?? env.NPMGUARD_LLM_MODEL,
    testGenMode: env.NPMGUARD_TEST_GEN_MODE,
    maxFindingsToProve: env.NPMGUARD_MAX_FINDINGS_TO_PROVE,
    verifyTimeoutSec: env.NPMGUARD_VERIFY_TIMEOUT_SEC,
    sandboxImage: env.NPMGUARD_SANDBOX_IMAGE,
    sandboxMemoryMb: env.NPMGUARD_SANDBOX_MEMORY_MB,
    sandboxCpus: env.NPMGUARD_SANDBOX_CPUS,
    sandboxNetwork: env.NPMGUARD_SANDBOX_NETWORK,
    maxDockerExecTimeoutSec: env.NPMGUARD_MAX_DOCKER_EXEC_TIMEOUT_SEC,
    githubAppId: env.NPMGUARD_GITHUB_APP_ID,
    githubAppPrivateKeyPath: env.NPMGUARD_GITHUB_APP_PRIVATE_KEY_PATH,
    githubClientId: env.NPMGUARD_GITHUB_CLIENT_ID,
    githubClientSecret: env.NPMGUARD_GITHUB_CLIENT_SECRET,
    githubWebhookSecret: env.NPMGUARD_GITHUB_WEBHOOK_SECRET,
    encryptionKey: env.NPMGUARD_ENCRYPTION_KEY,
    smtpUrl: env.NPMGUARD_SMTP_URL,
    alertFrom: env.NPMGUARD_ALERT_FROM,
    panelBaseUrl: env.NPMGUARD_PANEL_BASE_URL,
    scanConcurrency: env.NPMGUARD_SCAN_CONCURRENCY,
    watchIntervalMin: env.NPMGUARD_WATCH_INTERVAL_MIN,
    betaMaxProtectedRepos: env.NPMGUARD_BETA_MAX_PROTECTED_REPOS,
    betaMaxAuditsMonth: env.NPMGUARD_BETA_MAX_AUDITS_MONTH,
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
/**
 * Panel + GitHub App features require the full App credential set, including
 * the encryption key (user tokens are stored encrypted — spec §5.9).
 */
const GITHUB_APP_VARS: Record<string, string | undefined> = {
  NPMGUARD_GITHUB_APP_ID: config.githubAppId,
  NPMGUARD_GITHUB_APP_PRIVATE_KEY_PATH: config.githubAppPrivateKeyPath,
  NPMGUARD_GITHUB_CLIENT_ID: config.githubClientId,
  NPMGUARD_GITHUB_CLIENT_SECRET: config.githubClientSecret,
  NPMGUARD_ENCRYPTION_KEY: config.encryptionKey,
};
export const GITHUB_APP_ENABLED = Object.values(GITHUB_APP_VARS).every(Boolean);
{
  const missing = Object.entries(GITHUB_APP_VARS)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0 && missing.length < Object.keys(GITHUB_APP_VARS).length) {
    console.warn(`[config] GitHub App partially configured — missing: ${missing.join(", ")}`);
  }
}

export const SKIP_DIRS = new Set(["node_modules", ".git", ".svn"]);

/** File types (from classify.ts) that the LLM analyzes in triage. */
export const SOURCE_FILE_TYPES = new Set(["js", "ts"]);
