/**
 * FileTree — store.files as a click-to-open list, each row a status dot toned by
 * store.fileStatuses (pending grey → analyzing pulse → safe/suspect/danger).
 * Selecting a file calls store.selectFile(path); the store fetches the source and
 * auto-follows store.followFile. The selected file's source renders via the
 * shared report/SourceViewer (loading while content is null), with the file's
 * suspicious lines highlighted from its fold verdict.
 */

import { useMemo } from "react";
import { useAuditStore } from "../../stores/auditStore.ts";
import { SourceViewer } from "../report/SourceViewer.tsx";
import type { FileStatus } from "../../lib/types.ts";

function dotTone(status: FileStatus): string {
  switch (status) {
    case "analyzing":
      return "running";
    case "safe":
      return "safe";
    case "suspicious":
      return "suspect";
    case "dangerous":
      return "danger";
    case "pending":
    default:
      return "";
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
    return <p className="subtext audit-side__empty">No files inventoried yet</p>;
  }

  const highlight = selectedFile
    ? (fileVerdicts[selectedFile]?.suspiciousLines ?? undefined)
    : undefined;

  return (
    <div className="audit-filetree">
      <ul className="audit-filetree__list">
        {sorted.map((f) => {
          const status = fileStatuses[f.path] ?? "pending";
          const tone = dotTone(status);
          const active = selectedFile === f.path;
          return (
            <li key={f.path}>
              <button
                type="button"
                className={`audit-file${active ? " audit-file--active" : ""}`}
                onClick={() => selectFile(f.path)}
                aria-current={active ? "true" : undefined}
                aria-label={`view source of ${f.path}`}
              >
                <span className={`dot${tone ? ` dot--${tone}` : ""}`} aria-hidden="true" />
                <span className="audit-file__name mono">{f.path}</span>
              </button>
            </li>
          );
        })}
      </ul>

      {selectedFile ? (
        <div className="audit-filetree__source">
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
