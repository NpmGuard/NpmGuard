import {
  CapExceededSchema,
  ReauthRequiredSchema,
  ScanAlreadyRunningSchema,
  type CapExceeded,
  type ScanAlreadyRunning,
} from "@npmguard/shared";

/**
 * HTTP error carrying the parsed engine body. App code branches on `status`
 * (and the typed helpers below), never on error message text.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, fallback: string) {
    super(errorDetail(body, fallback));
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export function errorDetail(raw: unknown, fallback: string): string {
  if (raw && typeof raw === "object") {
    const rec = raw as Record<string, unknown>;
    for (const key of ["message", "error", "reason"]) {
      const value = rec[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Named error bodies — each one a SCHEMA parse, not a structural sniff
// ---------------------------------------------------------------------------
// The three classifiers below used to hand-check one marker field each
// (`body.cap === true`, `body.reauth === true`, `typeof body.scanId ===
// "number"`). shared/src/panel.ts names all three bodies, and its B9 note is
// exactly this: "a structural sniff is a missing type". Parsing the whole body
// means a 402 that has lost its `entitlements` no longer reaches the paywall as
// a half-populated object — it fails the parse and falls through to the generic
// error path, which is honest, instead of rendering an empty meter.

/**
 * 402 cap bodies carry FRESH entitlements, so the client can patch its ledger
 * from the very response that opened the paywall (F-E3) — no second request.
 */
export function capBody(err: unknown): CapExceeded | null {
  if (!(err instanceof ApiError) || err.status !== 402) return null;
  const parsed = CapExceededSchema.safeParse(err.body);
  return parsed.success ? parsed.data : null;
}

/** 401 `{reauth:true}` = the GitHub OAuth token expired → hard-redirect to login.
 * Distinct from a plain 401 because the fix is "restart the OAuth flow", not
 * "show an error" — and distinct from "signed out", which is a plain 401. */
export function isReauth(err: unknown): boolean {
  return (
    err instanceof ApiError && err.status === 401 && ReauthRequiredSchema.safeParse(err.body).success
  );
}

/** 409 from every scan trigger, repo and public alike. NOT a failure: a set is
 * already live and streamable, so the caller streams `scanId` instead. */
export function scanAlreadyRunning(err: unknown): ScanAlreadyRunning | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const parsed = ScanAlreadyRunningSchema.safeParse(err.body);
  return parsed.success ? parsed.data : null;
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * JSON request against the engine. Same-origin (behind the /api proxy).
 * Throws ApiError on non-2xx with the parsed body attached.
 */
export async function request<T>(
  url: string,
  init?: RequestInit & { fallbackError?: string },
): Promise<T> {
  const { fallbackError, ...rest } = init ?? {};
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      ...(rest.body ? { "Content-Type": "application/json" } : {}),
    },
    ...rest,
  });
  const body = await parseBody(res);
  if (!res.ok) {
    throw new ApiError(res.status, body, fallbackError ?? `Request failed (${res.status})`);
  }
  return body as T;
}

export function getJson<T>(url: string, fallbackError?: string): Promise<T> {
  return request<T>(url, { fallbackError });
}

export function postJson<T>(url: string, payload?: unknown, fallbackError?: string): Promise<T> {
  return request<T>(url, {
    method: "POST",
    body: payload === undefined ? undefined : JSON.stringify(payload),
    fallbackError,
  });
}

export function deleteJson<T>(url: string, fallbackError?: string): Promise<T> {
  return request<T>(url, { method: "DELETE", fallbackError });
}
