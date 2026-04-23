import * as net from "node:net";
// eslint-disable-next-line @typescript-eslint/no-var-requires -- chrome-remote-interface is CJS
import CDPModule from "chrome-remote-interface";
import type { Event } from "@npmguard/shared";

/**
 * L4:v8inspector sensor.
 *
 * Attaches to a Node process launched with `--inspect-brk=0.0.0.0:9229` via
 * Chrome DevTools Protocol. Subscribes to `Debugger.scriptParsed` — which
 * fires for every compiled script including dynamically-generated code
 * (`eval`, `new Function`, `Module._compile`). For static malware this is
 * mostly noise; for obfuscated/deobfuscating malware it surfaces the
 * decoded source at the moment V8 compiles it, before it runs.
 *
 * v1 scope: scriptParsed only. Breakpoints on fs/http/crypto etc. and
 * L1↔JS-frame correlation are in the Sprint 5b / v2 roadmap.
 */

// CRI is a CommonJS module exporting a function as its default. TS types put
// the function on the namespace; Node ESM interop gives us the default on
// `.default` at runtime. Coerce once so callers use a normal function.
const CDP = (CDPModule as unknown as { default: typeof CDPModule }).default ?? CDPModule;

export interface AttachOptions {
  host: string;
  port: number;
  /** Max attempts (50ms apart) before giving up on the inspector socket. */
  maxAttempts?: number;
}

export interface V8InspectorHandle {
  events: Event[];
  /** NDJSON: one line per recorded CDP event. Suitable for blob storage. */
  rawLog: () => string;
  /**
   * Resolves when the target Node process signals its main V8 context is
   * being destroyed (i.e., it called process.exit or the event loop drained)
   * OR when `timeoutMs` elapses — whichever comes first. The caller should
   * call `close()` after this resolves so Node can finish exiting (Node holds
   * process exit until the inspector client disconnects when `--inspect` is
   * active).
   */
  waitForExit: (timeoutMs: number) => Promise<"context_destroyed" | "timeout">;
  close: () => Promise<void>;
}

/**
 * Connect to Node's CDP port, enable Debugger/Runtime domains, subscribe to
 * scriptParsed, and release execution from the --inspect-brk pause.
 */
export async function attachV8Inspector(
  opts: AttachOptions,
): Promise<V8InspectorHandle> {
  const maxAttempts = opts.maxAttempts ?? 120;
  const client = await connectWithRetry(opts.host, opts.port, maxAttempts);

  const events: Event[] = [];
  const rawLines: string[] = [];

  let contextDestroyedResolve: (() => void) | null = null;
  const contextDestroyedPromise = new Promise<void>((resolve) => {
    contextDestroyedResolve = resolve;
  });

  // Subscribe BEFORE enabling the domain so we don't miss any event that
  // comes immediately after enable().
  client.Debugger.scriptParsed((params: unknown) => {
    const ev = scriptParsedToEvent(params);
    events.push(ev);
    rawLines.push(JSON.stringify({ method: "Debugger.scriptParsed", params }));
  });

  // Runtime.executionContextDestroyed fires when Node tears down the main V8
  // context — i.e., process.exit was called or the event loop drained. We use
  // this as the "close CDP now" signal so Node can finish exiting (when
  // `--inspect` is active, Node blocks on "Waiting for debugger to disconnect"
  // until we close).
  client.Runtime.executionContextDestroyed(() => {
    rawLines.push(JSON.stringify({ method: "Runtime.executionContextDestroyed" }));
    contextDestroyedResolve?.();
  });

  await client.Debugger.enable();
  await client.Runtime.enable();

  // Release the --inspect-brk pause so the trigger actually runs. (No-op with
  // plain --inspect, but harmless — callers may switch strategies.)
  try {
    await client.Runtime.runIfWaitingForDebugger();
  } catch {
    // Non-fatal — if we weren't paused, this is harmless.
  }

  return {
    events,
    rawLog: () => rawLines.join("\n") + (rawLines.length ? "\n" : ""),
    waitForExit: async (timeoutMs: number) => {
      let t: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<"timeout">((resolve) => {
        t = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      const result = await Promise.race<
        "context_destroyed" | "timeout"
      >([
        contextDestroyedPromise.then(() => "context_destroyed" as const),
        timeoutPromise,
      ]);
      if (t !== undefined) clearTimeout(t);
      return result;
    },
    close: async () => {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    },
  };
}

async function connectWithRetry(
  host: string,
  port: number,
  maxAttempts: number,
): Promise<CdpClient> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // TCP ping first — fails fast when Node hasn't opened the port yet.
      await tcpPing(host, port, 200);
      const client = (await CDP({ host, port })) as unknown as CdpClient;
      return client;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(
    `v8-inspector: could not connect to ${host}:${port} after ${maxAttempts} attempts — ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

function tcpPing(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("tcp-ping: timeout"));
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      sock.destroy();
      resolve();
    });
    sock.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Find a free TCP port on the host. */
export function allocateHostPort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      if (typeof addr !== "object" || !addr) {
        reject(new Error("allocateHostPort: no address"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

/** Shape of scriptParsed params we care about (duck-typed from CDP). */
interface ScriptParsedParams {
  scriptId?: string;
  url?: string;
  startLine?: number;
  endLine?: number;
  hash?: string;
  length?: number;
  isModule?: boolean;
  hasSourceURL?: boolean;
  sourceMapURL?: string;
}

/** Transform a CDP Debugger.scriptParsed event into our Event shape. */
export function scriptParsedToEvent(params: unknown): Event {
  const p = (params ?? {}) as ScriptParsedParams;
  return {
    stream: "L4:v8inspector",
    timestamp: 0, // CDP events don't carry a wall-clock; populated as ns=0 for v1.
    pid: 0,
    kind: "script_parsed",
    raw: p,
    normalized: {
      scriptId: String(p.scriptId ?? ""),
      url: String(p.url ?? ""),
      startLine: Number(p.startLine ?? 0),
      endLine: Number(p.endLine ?? 0),
      length: Number(p.length ?? 0),
      cdpHash: String(p.hash ?? ""),
      isModule: Boolean(p.isModule ?? false),
    },
  };
}

// Minimal structural type for the CRI client — avoids leaking its heavy
// generated types through our API.
interface CdpClient {
  Debugger: {
    enable: () => Promise<unknown>;
    scriptParsed: (cb: (params: unknown) => void) => void;
  };
  Runtime: {
    enable: () => Promise<unknown>;
    runIfWaitingForDebugger: () => Promise<unknown>;
    executionContextDestroyed: (cb: (params: unknown) => void) => void;
  };
  close: () => Promise<unknown>;
}
