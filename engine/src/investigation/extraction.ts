import type { Finding, InvestigationOutput } from "../models.js";

interface ParsedFindingSection {
  title: string;
  fields: Map<string, string[]>;
}

const FIELD_ALIASES: Record<string, string> = {
  capability: "capability",
  confidence: "confidence",
  evidence: "evidence",
  file: "file",
  lines: "lines",
  line: "lines",
  offsets: "lines",
  offset: "lines",
  reproduction: "reproduction",
  "reproduction strategy": "reproduction",
  problem: "problem",
};

function cleanMarkdownCell(value: string): string {
  return value
    .trim()
    .replace(/^\*\*(.*?)\*\*$/u, "$1")
    .replace(/\\\|/gu, "|")
    .trim();
}

function splitMarkdownTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;

  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  for (const char of trimmed.slice(1, -1)) {
    if (escaped) {
      cell += char === "|" ? "|" : `\\${char}`;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "|") {
      cells.push(cell);
      cell = "";
      continue;
    }
    cell += char;
  }
  if (escaped) cell += "\\";
  cells.push(cell);
  return cells.map(cleanMarkdownCell);
}

function parseFindingSections(agentText: string): ParsedFindingSection[] {
  const headings = [...agentText.matchAll(/^###\s+Finding\s+\d+\s*:\s*(.+?)\s*$/gimu)];
  return headings.map((heading, index) => {
    const start = (heading.index ?? 0) + heading[0].length;
    const end = headings[index + 1]?.index ?? agentText.length;
    const fields = new Map<string, string[]>();
    let currentField: string | null = null;

    for (const line of agentText.slice(start, end).split("\n")) {
      const cells = splitMarkdownTableRow(line);
      if (!cells || cells.length < 2) continue;

      const rawLabel = (cells[0] ?? "")
        .replace(/\*\*/gu, "")
        .replace(/`/gu, "")
        .trim()
        .toLowerCase();
      const label = FIELD_ALIASES[rawLabel];
      const value = cells.slice(1).join(" | ").trim();

      if (label) {
        currentField = label;
        if (value && !/^[-:]+$/u.test(value)) {
          fields.set(label, [value]);
        } else if (!fields.has(label)) {
          fields.set(label, []);
        }
      } else if (!rawLabel && currentField && value) {
        const values = fields.get(currentField) ?? [];
        values.push(value);
        fields.set(currentField, values);
      }
    }

    return {
      title: cleanMarkdownCell(heading[1] ?? ""),
      fields,
    };
  });
}

function firstField(section: ParsedFindingSection, field: string): string {
  return section.fields.get(field)?.join("\n").trim() ?? "";
}

function parseConfidence(value: string): Finding["confidence"] | null {
  const normalized = value.toUpperCase();
  if (normalized.includes("CONFIRMED")) return "CONFIRMED";
  if (normalized.includes("LIKELY")) return "LIKELY";
  if (normalized.includes("SUSPECTED")) return "SUSPECTED";
  return null;
}

function parsedFileLine(section: ParsedFindingSection): string {
  const file = firstField(section, "file").replace(/^`|`$/gu, "");
  const lines = firstField(section, "lines")
    .replace(/^~?offsets?=/iu, "")
    .replace(/^`|`$/gu, "")
    .replace(/[–—]/gu, "-");
  if (file && lines) return `${file}:${lines}`;
  return file || lines;
}

function sectionToFinding(section: ParsedFindingSection): Finding {
  return {
    capability: firstField(section, "capability") || "UNKNOWN",
    confidence: parseConfidence(firstField(section, "confidence")) ?? "SUSPECTED",
    fileLine: parsedFileLine(section),
    problem: firstField(section, "problem") || section.title,
    evidence: firstField(section, "evidence"),
    reproductionStrategy: firstField(section, "reproduction"),
  };
}

function extractSummary(agentText: string): string {
  const heading = agentText.match(/^##\s+Summary\s*$/imu);
  if (heading?.index === undefined) return "";

  const start = heading.index + heading[0].length;
  const remainder = agentText.slice(start);
  const nextHeading = remainder.search(/^##\s+/imu);
  return remainder.slice(0, nextHeading === -1 ? undefined : nextHeading).trim();
}

/**
 * Recover only values explicitly present in the agent's grounded Markdown
 * response when an OpenAI-compatible structured-output provider omits fields
 * that are optional in the shared wire schema.
 */
export function repairInvestigationExtraction(
  extraction: InvestigationOutput | null,
  agentText: string,
): InvestigationOutput {
  const sections = parseFindingSections(agentText);
  const extractedFindings = extraction?.findings ?? [];
  const count = Math.max(extractedFindings.length, sections.length);
  const findings: Finding[] = [];

  for (let index = 0; index < count; index++) {
    const extracted = extractedFindings[index];
    const section = sections[index];
    const recovered = section ? sectionToFinding(section) : null;
    const recoveredConfidence = section
      ? parseConfidence(firstField(section, "confidence"))
      : null;

    if (!extracted && recovered) {
      findings.push(recovered);
      continue;
    }
    if (!extracted) continue;

    findings.push({
      ...extracted,
      capability: extracted.capability.trim() || recovered?.capability || "UNKNOWN",
      confidence: recoveredConfidence ?? extracted.confidence,
      fileLine: extracted.fileLine.trim() || recovered?.fileLine || "",
      problem: recovered?.problem || extracted.problem.trim(),
      evidence: recovered?.evidence || extracted.evidence.trim(),
      reproductionStrategy:
        extracted.reproductionStrategy.trim() || recovered?.reproductionStrategy || "",
    });
  }

  return {
    findings,
    summary: extraction?.summary.trim() || extractSummary(agentText),
  };
}
