import type { CapExceededBody } from "./engine-types.ts";

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

/**
 * 402 cap bodies carry full entitlements — detect them (branch on status +
 * the `cap:true` marker, never on message text) to open the paywall.
 */
export function capBody(err: unknown): CapExceededBody | null {
  if (err instanceof ApiError && err.status === 402 && err.body && typeof err.body === "object") {
    const body = err.body as Record<string, unknown>;
    if (body["cap"] === true) return err.body as CapExceededBody;
  }
  return null;
}

/** 401 `{reauth:true}` = the GitHub OAuth token expired → hard-redirect to login. */
export function isReauth(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status === 401 &&
    typeof err.body === "object" &&
    err.body !== null &&
    (err.body as Record<string, unknown>)["reauth"] === true
  );
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
