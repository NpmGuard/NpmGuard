import type { Event, EventKind } from "@npmguard/shared";
import { dockerExec } from "../sandbox/docker.js";

/**
 * L2 network-capture sensor.
 *
 * Starts tcpdump as root inside the container (needs CAP_NET_RAW) before the
 * trigger runs, writing a raw pcap to `/tmp/npmguard-capture.pcap`. After the
 * trigger, stops tcpdump gracefully, uses tshark's JSON export to extract
 * DNS queries, HTTP request lines, and TLS SNI names, and returns the events
 * plus the raw pcap bytes for blob storage.
 *
 * v1 scope:
 *  - Captures from `any` interface inside the container's network namespace.
 *  - Runs with `--network=bridge` (when observe.network=true) so the package
 *    has a real interface to attempt outbound connections on.
 *  - Extracts DNS, HTTP-request, TLS-SNI only. Full packet payloads are in
 *    the raw pcap for offline analysis.
 *  - HTTPS payload MitM is NOT done in v1 (deferred — see doc).
 */

const PCAP_PATH = "/tmp/npmguard-capture.pcap";

/** Launch tcpdump in the container as root. Returns once tcpdump is listening. */
export async function startPcapCapture(containerName: string): Promise<void> {
  // -U flushes per packet so abrupt termination still yields valid data.
  // -i any captures loopback + external interfaces.
  // --user 0 inside the container because capturing needs CAP_NET_RAW at the
  // binary level; our container-run caps include NET_RAW so root has it.
  // `-Z root` keeps tcpdump running as root after starting capture. Avoids
  // the default privilege drop to the `tcpdump` user, which needs CAP_CHOWN
  // to chown the pcap file and leaves us needing CAP_KILL to signal the
  // unprivileged process later. Staying as root lets us live with fewer caps
  // (NET_RAW + SETUID + SETGID) and the container is already hardened by
  // cap-drop=ALL / read-only / pids-limit / user 1000.
  const start = await dockerExec(
    [
      "exec", "-d", "--user", "0", containerName,
      "tcpdump", "-i", "any", "-U", "-Z", "root", "-w", PCAP_PATH,
    ],
    10_000,
  );
  if (start.exitCode !== 0) {
    throw new Error(`pcap: failed to launch tcpdump: ${start.stderr.slice(0, 300)}`);
  }

  // Wait for tcpdump to actually be listening.
  for (let attempt = 0; attempt < 40; attempt++) {
    const check = await dockerExec(
      ["exec", "--user", "0", containerName, "sh", "-c", "pgrep tcpdump >/dev/null"],
      2_000,
    );
    if (check.exitCode === 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("pcap: tcpdump didn't become ready within ~2s");
}

export interface PcapResult {
  events: Event[];
  rawPcap: Buffer;
}

/**
 * Gracefully stop tcpdump, read the raw pcap, and run tshark to extract a
 * selective event view (DNS/HTTP/TLS-SNI). Returns everything for the caller
 * to merge into the RunArtifact.
 */
export async function stopPcapCaptureAndParse(
  containerName: string,
): Promise<PcapResult> {
  // SIGTERM lets tcpdump flush and exit cleanly.
  await dockerExec(
    ["exec", "--user", "0", containerName, "pkill", "-TERM", "tcpdump"],
    5_000,
  ).catch(() => {});
  // Small grace period for flush.
  await new Promise((r) => setTimeout(r, 200));

  // Copy the pcap off the container for blob storage.
  const rawPcap = await copyPcapOut(containerName);

  // Run tshark inside the container to extract selected events as JSON.
  const tsharkRes = await dockerExec(
    [
      "exec", containerName, "tshark", "-r", PCAP_PATH, "-T", "json",
      "-Y", "dns.qry.name or http.request or tls.handshake.extensions_server_name",
      "-2", // two-pass; ensures TLS reassembly even on small captures
    ],
    30_000,
  );

  const events =
    tsharkRes.exitCode === 0 ? parseTsharkJson(tsharkRes.stdout) : [];

  return { events, rawPcap };
}

/**
 * Read the raw pcap out of the container.
 *
 * `docker cp` cannot see files inside tmpfs mounts (a known Docker
 * limitation — it operates on the container's writable layer, which is
 * bypassed by our `--tmpfs /tmp`). We base64-encode the file inside the
 * container and decode on the host instead.
 */
async function copyPcapOut(containerName: string): Promise<Buffer> {
  const res = await dockerExec(
    ["exec", "--user", "0", containerName, "base64", "-w0", PCAP_PATH],
    30_000,
  );
  if (res.exitCode !== 0) {
    throw new Error(`pcap read failed: ${res.stderr.slice(0, 300)}`);
  }
  return Buffer.from(res.stdout.trim(), "base64");
}

/**
 * Parse tshark's `-T json` output (a JSON array of packet objects) into
 * stream-agnostic Events. Exposed for unit tests.
 */
export function parseTsharkJson(jsonText: string): Event[] {
  const trimmed = jsonText.trim();
  if (!trimmed) return [];

  let packets: unknown;
  try {
    packets = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!Array.isArray(packets)) return [];

  const events: Event[] = [];
  for (const pkt of packets) {
    const ev = packetToEvent(pkt);
    if (ev) events.push(ev);
  }
  return events;
}

function packetToEvent(pkt: unknown): Event | null {
  if (!pkt || typeof pkt !== "object") return null;
  const layers = (pkt as { _source?: { layers?: Record<string, unknown> } })._source
    ?.layers;
  if (!layers) return null;

  const timestamp = extractTimestampNs(layers);

  const dnsHost = extractField(layers, "dns", "dns.qry.name");
  if (dnsHost) {
    return makeEvent("dns_query", timestamp, { host: dnsHost }, { dns: dnsHost });
  }

  const httpHost = extractField(layers, "http", "http.host");
  const httpMethod = extractField(layers, "http", "http.request.method");
  const httpUri = extractField(layers, "http", "http.request.uri");
  if (httpHost || httpUri || httpMethod) {
    return makeEvent(
      "http_request",
      timestamp,
      {
        host: httpHost ?? "",
        method: httpMethod ?? "GET",
        path: httpUri ?? "/",
      },
      { host: httpHost, method: httpMethod, uri: httpUri },
    );
  }

  const sni = extractField(layers, "tls", "tls.handshake.extensions_server_name");
  if (sni) {
    return makeEvent("tls_sni", timestamp, { host: sni }, { sni });
  }

  return null;
}

function extractTimestampNs(layers: Record<string, unknown>): number {
  const frame = layers["frame"] as Record<string, unknown> | undefined;
  if (!frame) return 0;
  const rel = extractScalar(frame["frame.time_relative"]);
  if (rel === undefined) return 0;
  const n = Number(rel);
  return Number.isFinite(n) ? Math.max(0, Math.round(n * 1e9)) : 0;
}

function extractField(
  layers: Record<string, unknown>,
  layerName: string,
  fieldName: string,
): string | undefined {
  const layer = layers[layerName];
  if (!layer) return undefined;
  // tshark's -T json nests protocol fields under descriptive containers
  // (e.g., DNS queries live under `dns.Queries["example.com: type A"]`),
  // so we search the subtree instead of looking only at the layer's top level.
  return extractScalarDeep(layer, fieldName);
}

function extractScalar(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) {
    const first = v[0];
    return typeof first === "string" ? first : undefined;
  }
  return typeof v === "string" ? v : undefined;
}

/** Recursively search an object tree for the first scalar value at `fieldName`. */
function extractScalarDeep(obj: unknown, fieldName: string): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const record = obj as Record<string, unknown>;
  const direct = record[fieldName];
  if (direct !== undefined) {
    const scalar = extractScalar(direct);
    if (scalar !== undefined) return scalar;
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === "object") {
      const nested = extractScalarDeep(value, fieldName);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function makeEvent(
  kind: Extract<EventKind, "dns_query" | "http_request" | "tls_sni">,
  timestamp: number,
  normalized: Record<string, unknown>,
  raw: Record<string, unknown>,
): Event {
  return {
    stream: "L2:pcap",
    timestamp,
    pid: 0,
    kind,
    raw,
    normalized,
  };
}
