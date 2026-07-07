// Small cross-cutting helpers shared across phases + the orchestrator.

/**
 * Race a promise against a wall-clock timeout. Rejects with a labelled error if
 * the timer wins; always clears the timer so it can't leak or hold the loop.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Prefix each line with its 1-based number (`N: line`) for LLM prompts. */
export function numberLines(contents: string): string {
  return contents
    .split("\n")
    .map((line, i) => `${i + 1}: ${line}`)
    .join("\n");
}
