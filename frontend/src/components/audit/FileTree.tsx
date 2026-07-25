/**
 * FileTree — store.files as a click-to-open list. Selecting a file calls
 * store.selectFile(path); the store fetches the source and auto-follows
 * store.followFile. The selected file's source renders via the shared
 * report/SourceViewer, with the file's suspicious lines highlighted from its
 * fold verdict.
 *
 * ── A FLAG IS NOT A VERDICT ────────────────────────────────────────────────
 *
 * Rows used to carry a coloured status dot toned `safe` / `suspect` / `danger`
 * from `store.fileStatuses`. Two things were wrong with that. `SUSPECT` is
 * deleted from the product's vocabulary (platform-v3 §8b) and cannot be
 * reintroduced as a visual state. And more fundamentally, a per-file status is
 * the output of the FLAG phase — "this file has a capability worth looking at" —
 * not a verdict about the package or even about the file. Painting 120 files
 * green and 4 red renders 124 verdicts the engine never issued.
 *
 * §3.3 asks only that "files that were flagged carry a marker". So flagged files
 * carry a marker and nothing else does: one achromatic glyph on the progress
 * axis, plus `danger` reserved for the files a CONFIRMED finding actually cites.
 */

import { Flag, LoaderCircle, OctagonAlert } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useMemo } from "react";
import { useAuditStore } from "../../stores/auditStore.ts";
import { SourceViewer } from "../report/SourceViewer.tsx";
import { FOCUS_RING } from "../ui/focus.ts";
import type { FileStatus } from "../../lib/types.ts";
import { cn } from "../../lib/cn.ts";

/** The per-file marker. `dangerous` is the only hue: that file is cited by a
 * confirmed finding, which IS a claim we are making. `suspicious` is a flag —
 * neutral, marked, not alarming. Everything else is unmarked, because "we looked
 * at it and it was ordinary" is the quietest fact on the screen. */
function fileMark(status: FileStatus): { Glyph: LucideIcon; tone: string; label: string } | null {
  switch (status) {
    case "analyzing":
      return { Glyph: LoaderCircle, tone: "text-progress-mark animate-spin motion-reduce:animate-none", label: "analyzing" };
    case "suspicious":
      return { Glyph: Flag, tone: "text-progress-ink", label: "flagged" };
    case "dangerous":
      return { Glyph: OctagonAlert, tone: "text-danger-text", label: "cited by a confirmed finding" };
    case "safe":
    case "pending":
    default:
      return null;
  }
}

export function FileTree() {
  const files = useAuditStore((s) => s.files);
  const fileStatuses = useAuditStore((s) => s.fileStatuses);
  const fileVerdicts = useAuditStore((s) => s.fileVerdicts);
  const selectedFile = useAuditStore((s) => s.selectedFile);
  const selectedFileContent = useAuditStore((s) => s.selectedFileContent);
  const selectFile = useAuditStore((s) => s.selectFile);

  const sorted = useMemo(() => [...files].sort((a, b) => a.path.localeCompare(b.path)), [files]);

  if (files.length === 0) {
    return <p className="px-4 py-3 text-sm text-text-3">No files inventoried yet</p>;
  }

  const highlight = selectedFile
    ? (fileVerdicts[selectedFile]?.suspiciousLines ?? undefined)
    : undefined;

  return (
    <div className="grid gap-3">
      <ul className="max-h-72 overflow-y-auto">
        {sorted.map((f) => {
          const status = fileStatuses[f.path] ?? "pending";
          const mark = fileMark(status);
          const active = selectedFile === f.path;
          return (
            <li key={f.path}>
              <button
                type="button"
                onClick={() => selectFile(f.path)}
                aria-current={active ? "true" : undefined}
                aria-label={`view source of ${f.path}`}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left",
                  "transition-colors duration-fast hover:bg-sunken",
                  FOCUS_RING,
                  active && "bg-sunken",
                )}
              >
                {/* A fixed-width gutter whether or not the file is marked, so the
                    names stay in one column and a marked file does not shift. */}
                <span className="flex size-3.5 shrink-0 items-center justify-center">
                  {mark ? (
                    <mark.Glyph
                      aria-hidden="true"
                      strokeWidth={1.5}
                      className={cn("size-3.5", mark.tone)}
                    />
                  ) : null}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-2xs text-text">
                  {f.path}
                </span>
                {/* The marker's meaning as words, not colour alone (§2.4). */}
                {mark ? <span className="sr-only">{mark.label}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>

      {selectedFile ? (
        <div className="border-t border-border-faint">
          <SourceViewer
            code={selectedFileContent}
            filename={selectedFile}
            loading={selectedFileContent === null}
            highlightLines={highlight ?? undefined}
          />
        </div>
      ) : null}
    </div>
  );
}
