/** Portfolio coverage strip: protection ratio + stacked proportion rail
 * (attention / scanning / safe / unknown) with a legend. */

import type { PanelRepo } from "../../lib/engine-types.ts";
import { toneDotClass, type Tone } from "./tone.tsx";

interface Segment {
  key: string;
  label: string;
  tone: Tone;
  count: number;
}

export function PortfolioPosture({ repos }: { repos: PanelRepo[] }) {
  if (repos.length === 0) return null;

  let attention = 0;
  let running = 0;
  let safe = 0;
  let unknown = 0;
  for (const repo of repos) {
    const scan = repo.lastScan;
    if (scan?.status === "running") running += 1;
    else if (
      scan &&
      (scan.status === "failed" || scan.verdict === "DANGEROUS" || scan.verdict === "SUSPECT")
    )
      attention += 1;
    else if (scan?.verdict === "SAFE") safe += 1;
    else unknown += 1;
  }

  const protectedCount = repos.filter((repo) => repo.protected).length;
  const audited = repos.filter((repo) => repo.lastScan !== null).length;
  const pct = Math.round((protectedCount / repos.length) * 100);

  const segments: Segment[] = [
    { key: "attention", label: "Attention", tone: "danger", count: attention },
    { key: "running", label: "Scanning", tone: "running", count: running },
    { key: "safe", label: "Safe", tone: "safe", count: safe },
    { key: "unknown", label: "Unknown", tone: "unknown", count: unknown },
  ];

  return (
    <section className="panel-section" aria-label="Portfolio posture">
      <div className="section-title">
        <span className="eyebrow eyebrow--faint">Portfolio</span>
      </div>
      <div className="card panel-posture">
        <div className="panel-posture__head">
          <p className="subtext">
            <strong className="panel-strong">
              {protectedCount} of {repos.length}
            </strong>{" "}
            repositories protected · {pct}%
          </p>
          <span className="microtext">
            {audited} audited · {repos.length - audited} not audited
          </span>
        </div>
        <div
          className="rail"
          role="img"
          aria-label={`${attention} need attention, ${running} scanning, ${safe} safe, ${unknown} unknown`}
        >
          {segments
            .filter((segment) => segment.count > 0)
            .map((segment) => (
              <span
                key={segment.key}
                className={`rail__seg rail__seg--${segment.tone}`}
                style={{ flexGrow: segment.count }}
              />
            ))}
        </div>
        <ul className="panel-posture__legend">
          {segments.map((segment) => (
            <li key={segment.key}>
              <span className={toneDotClass(segment.tone)} /> {segment.label}{" "}
              <span className="mono">{segment.count}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
