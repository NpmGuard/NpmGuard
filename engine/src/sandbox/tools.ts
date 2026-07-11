import { z } from "zod";
import { type ToolCall, TriggerKind, type Trigger } from "@npmguard/shared";
import type { Manipulation } from "../manipulation/types.js";
import { setEnv } from "../manipulation/env.js";
import { setDate } from "../manipulation/date.js";
import { preload } from "../manipulation/preload.js";
import { plantFiles } from "../manipulation/plant-files.js";
import { patchFile } from "../manipulation/patch-file.js";
import { stubUrl } from "../manipulation/stub-url.js";

// ---------------------------------------------------------------------------
// The shared tool registry — the single contract behind the RUN layer.
//
// Each tool pairs a semantic name + human description + a Zod `paramSchema`
// with a pure `build()` that wraps one existing `manipulation/` primitive (or,
// for `trigger`, produces the run's `Trigger`). This one file is meant to be
// read by BOTH the HYPOTHESIZE prompt (renders the tool list for the model)
// and the sandbox executor (`compileExperiment`) — one source of truth, no
// drift between what the model is offered and what actually runs.
//
// An experiment is a `ToolCall[]`. Compiling it is where the registry's
// invariants are enforced:
//   - every call names a known tool                (else the experiment is incoherent → error)
//   - every call's args validate against its schema (else the experiment is incoherent → error)
//   - exactly one call is a `trigger`              (a run has one and only one entrypoint)
// A compiled experiment therefore always yields a concrete `{ setup, trigger }`
// the runner can execute without re-checking anything.
// ---------------------------------------------------------------------------

/**
 * A tool either contributes to the pre-run setup (a `Manipulation`) or defines
 * how the package is invoked (the `Trigger`). The kind decides which bucket a
 * compiled call lands in, and enforces the exactly-one-trigger invariant.
 */
export type ToolKind = "setup" | "trigger";

// Each tool's `paramSchema` is a ZodObject at runtime; the HYPOTHESIZE generation
// schema assembles those objects into a discriminated union (buildExperimentSchema)
// so the registry is the single source of the typed arg shapes for both the
// prompt schema and the executor.
interface SetupTool<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  kind: "setup";
  paramSchema: S;
  build: (args: z.infer<S>) => Manipulation;
}

interface TriggerTool<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  kind: "trigger";
  paramSchema: S;
  build: (args: z.infer<S>) => Trigger;
}

export type Tool = SetupTool<z.ZodTypeAny> | TriggerTool<z.ZodTypeAny>;

function setupTool<S extends z.ZodTypeAny>(t: Omit<SetupTool<S>, "kind">): SetupTool<S> {
  return { kind: "setup", ...t };
}

function triggerTool<S extends z.ZodTypeAny>(t: Omit<TriggerTool<S>, "kind">): TriggerTool<S> {
  return { kind: "trigger", ...t };
}

// ---------------------------------------------------------------------------
// The tools. This list is the whole vocabulary an experiment may use — a tool
// call naming anything not here is an incoherent experiment (an error). New
// tools are added by analyzing logged audits (data-driven), never as an
// in-flight escape hatch.
// ---------------------------------------------------------------------------

const setEnvTool = setupTool({
  name: "setEnv",
  description:
    "Inject environment variables into the sandbox before the trigger runs. " +
    "Use to plant bait credentials (NPM_TOKEN, AWS_ACCESS_KEY_ID) or to defeat " +
    "an environment gate the payload checks (e.g. CI=true).",
  paramSchema: z.object({
    env: z.record(z.string()),
  }),
  build: (args) => setEnv(args.env),
});

const plantFilesTool = setupTool({
  name: "plantFiles",
  description:
    "Seed files into the sandbox filesystem before the trigger runs. Paths are " +
    "absolute inside the container (no ~ expansion), e.g. /home/node/.npmrc or " +
    "/home/node/.ssh/id_rsa. Use to plant bait a credential-stealer would read.",
  paramSchema: z.object({
    files: z
      .array(z.object({ path: z.string(), content: z.string() }))
      .min(1),
  }),
  build: (args) => plantFiles(args.files),
});

const setDateTool = setupTool({
  name: "setDate",
  description:
    "Freeze the sandbox wall-clock at an ISO timestamp (via libfaketime). Use to " +
    "defeat a time gate — advance the clock past the trigger date so a " +
    "date-gated payload fires.",
  paramSchema: z.object({
    // ISO-8601 datetime (e.g. 2027-03-01T00:00:00Z). Constrained so the model
    // cannot emit a shape-valid-but-unparseable date ("last tuesday") that only
    // fails when libfaketime rejects it at boot.
    iso: z.string().datetime({ offset: true }),
  }),
  build: (args) => setDate(args.iso),
});

const stubUrlTool = setupTool({
  name: "stubUrl",
  description:
    "Return canned HTTP responses for URLs matching a pattern (`*` wildcard). " +
    "Use to make a payload's remote fetch 'succeed' so a staged second stage " +
    "proceeds. HTTP only; HTTPS is logged at the CONNECT but not intercepted.",
  paramSchema: z.object({
    stubs: z
      .array(
        z.object({
          pattern: z.string(),
          responseStatus: z.number().int().optional(),
          responseBody: z.string().optional(),
          responseHeaders: z.record(z.string()).optional(),
        }),
      )
      .min(1),
  }),
  build: (args) => stubUrl(args.stubs),
});

const patchFileTool = setupTool({
  name: "patchFile",
  description:
    "Rewrite files in the package copy before the trigger runs (string " +
    "find/replace). Use to neutralize an anti-debug check or force a specific " +
    "branch, e.g. replace 'if (Date.now() > T)' with 'if (true)'.",
  paramSchema: z.object({
    patches: z
      .array(
        z.object({
          path: z.string(),
          replacements: z
            .array(z.object({ pattern: z.string(), replacement: z.string() }))
            .min(1),
        }),
      )
      .min(1),
  }),
  build: (args) => patchFile(args.patches),
});

const preloadTool = setupTool({
  name: "preload",
  description:
    "Inject a Node preload script (NODE_OPTIONS=--require) that runs before the " +
    "package entrypoint loads. Use for spies that must be in place at require " +
    "time or to satisfy a precondition the payload expects.",
  paramSchema: z.object({
    code: z.string(),
  }),
  build: (args) => preload(args.code),
});

const triggerTool_ = triggerTool({
  name: "trigger",
  description:
    "Define how the package is invoked — the single entrypoint the experiment " +
    "runs. `kind` is one of entrypoint/lifecycle/bin/subpath; `target` is the " +
    "file, hook name, bin name, or subpath to execute.",
  paramSchema: z.object({
    kind: TriggerKind,
    target: z.string(),
    argv: z.array(z.string()).default([]),
    stdin: z.string().nullable().default(null),
  }),
  build: (args): Trigger => args,
});

/** The whole vocabulary an experiment may use. */
export const TOOLS: readonly Tool[] = [
  setEnvTool,
  plantFilesTool,
  setDateTool,
  stubUrlTool,
  patchFileTool,
  preloadTool,
  triggerTool_,
];

const TOOLS_BY_NAME = new Map<string, Tool>(TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// Compilation — ToolCall[] → the concrete run inputs, with invariants enforced.
// ---------------------------------------------------------------------------

/** Raised when a `ToolCall[]` experiment is incoherent. The caller treats this
 * as an audit-level error (retry/fix the tool call), never a silent skip. */
export class ExperimentCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExperimentCompileError";
  }
}

/** A compiled experiment: setup manipulations plus the one trigger to run. */
export interface CompiledExperiment {
  setup: Manipulation[];
  trigger: Trigger;
}

/**
 * Turn an experiment (a `ToolCall[]`) into the `{ setup, trigger }` the sandbox
 * runs. Enforces the registry invariants (known tool, valid args, exactly one
 * trigger); any violation throws `ExperimentCompileError` — an incoherent
 * experiment is an error, not something to paper over.
 */
export function compileExperiment(experiment: readonly ToolCall[]): CompiledExperiment {
  const setup: Manipulation[] = [];
  let trigger: Trigger | null = null;

  for (const call of experiment) {
    const tool = TOOLS_BY_NAME.get(call.tool);
    if (!tool) {
      throw new ExperimentCompileError(
        `unknown tool '${call.tool}' (known: ${[...TOOLS_BY_NAME.keys()].join(", ")})`,
      );
    }

    const parsed = tool.paramSchema.safeParse(call.args);
    if (!parsed.success) {
      throw new ExperimentCompileError(
        `invalid args for tool '${call.tool}': ${parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`,
      );
    }

    if (tool.kind === "trigger") {
      if (trigger !== null) {
        throw new ExperimentCompileError(
          "experiment has more than one trigger — a run has exactly one entrypoint",
        );
      }
      trigger = tool.build(parsed.data);
    } else {
      setup.push(tool.build(parsed.data));
    }
  }

  if (trigger === null) {
    throw new ExperimentCompileError(
      "experiment has no trigger — nothing to run",
    );
  }

  return { setup, trigger };
}

/**
 * Render the tool vocabulary (name + purpose) for the HYPOTHESIZE prompt. The
 * model chooses WHICH tools to compose from these descriptions; the exact arg
 * SHAPES come from the typed generation schema (buildExperimentSchema), not from
 * prose — so the catalog no longer needs to spell out arg examples.
 */
export function renderToolCatalog(): string {
  return TOOLS.map((t) => `- ${t.name} (${t.kind}): ${t.description}`).join("\n");
}

// ---------------------------------------------------------------------------
// The HYPOTHESIZE generation schema — the experiment, typed all the way down.
//
// This is what the model fills in one shot. `setup` is a discriminated union
// over the setup tools (each variant carries that tool's real paramSchema args,
// so there is no freeform `args` hole to mis-shape), and `trigger` is one typed
// field whose `target` is an enum of the package's real runnable files (so a
// nonexistent target — which would run nothing and read as a false SAFE — is
// unrepresentable). The variants ARE the registry paramSchemas: one source of
// truth for the prompt schema and the executor.
// ---------------------------------------------------------------------------

/** The typed experiment the model composes: setup calls + exactly one trigger. */
export function buildExperimentSchema(triggerTargets: readonly string[]) {
  const setupVariants = TOOLS.filter((t) => t.kind === "setup").map((t) =>
    (t.paramSchema as z.AnyZodObject).extend({ tool: z.literal(t.name) }),
  );
  const setupUnion = z.discriminatedUnion(
    "tool",
    setupVariants as [z.AnyZodObject, z.AnyZodObject, ...z.AnyZodObject[]],
  );

  // The trigger runs one real file in the package as an entrypoint. The model
  // picks only WHICH file (from the enum); `kind` is not a model choice — every
  // run is an entrypoint execution of the target file — so the model cannot
  // fight over it or emit an off-enum kind like "install".
  const trigger = z.object({
    target: z
      .enum(triggerTargets as [string, ...string[]])
      .describe("The package file to run as the entrypoint (e.g. an install script or the runtime entry)."),
  });

  return z.object({
    setup: z
      .array(setupUnion)
      .describe("Ordered setup calls that plant bait and defeat any gate before the trigger."),
    trigger,
  });
}
