import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { generateObject } from "ai";
import { CapabilityEnum, type InventoryReport } from "../models.js";
import { config } from "../config.js";
import { getModel } from "../llm.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * What the package claims to do, derived from its own metadata and README.
 * Fed into every per-file MAP in triage so the model can reason about
 * capability mismatch without a separate REDUCE step.
 */
export const PackageIntent = z.object({
  statedPurpose: z
    .string()
    .describe("One or two sentences describing what the package is supposed to do."),
  expectedCapabilities: z
    .array(CapabilityEnum)
    .describe(
      "The set of capability enums a legitimate implementation of this purpose would plausibly need. Prefer a small set — better to flag a legit NETWORK call as surprising than to green-light every capability.",
    ),
  rationale: z
    .string()
    .describe(
      "One sentence explaining why the listed expectedCapabilities match the stated purpose. Used by downstream reasoning + for audit trail.",
    ),
});
export type PackageIntent = z.infer<typeof PackageIntent>;

// ---------------------------------------------------------------------------
// Readme discovery
// ---------------------------------------------------------------------------

const README_CANDIDATES = [
  "README.md",
  "README.MD",
  "Readme.md",
  "readme.md",
  "README",
  "README.markdown",
  "README.txt",
];

const README_MAX_BYTES = 16_000;

/**
 * Find the package README by file record, preferring canonical names.
 * Returns the content (truncated) or null if none found.
 */
export function findReadme(packagePath: string, inventory: InventoryReport): string | null {
  const docFiles = new Set(
    inventory.files
      .filter((f) => f.fileType === "doc" && !f.isBinary)
      .map((f) => f.path),
  );

  for (const candidate of README_CANDIDATES) {
    if (docFiles.has(candidate)) {
      try {
        const content = fs.readFileSync(path.join(packagePath, candidate), "utf-8");
        if (content.length <= README_MAX_BYTES) return content;
        return (
          content.slice(0, README_MAX_BYTES) +
          `\n\n[... truncated, original was ${content.length} bytes ...]`
        );
      } catch {
        // fall through to other candidates
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const INTENT_SYSTEM_PROMPT = `You are a security-aware analyst inferring a package's INTENT from its self-description.
Your output is the baseline the audit compares actual behavior against — capability mismatch drives later hypothesis generation.

Rules:
- Be conservative about expectedCapabilities. Pick only capabilities a straightforward implementation would need. If the README is vague, pick fewer.
- Never add capabilities just because the code "might" use them. Source code is analyzed separately.
- If the stated purpose itself sounds suspicious (keylogger, browser-history dumper, npm-token tool that isn't \`npm\`), still infer what it claims — downstream decides whether to trust it.
- Ignore marketing fluff ("blazing fast", "zero-dep"). Focus on the functional description.`;

export function buildIntentPrompt(
  inventory: InventoryReport,
  readme: string | null,
): string {
  const meta = inventory.metadata;
  const sections: string[] = [];

  sections.push(
    `## Package manifest\n- name: ${meta.name ?? "unknown"}\n- version: ${meta.version ?? "unknown"}\n- description: ${meta.description ?? "(none)"}\n- license: ${meta.license ?? "unknown"}\n- homepage: ${meta.homepage ?? "(none)"}\n- keywords: ${meta.keywords.length ? meta.keywords.join(", ") : "(none)"}`,
  );

  const prodDeps = Object.keys(inventory.dependencies.prod ?? {});
  if (prodDeps.length > 0) {
    sections.push(
      `## Runtime dependencies\n${prodDeps.join(", ")}`,
    );
  }

  if (inventory.entryPoints.bin.length > 0) {
    sections.push(
      `## Declared bin entries\n${inventory.entryPoints.bin.join(", ")}`,
    );
  }

  if (readme) {
    sections.push(`## README\n${readme}`);
  } else {
    sections.push(`## README\n(no README found)`);
  }

  sections.push(
    `## Task\nInfer the package's intent. Populate statedPurpose, expectedCapabilities (as an array of CapabilityEnum values), and rationale.`,
  );

  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Fallback for no-LLM / no-metadata cases
// ---------------------------------------------------------------------------

export function fallbackIntent(inventory: InventoryReport): PackageIntent {
  const desc = inventory.metadata.description?.trim();
  return {
    statedPurpose:
      desc && desc.length > 0
        ? desc
        : "(no stated purpose — package omitted description and README)",
    expectedCapabilities: [],
    rationale:
      "No LLM-derived intent available; downstream analysis must treat any capability as potentially surprising.",
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function extractIntent(
  packagePath: string,
  inventory: InventoryReport,
): Promise<PackageIntent> {
  const readme = findReadme(packagePath, inventory);
  const prompt = buildIntentPrompt(inventory, readme);

  const model = getModel(config.triageModel);
  try {
    const result = await generateObject({
      model,
      schema: PackageIntent,
      system: INTENT_SYSTEM_PROMPT,
      prompt,
    });
    const intent = result.object;
    console.log(
      `[intent] "${intent.statedPurpose.slice(0, 80)}${intent.statedPurpose.length > 80 ? "…" : ""}" → expected=[${intent.expectedCapabilities.join(", ") || "(none)"}]`,
    );
    return intent;
  } catch (err) {
    console.error(
      `[intent] LLM call failed, falling back: ${err instanceof Error ? err.message : String(err)}`,
    );
    return fallbackIntent(inventory);
  }
}
