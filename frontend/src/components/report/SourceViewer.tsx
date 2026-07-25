/**
 * SourceViewer — a read-only CodeMirror 6 source view in the keyline surface
 * (warm paper, hairline gutter, no dark chrome). Optional line highlighting for
 * a hypothesis's suspicious ranges. Used by the Live Audit file view; the
 * durable Report page has no session file access, so `code` may be null.
 */

import { useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { RangeSetBuilder, StateField, type Extension } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { parseLineRanges } from "../../lib/types.ts";

export interface SourceViewerProps {
  code: string | null;
  filename?: string;
  loading?: boolean;
  /** e.g. "12-14, 20" — lines to highlight (a hypothesis's focus range). */
  highlightLines?: string;
}

// Warm, light editor chrome — transparent surface, mono content, quiet gutter.
const keylineTheme = EditorView.theme(
  {
    "&": { backgroundColor: "transparent", color: "var(--ink)", fontSize: "12px" },
    "&.cm-focused": { outline: "none" },
    ".cm-content": { fontFamily: "var(--font-mono)", padding: "8px 0" },
    ".cm-gutters": {
      backgroundColor: "transparent",
      border: "none",
      color: "var(--ink-faint)",
      fontFamily: "var(--font-mono)",
      fontSize: "10px",
    },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 8px" },
    ".cm-activeLine": { backgroundColor: "transparent" },
    ".cm-activeLineGutter": { backgroundColor: "transparent" },
    ".cm-report-hl": { backgroundColor: "var(--suspect-bg)" },
  },
  { dark: false },
);

const highlightLineDeco = Decoration.line({ class: "cm-report-hl" });

function highlightField(ranges: [number, number][]): Extension {
  // Flatten to a sorted, de-duped set of line numbers (RangeSetBuilder needs
  // ascending order and the input ranges may overlap or be unordered).
  const lines = new Set<number>();
  for (const [start, end] of ranges) for (let n = start; n <= end; n++) lines.add(n);
  const sorted = [...lines].sort((a, b) => a - b);

  return StateField.define<DecorationSet>({
    create(state) {
      const builder = new RangeSetBuilder<Decoration>();
      for (const n of sorted) {
        if (n < 1 || n > state.doc.lines) continue;
        builder.add(state.doc.line(n).from, state.doc.line(n).from, highlightLineDeco);
      }
      return builder.finish();
    },
    update(deco, tr) {
      return tr.docChanged ? deco.map(tr.changes) : deco;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}

export function SourceViewer({ code, filename, loading, highlightLines }: SourceViewerProps) {
  const extensions = useMemo(() => {
    const exts: Extension[] = [
      javascript({ jsx: true, typescript: true }),
      keylineTheme,
      EditorView.lineWrapping,
      EditorView.editable.of(false),
    ];
    const ranges = parseLineRanges(highlightLines);
    if (ranges.length) exts.push(highlightField(ranges));
    return exts;
  }, [highlightLines]);

  return (
    <div className="overflow-hidden rounded-md border border-border bg-sunken">
      {filename ? (
        <div className="border-b border-border-faint px-3 py-1.5">
          <span className="font-mono text-2xs tracking-wide text-text-3">{filename}</span>
        </div>
      ) : null}

      {loading ? (
        <div aria-busy="true" role="status" className="px-3 py-6 text-center">
          <span className="text-2xs text-text-3">Loading source…</span>
        </div>
      ) : code == null || code === "" ? (
        <div className="flex items-center justify-center gap-2 px-3 py-6">
          {/* An em-dash, never an empty box: "we have no source for this file"
              is a fact, and a blank panel says nothing at all. */}
          <span aria-hidden="true" className="font-mono text-text-3">
            —
          </span>
          <span className="text-2xs text-text-3">No source available</span>
        </div>
      ) : (
        <CodeMirror
          key={filename ?? "src"}
          value={code}
          editable={false}
          readOnly
          basicSetup={{
            lineNumbers: true,
            foldGutter: false,
            highlightActiveLine: false,
            highlightActiveLineGutter: false,
            highlightSelectionMatches: false,
          }}
          extensions={extensions}
          className="report-source__cm"
        />
      )}
    </div>
  );
}
