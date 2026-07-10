// ---------------------------------------------------------------------------
// Typed error hierarchy — gives the frontend enough context to distinguish
// retryable failures from fatal ones and display meaningful messages.
// ---------------------------------------------------------------------------

export class NpmGuardError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 500,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "NpmGuardError";
  }

  toJSON() {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

export class PackageNotFoundError extends NpmGuardError {
  constructor(packageName: string) {
    super("NPMGUARD-0001", `Package "${packageName}" not found on npm registry`, 404);
  }
}

export class ValidationError extends NpmGuardError {
  constructor(message: string) {
    super("NPMGUARD-0002", message, 400);
  }
}

export class LLMUnavailableError extends NpmGuardError {
  constructor(backend: string, cause?: Error) {
    super(
      "NPMGUARD-0010",
      `LLM backend "${backend}" unavailable: ${cause?.message ?? "unknown"}`,
      503,
      true,
    );
  }
}

export class DockerUnavailableError extends NpmGuardError {
  constructor() {
    super("NPMGUARD-0020", "Docker daemon not reachable", 503, true);
  }
}

export class AuditTimeoutError extends NpmGuardError {
  constructor(phase: string, timeoutMs: number) {
    super("NPMGUARD-0030", `Phase "${phase}" timed out after ${timeoutMs}ms`, 504, true);
  }
}

/**
 * The audit could not complete — a suspicion was raised that the tool could not
 * turn into a decision (FLAG could not read a file, HYPOTHESIZE could not arm a
 * flag, a run or judge could not finish). This is a tool problem to fix and
 * retry, NOT a verdict: "we couldn't check" never leaks out as SAFE/DANGEROUS.
 */
export class AuditIncompleteError extends NpmGuardError {
  constructor(readonly stage: string, detail: string) {
    super("NPMGUARD-0031", `Audit incomplete (${stage}): ${detail}`, 503, true);
    this.name = "AuditIncompleteError";
  }
}

export class QueueFullError extends NpmGuardError {
  constructor() {
    super("NPMGUARD-0040", "Audit queue is full — try again shortly", 503, true);
  }
}

export class SessionLimitError extends NpmGuardError {
  constructor() {
    super("NPMGUARD-0050", "Too many concurrent audit sessions", 503, true);
  }
}
