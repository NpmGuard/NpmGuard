import type { Event } from "@npmguard/shared";
import { dockerExec } from "../sandbox/docker.js";

/**
 * L3 filesystem-diff sensor.
 *
 * Snapshot-based because our sandbox mounts `/pkg`, `/home/node`, and `/tmp`
 * as tmpfs — `docker diff` operates on the container's writable layer and
 * sees none of those. We use `find -printf` to list (path, size, mtime) tuples
 * before and after the trigger, then compute set-diff in JS.
 *
 * Watch paths exclude `/tmp` by default because engine-written files (the
 * L4 instrumentation, faketime state, preload scripts, the fs-diff snapshots
 * themselves) would pollute the result. The watch set is extensible if a
 * caller wants to watch /tmp explicitly.
 */

export const DEFAULT_WATCH_PATHS = ["/pkg", "/home/node"];
const SNAPSHOT_PRE = "/tmp/.npmguard-fsdiff-pre";
const SNAPSHOT_POST = "/tmp/.npmguard-fsdiff-post";

interface FileRecord {
  path: string;
  size: number;
  mtime: number; // Unix seconds (with fractional component)
}

/** Parse `find -printf '%p\t%s\t%T@\n'` output into a path-keyed map. */
export function parseSnapshot(raw: string): Map<string, FileRecord> {
  const out = new Map<string, FileRecord>();
  for (const line of raw.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed) continue;
    const tab1 = trimmed.indexOf("\t");
    if (tab1 === -1) continue;
    const tab2 = trimmed.indexOf("\t", tab1 + 1);
    if (tab2 === -1) continue;
    const path = trimmed.slice(0, tab1);
    const size = Number(trimmed.slice(tab1 + 1, tab2));
    const mtime = Number(trimmed.slice(tab2 + 1));
    if (!path || !Number.isFinite(size) || !Number.isFinite(mtime)) continue;
    out.set(path, { path, size, mtime });
  }
  return out;
}

/** Pure diff: compute Events from before/after snapshots. */
export function diffSnapshots(
  pre: Map<string, FileRecord>,
  post: Map<string, FileRecord>,
  runStartSec: number,
): { events: Event[]; rawDiff: string } {
  const events: Event[] = [];
  const rawLines: string[] = [];

  const tsFromMtime = (mtime: number): number => {
    const deltaSec = mtime - runStartSec;
    if (!Number.isFinite(deltaSec)) return 0;
    return Math.max(0, Math.round(deltaSec * 1e9));
  };

  // Iterate post first so created + modified are ordered by mtime.
  const postKeys = [...post.keys()].sort((a, b) => {
    const ma = post.get(a)!.mtime;
    const mb = post.get(b)!.mtime;
    return ma - mb;
  });

  for (const path of postKeys) {
    const postRec = post.get(path)!;
    const preRec = pre.get(path);
    if (!preRec) {
      events.push({
        stream: "L3:fsDiff",
        timestamp: tsFromMtime(postRec.mtime),
        pid: 0,
        kind: "file_created",
        raw: `A ${path}`,
        normalized: { path, size: postRec.size, mtime: postRec.mtime },
      });
      rawLines.push(`A\t${path}\t${postRec.size}\t${postRec.mtime}`);
    } else if (preRec.size !== postRec.size || preRec.mtime !== postRec.mtime) {
      events.push({
        stream: "L3:fsDiff",
        timestamp: tsFromMtime(postRec.mtime),
        pid: 0,
        kind: "file_modified",
        raw: `M ${path}`,
        normalized: {
          path,
          sizeBefore: preRec.size,
          sizeAfter: postRec.size,
          mtimeBefore: preRec.mtime,
          mtimeAfter: postRec.mtime,
        },
      });
      rawLines.push(
        `M\t${path}\t${preRec.size}->${postRec.size}\t${preRec.mtime}->${postRec.mtime}`,
      );
    }
  }

  // Deleted — no post-hoc mtime so anchor at timestamp 0.
  for (const [path, preRec] of pre) {
    if (post.has(path)) continue;
    events.push({
      stream: "L3:fsDiff",
      timestamp: 0,
      pid: 0,
      kind: "file_deleted",
      raw: `D ${path}`,
      normalized: { path, sizeBefore: preRec.size },
    });
    rawLines.push(`D\t${path}\t${preRec.size}`);
  }

  return { events, rawDiff: rawLines.join("\n") + (rawLines.length ? "\n" : "") };
}

function findCmd(
  watchPaths: readonly string[],
  outFile: string,
): string {
  const paths = watchPaths.join(" ");
  // Use `-printf '%p\t%s\t%T@\n'` and `sort` for stable ordering.
  // 2>/dev/null swallows "permission denied" on unreadable entries (harmless).
  return `find ${paths} -type f -printf '%p\\t%s\\t%T@\\n' 2>/dev/null | sort > ${outFile}`;
}

/** Write the pre-trigger snapshot. Call after all setup (postStart hooks). */
export async function snapshotPre(
  containerName: string,
  watchPaths: readonly string[] = DEFAULT_WATCH_PATHS,
): Promise<void> {
  const res = await dockerExec(
    ["exec", containerName, "sh", "-c", findCmd(watchPaths, SNAPSHOT_PRE)],
    15_000,
  );
  if (res.exitCode !== 0) {
    throw new Error(`fs-diff: pre-snapshot failed: ${res.stderr.slice(0, 300)}`);
  }
}

export interface FsDiffResult {
  events: Event[];
  rawDiff: string;
}

/**
 * Take the post-trigger snapshot and compute the diff against the pre-snapshot.
 * Returns both the Event list and the raw human-readable diff (for blob storage).
 */
export async function snapshotPostAndDiff(
  containerName: string,
  runStartSec: number,
  watchPaths: readonly string[] = DEFAULT_WATCH_PATHS,
): Promise<FsDiffResult> {
  const writeRes = await dockerExec(
    ["exec", containerName, "sh", "-c", findCmd(watchPaths, SNAPSHOT_POST)],
    15_000,
  );
  if (writeRes.exitCode !== 0) {
    throw new Error(`fs-diff: post-snapshot failed: ${writeRes.stderr.slice(0, 300)}`);
  }

  const [preRes, postRes] = await Promise.all([
    dockerExec(["exec", containerName, "cat", SNAPSHOT_PRE], 10_000),
    dockerExec(["exec", containerName, "cat", SNAPSHOT_POST], 10_000),
  ]);

  const pre = parseSnapshot(preRes.stdout);
  const post = parseSnapshot(postRes.stdout);
  return diffSnapshots(pre, post, runStartSec);
}
