import * as fs from "node:fs";
import * as path from "node:path";
import { SKIP_DIRS } from "../config.js";

// ---------------------------------------------------------------------------
// Bounded tool output — these caps protect the LLM context from exploding
// on packages that ship as a single 10MB+ obfuscated minified line (common
// in real malicious packages: see Datadog corpus
// react-keycloak-context@1.0.8 and similar wallet drainers).
// ---------------------------------------------------------------------------

/** Hard cap on the total bytes returned by any single tool call. Beyond
 *  this we truncate and append a marker. Keep well below the LLM context
 *  budget per turn. */
const MAX_TOOL_OUTPUT_BYTES = 32 * 1024;

/** Cap on individual lines included in search snippets. Long lines are
 *  the signature of obfuscated/minified payloads — we keep enough to
 *  show the pattern and hint at the size, then cut. */
const MAX_LINE_LENGTH = 500;

/** Soft cap for readFile output. Files above this are truncated with a
 *  marker; the agent should switch to grep/regex strategies. We trim to
 *  the same per-tool ceiling above. */
const READ_FILE_TRUNCATION = MAX_TOOL_OUTPUT_BYTES;

const MAX_SEARCH_RESULTS = 50;
const CONTEXT_LINES = 3;
const TEXT_EXTS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".json", ".md", ".txt", ".yml", ".yaml"]);

function safePath(packagePath: string, relPath: string): string | null {
  const abs = path.normalize(path.join(packagePath, relPath));
  const base = path.normalize(packagePath);
  if (!abs.startsWith(base + path.sep) && abs !== base) return null;
  return abs;
}

function clipLine(line: string): string {
  if (line.length <= MAX_LINE_LENGTH) return line;
  return `${line.slice(0, MAX_LINE_LENGTH)}… [line truncated, ${line.length} chars total — likely minified/obfuscated]`;
}

function clipOutput(text: string, totalBytes: number = MAX_TOOL_OUTPUT_BYTES): string {
  if (text.length <= totalBytes) return text;
  return `${text.slice(0, totalBytes)}\n\n... [output truncated at ${totalBytes} bytes, ${text.length} bytes total]`;
}

export function readFileImpl(packagePath: string, relPath: string): string {
  const abs = safePath(packagePath, relPath);
  if (!abs) return `ERROR: path traversal blocked: ${relPath}`;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return `ERROR: file not found: ${relPath}`;
  }
  if (!stat.isFile()) return `ERROR: not a file: ${relPath}`;

  let content: string;
  try {
    content = fs.readFileSync(abs, "utf-8");
  } catch (err) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (content.length > READ_FILE_TRUNCATION) {
    return `${content.slice(0, READ_FILE_TRUNCATION)}\n\n... [file truncated at ${READ_FILE_TRUNCATION} bytes, ${stat.size} bytes total — file is likely minified or obfuscated; use searchFiles or grep on a known pattern instead]`;
  }
  return content;
}

export function listFilesImpl(packagePath: string): string {
  const entries: Array<{ path: string; size: number; ext: string | null }> = [];

  function walk(dir: string) {
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of dirents) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      let size = -1;
      try { size = fs.statSync(abs).size; } catch { /* skip */ }
      const ext = path.extname(entry.name) || null;
      entries.push({ path: path.relative(packagePath, abs), size, ext });
    }
  }

  walk(packagePath);
  return clipOutput(JSON.stringify(entries, null, 2));
}

export function searchFilesImpl(packagePath: string, pattern: string): string {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch (err) {
    return `ERROR: invalid regex: ${err}`;
  }

  const results: string[] = [];

  function walk(dir: string) {
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of dirents) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name);
      if (!TEXT_EXTS.has(ext)) continue;

      let lines: string[];
      try {
        lines = fs.readFileSync(abs, "utf-8").split("\n");
      } catch {
        continue;
      }

      const rel = path.relative(packagePath, abs);
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i] ?? "")) {
          const start = Math.max(0, i - CONTEXT_LINES);
          const end = Math.min(lines.length, i + CONTEXT_LINES + 1);
          const snippet = lines
            .slice(start, end)
            // Clip per line — obfuscated files put 10MB on one line; without
            // this the snippet (and the LLM context) blows up.
            .map((l, j) => `  ${j + start === i ? ">" : " "} ${j + start + 1}: ${clipLine(l ?? "")}`)
            .join("\n");
          results.push(`[${rel}:${i + 1}]\n${snippet}`);

          if (results.length >= MAX_SEARCH_RESULTS) {
            results.push(`... truncated at ${MAX_SEARCH_RESULTS} results`);
            return;
          }
        }
      }
    }
  }

  walk(packagePath);
  const out = results.length ? results.join("\n") : `No matches for pattern: ${pattern}`;
  return clipOutput(out);
}

// ---------------------------------------------------------------------------
// searchInFile — regex search within ONE file, byte-offset based.
//
// `searchFiles` splits by \n and shows line context, which is useless on
// obfuscated bundles where 10MB sits on a single line. `searchInFile`
// operates on raw bytes and returns N characters of surrounding context per
// match, so the agent can probe an obfuscated file (decoder symbols, URLs,
// fs paths, etc.) in 1 tool call instead of grinding 20+ evalJs reads.
// ---------------------------------------------------------------------------

const SEARCH_IN_FILE_CONTEXT = 200;
const SEARCH_IN_FILE_MAX_HITS = 50;

export function searchInFileImpl(packagePath: string, relPath: string, pattern: string): string {
  const abs = safePath(packagePath, relPath);
  if (!abs) return `ERROR: path traversal blocked: ${relPath}`;

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "g");
  } catch (err) {
    return `ERROR: invalid regex: ${err}`;
  }

  let content: string;
  try {
    content = fs.readFileSync(abs, "utf-8");
  } catch (err) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }

  const hits: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    const start = Math.max(0, m.index - SEARCH_IN_FILE_CONTEXT);
    const end = Math.min(content.length, m.index + m[0].length + SEARCH_IN_FILE_CONTEXT);
    const before = content.slice(start, m.index);
    const match = m[0];
    const after = content.slice(m.index + m[0].length, end);
    hits.push(`@offset=${m.index} match=${JSON.stringify(match.slice(0, 200))}\n  ...${before.slice(-SEARCH_IN_FILE_CONTEXT)}[[${match.slice(0, 80)}]]${after.slice(0, SEARCH_IN_FILE_CONTEXT)}...`);
    if (hits.length >= SEARCH_IN_FILE_MAX_HITS) {
      hits.push(`... truncated at ${SEARCH_IN_FILE_MAX_HITS} hits`);
      break;
    }
    // Avoid zero-length-match infinite loop
    if (m.index === regex.lastIndex) regex.lastIndex++;
  }

  if (hits.length === 0) return `No matches for /${pattern}/ in ${relPath} (${content.length} bytes)`;
  return clipOutput(`File: ${relPath} (${content.length} bytes), ${hits.length} matches:\n\n${hits.join("\n\n")}`);
}
