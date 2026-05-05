# NpmGuard Frontend — Architecture

## Overview

Real-time audit visualization that streams engine events via SSE. The user watches the audit unfold: files being scanned, hypotheses emitted, investigation steps executing, experiments confirming behavior.

## SSE Event Vocabulary

| Event | Source | Payload |
|---|---|---|
| `audit_started` | pipeline start | `packageName` |
| `phase_started/completed` | `timedPhase` wrapper | `phase`, `durationMs` |
| `file_list` | after inventory | `files: FileRecord[]` |
| `inventory_meta` | after inventory | `scripts`, `dependencies`, `entryPoints`, `metadata` |
| `intent_extracted` | after intent phase | `statedPurpose`, `expectedCapabilities` |
| `file_analyzing` | triage MAP (before LLM) | `file` |
| `file_verdict` | legacy adapter (from hypotheses) | `verdict: FileVerdict` |
| `triage_progress` | triage MAP (per-file done) | `current`, `total`, `file` |
| `triage_complete` | after triage | `riskScore`, `riskSummary`, `focusAreas` |
| `hypothesis_emitted` | triage per-hypothesis | `hypId`, `claim`, `severity`, `file` |
| `graph_built` | after graph construction | `nodeCount`, `addedCount`, `mergedCount` |
| `agent_tool_call` | investigation agent step | `tool`, `args`, `step` |
| `agent_tool_result` | investigation agent step | `tool`, `resultPreview`, `step` |
| `agent_reasoning` | investigation agent step | `text`, `step` |
| `finding_discovered` | after investigation | `finding: Finding` |
| `experiment_confirmed` | experimenter worker | `hypId`, `reason` |
| `graph_verdict` | after all correlation | `verdict`, `rationale`, `counts`, `confirmedHypIds` |
| `verdict_reached` | pipeline end | `verdict`, `capabilities`, `proofCount` |
| `audit_error` | catch block | `error` |

## State Management

Single Zustand store (`auditStore.ts`) with `handleEvent(event)` switch that accumulates SSE events into typed state slices. The frontend currently handles a subset of these events — hypothesis/graph events are emitted but not yet rendered (see "What's next" in ARCHITECT_REVIEW_ENGINE.md).

## Data Flow

```
Engine Pipeline
  ├─ emit("phase_started")       ──► EventEmitter ──► eventBuffer[]
  ├─ emit("hypothesis_emitted")  ──► EventEmitter ──► SSE stream
  ├─ emit("experiment_confirmed")──► EventEmitter ──► SSE stream
  └─ emit("graph_verdict")       ──► EventEmitter ──► SSE stream
                                                          │
Browser                                                   ▼
  EventSource(/audit/:id/events)
      │  (replays buffer first, then live)
      ▼
  Zustand handleEvent() → state update → React re-render
      │
      ├─ FileTree: reads fileStatuses → color dots
      ├─ CodeViewer: reads fileVerdicts → line highlights
      ├─ ActivityFeed: reads agentSteps/findings → event cards
      ├─ PhaseProgress: reads phases → progress bar
      └─ VerdictBanner: reads verdict → animated banner
```

## Tech Stack

React + Vite + Tailwind (dark terminal aesthetic) + CodeMirror 6 + Zustand. Frontend is built to `frontend/dist/` and served statically by the engine.

## API Endpoints

- `POST /audit/stream` — starts audit, returns `{ auditId }`
- `GET /audit/:id/events` — SSE stream (replays buffered, then live)
- `GET /audit/:id/file/*` — raw file content from resolved package
- `GET /audit/:id/report` — final report JSON (202 while running)
