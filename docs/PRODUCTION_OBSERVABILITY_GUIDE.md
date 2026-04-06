# Production-Ready Observability & Logging: The Complete Guide

> A distilled guide for developers who can `console.log` but want to instrument their Node.js services at the level of SigNoz, Langfuse, and the OpenTelemetry demo app. Built by studying 18 production codebases and the official OpenTelemetry, Pino, and GenAI semantic conventions — then applied to a real multi-phase audit pipeline with LLM calls, Docker sandboxes, ENS writes, and IPFS uploads.

---

## Table of Contents

1. [Mindset Shift](#1-mindset-shift)
2. [Architecture Overview](#2-architecture-overview)
3. [Pino: Structured Logging Foundation](#3-pino-structured-logging-foundation)
4. [OpenTelemetry SDK Bootstrap](#4-opentelemetry-sdk-bootstrap)
5. [Trace-Log Correlation](#5-trace-log-correlation)
6. [Distributed Tracing Across the Audit Pipeline](#6-distributed-tracing-across-the-audit-pipeline)
7. [LLM Call Observability](#7-llm-call-observability)
8. [Docker Sandbox Tracing](#8-docker-sandbox-tracing)
9. [External Service Instrumentation (ENS, IPFS, Stripe)](#9-external-service-instrumentation-ens-ipfs-stripe)
10. [Metrics: Histograms, Counters, and Gauges](#10-metrics-histograms-counters-and-gauges)
11. [Health Checks Beyond /health](#11-health-checks-beyond-health)
12. [Log Levels Strategy](#12-log-levels-strategy)
13. [What to Log at Each Audit Phase](#13-what-to-log-at-each-audit-phase)
14. [Alerting Thresholds](#14-alerting-thresholds)
15. [Sensitive Data Redaction](#15-sensitive-data-redaction)
16. [Cost-Effective Observability](#16-cost-effective-observability)
17. [Anti-Patterns](#17-anti-patterns)
18. [Projects Studied](#18-projects-studied)

---

## 1. Mindset Shift

| Amateur | Production |
| --- | --- |
| `console.log("audit started")` scattered everywhere | Pino structured JSON with child loggers per audit, automatic `auditId` and `traceId` on every line |
| No tracing — debug by reading Docker logs | OpenTelemetry spans across every phase: resolve → triage → investigation → test-gen → verify |
| `GET /health` returns `{ status: "ok" }` | Liveness, readiness, and startup probes. Readiness checks Docker daemon, LLM API reachability, and ENS RPC |
| "The LLM is slow" — no data | Histograms on `gen_ai.client.operation.duration` with p50/p95/p99 per model, per phase |
| Docker sandbox OOMs silently | Exit code 137 detection, memory trajectory alerts, span events recording the kill |
| "Something failed in ENS" — grep the terminal | Spans on every contract call with `ens.name`, `ens.resolver`, gas used, revert reason |
| Logs lost when the container restarts | Pino worker-thread transports to OTLP collector — logs survive process death |
| "We'll add monitoring later" | Observability is wired at bootstrap; every new phase auto-inherits tracing context |
| No idea which audit is which in logs | Correlation IDs: `auditId` flows from HTTP request through every log line, span, and Docker exec |
| Alert on every error | Alert on error *rate* changes and latency percentile shifts — not individual failures |

The production observability mindset: **instrument at boundaries, correlate across phases, alert on trends not events, and never log what you can't query.**

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  Application Layer                                                  │
│                                                                     │
│  ┌──────────┐   ┌──────────┐   ┌───────────┐   ┌───────────────┐  │
│  │  Hono    │   │ Pipeline │   │  Sandbox  │   │  ENS/IPFS     │  │
│  │  HTTP    │──▶│  Phases  │──▶│  Docker   │──▶│  Publisher    │  │
│  │  Server  │   │          │   │  Exec     │   │               │  │
│  └────┬─────┘   └────┬─────┘   └─────┬─────┘   └───────┬───────┘  │
│       │              │               │                  │          │
│  ┌────▼──────────────▼───────────────▼──────────────────▼───────┐  │
│  │                    Pino Logger (child per audit)              │  │
│  │  + OpenTelemetry Context (traceId, spanId auto-injected)     │  │
│  └──────────────────────────┬───────────────────────────────────┘  │
│                             │                                      │
│  ┌──────────────────────────▼───────────────────────────────────┐  │
│  │              OpenTelemetry SDK (NodeSDK)                      │  │
│  │  TracerProvider │ MeterProvider │ LoggerProvider              │  │
│  └──────────────────────────┬───────────────────────────────────┘  │
│                             │  OTLP (gRPC or HTTP/proto)           │
└─────────────────────────────┼───────────────────────────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │  OTel Collector   │
                    │  (process, route, │
                    │   sample, export) │
                    └────┬────┬────┬────┘
                         │    │    │
              ┌──────────┘    │    └──────────┐
              ▼               ▼               ▼
        ┌──────────┐   ┌──────────┐   ┌──────────┐
        │  Traces  │   │  Metrics │   │   Logs   │
        │  Tempo / │   │  Prom /  │   │  Loki /  │
        │  Jaeger  │   │  Mimir   │   │  Elastic │
        └──────────┘   └──────────┘   └──────────┘
              │               │               │
              └───────────────┼───────────────┘
                              ▼
                    ┌──────────────────┐
                    │    Grafana       │
                    │  (dashboards +   │
                    │   alerting)      │
                    └──────────────────┘
```

**Three pillars, one protocol.** Everything exports via OTLP to a Collector. The Collector handles sampling, batching, and routing. Backend choice (Grafana stack, SigNoz, Datadog) is a deployment decision, not a code decision.

---

## 3. Pino: Structured Logging Foundation

### Why Pino

Pino v10 processes ~380,000 log operations per second using worker-thread transports. It never blocks the event loop. Every log line is JSON, queryable, and pipeline-ready.

### Base Logger Configuration

```typescript
// src/observability/logger.ts
import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",

  // Output string levels ("info") instead of numeric (30)
  formatters: {
    level(label) {
      return { level: label };
    },
    bindings(bindings) {
      return {
        service: "npmguard-engine",
        version: process.env.npm_package_version || "unknown",
        // Drop default pid/hostname — OTel resource attributes handle identity
      };
    },
  },

  // ISO 8601 timestamps for cross-service correlation
  timestamp: pino.stdTimeFunctions.isoTime,

  // Strip default bindings (pid, hostname) — OTel handles process identity
  base: null,

  // Redact sensitive fields before they hit any transport
  redact: {
    paths: [
      "password",
      "*.password",
      "apiKey",
      "*.apiKey",
      "authorization",
      "*.authorization",
      "*.cookie",
      "*.token",
      "stripeSecretKey",
      "stripeWebhookSecret",
      "*.ANTHROPIC_API_KEY",
      "*.NPMGUARD_LLM_API_KEY",
      "privateKey",
      "*.privateKey",
    ],
    censor: "[REDACTED]",
  },

  // Transport configuration — worker threads handle I/O off the event loop
  transport: {
    targets: [
      // Primary: send logs to OTel Collector as OTLP LogRecords
      {
        target: "pino-opentelemetry-transport",
        level: "info",
        options: {
          resourceAttributes: {
            "service.name": "npmguard-engine",
            "deployment.environment": process.env.NODE_ENV || "development",
          },
        },
      },
      // Fallback: error log file (survives collector outages)
      {
        target: "pino/file",
        level: "error",
        options: { destination: "./logs/error.log", mkdir: true },
      },
      // Dev only: pretty-printed console output
      ...(process.env.NODE_ENV !== "production"
        ? [{ target: "pino-pretty", level: "debug", options: { colorize: true } }]
        : []),
    ],
  },
});
```

### Child Loggers for Audit Context

Every audit run gets a child logger. All logs within that audit automatically carry the `auditId` and `packageName` — no manual field repetition.

```typescript
// src/pipeline.ts
import { logger as rootLogger } from "./observability/logger.js";

export async function runAudit(packageName: string, emit?: EmitFn, auditId?: string) {
  const id = auditId || crypto.randomUUID();

  // Child logger — every log call inherits these fields
  const log = rootLogger.child({
    auditId: id,
    packageName,
    component: "pipeline",
  });

  log.info("audit started");

  // Phase-specific child adds phase context
  const triageLog = log.child({ phase: "triage" });
  triageLog.info({ fileCount: files.length }, "starting triage");

  // Pass the child logger downstream — never the root
  const triageResult = await runTriage(resolved, inventory, triageLog);

  triageLog.info(
    { riskScore: triageResult.riskScore, verdict: triageResult.riskScore < threshold ? "SAFE" : "INVESTIGATE" },
    "triage complete"
  );
}
```

**Output:**
```json
{
  "level": "info",
  "time": "2026-04-06T14:23:01.456Z",
  "service": "npmguard-engine",
  "auditId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "packageName": "suspicious-pkg@1.2.3",
  "component": "pipeline",
  "phase": "triage",
  "fileCount": 12,
  "msg": "starting triage"
}
```

### HTTP Request Logging with pino-http

```typescript
// src/observability/http-logger.ts
import pinoHttp from "pino-http";
import { logger } from "./logger.js";

export const httpLogger = pinoHttp({
  logger,

  // Generate a request ID if none provided
  genReqId: (req) => req.headers["x-request-id"] || crypto.randomUUID(),

  // Customize what gets logged per request
  customProps(req) {
    return {
      userAgent: req.headers["user-agent"],
    };
  },

  // Skip health check noise
  autoLogging: {
    ignore(req) {
      return req.url === "/health" || req.url === "/healthz" || req.url === "/readyz";
    },
  },

  // Log level based on status code
  customLogLevel(req, res, err) {
    if (err || (res.statusCode && res.statusCode >= 500)) return "error";
    if (res.statusCode && res.statusCode >= 400) return "warn";
    return "info";
  },

  // Redact request/response details
  serializers: {
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
});
```

```typescript
// src/index.ts — integrate with Hono
import { Hono } from "hono";
import { httpLogger } from "./observability/http-logger.js";

const app = new Hono();

// Attach pino-http as middleware
app.use("*", async (c, next) => {
  httpLogger(c.req.raw, c.res);
  await next();
});
```

---

## 4. OpenTelemetry SDK Bootstrap

### Critical Rule: Load OTel Before Everything

The OpenTelemetry SDK must initialize **before** any application code imports. This allows auto-instrumentation to monkey-patch `http`, `net`, `dns`, and other core modules.

```typescript
// src/observability/otel.ts
// This file must be loaded FIRST via: node --import ./src/observability/otel.js src/index.js
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from "@opentelemetry/semantic-conventions";

const collectorUrl = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318";

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "npmguard-engine",
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version || "0.0.0",
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: process.env.NODE_ENV || "development",
  }),

  // Traces → Collector via OTLP/proto
  traceExporter: new OTLPTraceExporter({
    url: `${collectorUrl}/v1/traces`,
  }),

  // Metrics → Collector via OTLP/proto (60s flush interval)
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: `${collectorUrl}/v1/metrics`,
    }),
    exportIntervalMillis: 60_000,
  }),

  // Auto-instrument HTTP, DNS, net, fs, and more
  instrumentations: [
    getNodeAutoInstrumentations({
      // Disable noisy fs instrumentation — we only care about network and HTTP
      "@opentelemetry/instrumentation-fs": { enabled: false },
      // Enable Pino trace injection
      "@opentelemetry/instrumentation-pino": { enabled: true },
    }),
  ],
});

sdk.start();

// Graceful shutdown — flush pending spans/metrics before exit
const shutdown = async () => {
  await sdk.shutdown();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

### Start Script

```json
{
  "scripts": {
    "start": "node --import ./dist/observability/otel.js ./dist/index.js",
    "dev": "tsx --import ./src/observability/otel.ts ./src/index.ts"
  }
}
```

### Required Packages

```bash
npm install pino pino-http pino-opentelemetry-transport \
  @opentelemetry/sdk-node \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/exporter-trace-otlp-proto \
  @opentelemetry/exporter-metrics-otlp-proto \
  @opentelemetry/sdk-metrics \
  @opentelemetry/resources \
  @opentelemetry/semantic-conventions \
  @opentelemetry/api
```

---

## 5. Trace-Log Correlation

### How It Works

When `@opentelemetry/instrumentation-pino` is enabled (via auto-instrumentations), it automatically injects `trace_id`, `span_id`, and `trace_flags` into every Pino log line emitted within an active span.

**Before correlation:**
```json
{ "level": "info", "msg": "triage complete", "auditId": "abc-123" }
```

**After correlation:**
```json
{
  "level": "info",
  "msg": "triage complete",
  "auditId": "abc-123",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id": "00f067aa0ba902b7",
  "trace_flags": "01"
}
```

Now you can click a trace in Grafana/Jaeger and see every log line from that audit. Click a log line and jump to the exact span.

### Manual Trace Context (When Outside Auto-Instrumented Spans)

```typescript
import { trace, context } from "@opentelemetry/api";

function getTraceContext(): { traceId?: string; spanId?: string } {
  const span = trace.getActiveSpan();
  if (!span) return {};
  const ctx = span.spanContext();
  return { traceId: ctx.traceId, spanId: ctx.spanId };
}

// Use in logs where auto-injection doesn't reach
log.info({ ...getTraceContext(), custom: "data" }, "manual trace context");
```

---

## 6. Distributed Tracing Across the Audit Pipeline

### Root Span Per Audit

The entire audit gets one root span. Each phase is a child span. Sub-operations (individual LLM calls, Docker exec commands, ENS writes) are grandchild spans.

```typescript
// src/observability/tracing.ts
import { trace, SpanStatusCode, type Span } from "@opentelemetry/api";

const tracer = trace.getTracer("npmguard-engine", "1.0.0");

/**
 * Wrap an audit phase in a span. Automatically records duration,
 * errors, and status. The callback receives the span for adding
 * custom attributes and events.
 */
export async function tracePhase<T>(
  phaseName: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  return tracer.startActiveSpan(`audit.${phaseName}`, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}
```

### Pipeline Instrumented

```typescript
// src/pipeline.ts
import { tracePhase } from "./observability/tracing.js";

export async function runAudit(packageName: string, emit?: EmitFn, auditId?: string) {
  const id = auditId || crypto.randomUUID();

  return tracePhase("pipeline", { "audit.id": id, "audit.package": packageName }, async (rootSpan) => {

    // Phase 0a: Resolve
    const resolved = await tracePhase("resolve", { "audit.id": id }, async (span) => {
      const result = await resolvePackage(packageName);
      span.setAttribute("audit.resolve.source", result.isTestFixture ? "fixture" : "npm");
      span.setAttribute("audit.resolve.path", result.path);
      return result;
    });

    // Phase 0b: Inventory
    const inventory = await tracePhase("inventory", { "audit.id": id }, async (span) => {
      const result = await analyzeInventory(resolved.path);
      span.setAttribute("audit.inventory.file_count", result.files.length);
      span.setAttribute("audit.inventory.has_lifecycle_scripts", result.flags.some(f => f.type === "lifecycle"));
      span.setAttribute("audit.inventory.dealbreaker_count", result.dealbreakers.length);
      return result;
    });

    // Phase 1a: Triage
    const triage = await tracePhase("triage", { "audit.id": id }, async (span) => {
      const result = await runTriage(resolved, inventory, log);
      span.setAttribute("audit.triage.risk_score", result.riskScore);
      span.setAttribute("audit.triage.file_count", result.fileVerdicts.length);
      span.setAttribute("audit.triage.focus_areas", result.focusAreas.length);

      // Add event for early exit
      if (result.riskScore < config.triage.riskThreshold) {
        span.addEvent("early_exit_safe", { "audit.triage.threshold": config.triage.riskThreshold });
      }
      return result;
    });

    if (triage.riskScore < config.triage.riskThreshold) {
      rootSpan.setAttribute("audit.verdict", "SAFE");
      rootSpan.setAttribute("audit.early_exit", true);
      return buildSafeReport(triage);
    }

    // Phase 1b: Investigation
    const investigation = await tracePhase("investigation", { "audit.id": id }, async (span) => {
      const result = await runInvestigation(resolved, inventory, triage, log);
      span.setAttribute("audit.investigation.findings_count", result.findings.length);
      span.setAttribute("audit.investigation.tool_calls", result.toolCallCount);
      span.setAttribute("audit.investigation.turns", result.turns);
      return result;
    });

    // Phase 1c: Test Generation
    const tests = await tracePhase("test_gen", { "audit.id": id }, async (span) => {
      const result = await generateTests(investigation, resolved, log);
      span.setAttribute("audit.test_gen.tests_generated", result.length);
      return result;
    });

    // Phase 2: Verification
    const proofs = await tracePhase("verify", { "audit.id": id }, async (span) => {
      const result = await verifyTests(tests, resolved, log);
      const confirmed = result.filter(p => p.kind === "TEST_CONFIRMED").length;
      span.setAttribute("audit.verify.proofs_total", result.length);
      span.setAttribute("audit.verify.proofs_confirmed", confirmed);
      return result;
    });

    const verdict = proofs.some(p => p.kind === "TEST_CONFIRMED") ? "DANGEROUS" : "SAFE";
    rootSpan.setAttribute("audit.verdict", verdict);
    rootSpan.setAttribute("audit.early_exit", false);

    return buildReport(triage, investigation, tests, proofs, verdict);
  });
}
```

### Trace Visualization

A single audit trace looks like this in Jaeger/Grafana Tempo:

```
audit.pipeline (root)                                    ├─ 45.2s ─┤
  ├── audit.resolve                                      ├ 2.1s ┤
  ├── audit.inventory                                    ├ 0.3s ┤
  ├── audit.triage                                       ├── 8.7s ──┤
  │     ├── gen_ai.chat (claude-3-haiku — file 1/12)     ├ 0.8s ┤
  │     ├── gen_ai.chat (claude-3-haiku — file 2/12)     ├ 0.9s ┤
  │     ├── ...                                          ...
  │     └── gen_ai.chat (claude-3-haiku — synthesis)     ├ 1.2s ┤
  ├── audit.investigation                                ├──── 18.4s ────┤
  │     ├── docker.start                                 ├ 1.8s ┤
  │     ├── gen_ai.chat (claude-3.5-sonnet — turn 1)     ├ 2.3s ┤
  │     ├── docker.exec (readFile)                       ├ 0.1s ┤
  │     ├── gen_ai.chat (claude-3.5-sonnet — turn 2)     ├ 1.9s ┤
  │     ├── docker.exec (evalJs)                         ├ 0.4s ┤
  │     └── ...                                          ...
  ├── audit.test_gen                                     ├── 6.2s ──┤
  │     ├── gen_ai.chat (test generation)                ├ 3.1s ┤
  │     └── gen_ai.chat (test validation retry)          ├ 2.8s ┤
  └── audit.verify                                       ├── 9.5s ──┤
        ├── docker.start                                 ├ 1.6s ┤
        ├── docker.exec (vitest run)                     ├ 5.2s ┤
        └── docker.exec (vitest run — retry)             ├ 2.7s ┤
```

---

## 7. LLM Call Observability

### GenAI Semantic Conventions

OpenTelemetry has standardized [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/) for LLM observability. Use these — don't invent custom attribute names.

### Instrumented LLM Wrapper

```typescript
// src/observability/llm-tracing.ts
import { trace, SpanStatusCode, type Span } from "@opentelemetry/api";
import { metrics } from "@opentelemetry/api";

const tracer = trace.getTracer("npmguard-engine.llm");
const meter = metrics.getMeter("npmguard-engine.llm");

// GenAI metrics per the semantic conventions
const llmDuration = meter.createHistogram("gen_ai.client.operation.duration", {
  unit: "s",
  description: "Duration of generative AI client operations",
});

const llmTokenUsage = meter.createHistogram("gen_ai.client.token.usage", {
  unit: "{token}",
  description: "Token usage per LLM call",
});

const llmErrors = meter.createCounter("gen_ai.client.errors.total", {
  description: "Total LLM API errors",
});

interface LLMCallOptions {
  provider: "anthropic" | "openai_compatible";
  model: string;
  phase: string;
  auditId: string;
}

/**
 * Wrap any LLM call (generateText, streamText, etc.) with full
 * GenAI semantic convention tracing and metrics.
 */
export async function traceLLMCall<T>(
  options: LLMCallOptions,
  fn: (span: Span) => Promise<T & { usage?: { promptTokens: number; completionTokens: number } }>
): Promise<T> {
  const startTime = performance.now();

  return tracer.startActiveSpan(
    "gen_ai.chat",
    {
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.system": options.provider === "anthropic" ? "anthropic" : "openai",
        "gen_ai.request.model": options.model,
        "audit.id": options.auditId,
        "audit.phase": options.phase,
      },
    },
    async (span) => {
      try {
        const result = await fn(span);
        const durationSec = (performance.now() - startTime) / 1000;

        // Record response model (may differ from request model)
        span.setAttribute("gen_ai.response.model", options.model);

        // Token usage
        if (result.usage) {
          span.setAttribute("gen_ai.usage.input_tokens", result.usage.promptTokens);
          span.setAttribute("gen_ai.usage.output_tokens", result.usage.completionTokens);

          llmTokenUsage.record(result.usage.promptTokens, {
            "gen_ai.token.type": "input",
            "gen_ai.request.model": options.model,
            "audit.phase": options.phase,
          });
          llmTokenUsage.record(result.usage.completionTokens, {
            "gen_ai.token.type": "output",
            "gen_ai.request.model": options.model,
            "audit.phase": options.phase,
          });
        }

        // Duration metric
        llmDuration.record(durationSec, {
          "gen_ai.request.model": options.model,
          "gen_ai.operation.name": "chat",
          "audit.phase": options.phase,
        });

        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        const durationSec = (performance.now() - startTime) / 1000;

        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });

        llmErrors.add(1, {
          "gen_ai.request.model": options.model,
          "error.type": (err as Error).name,
          "audit.phase": options.phase,
        });
        llmDuration.record(durationSec, {
          "gen_ai.request.model": options.model,
          "gen_ai.operation.name": "chat",
          "audit.phase": options.phase,
          error: true,
        });

        throw err;
      } finally {
        span.end();
      }
    }
  );
}
```

### Usage in Triage

```typescript
// src/phases/triage.ts
import { traceLLMCall } from "../observability/llm-tracing.js";

async function analyzeFile(file: FileRecord, auditId: string, log: pino.Logger) {
  return traceLLMCall(
    {
      provider: config.llm.backend,
      model: config.triage.model,
      phase: "triage",
      auditId,
    },
    async (span) => {
      span.setAttribute("audit.triage.file", file.path);
      span.setAttribute("audit.triage.file_size", file.size);

      const result = await generateText({
        model: getModel(config.triage.model),
        system: TRIAGE_SYSTEM_PROMPT,
        prompt: `Analyze this file:\n\n${file.content}`,
      });

      span.addEvent("triage_verdict", {
        "audit.triage.capabilities": JSON.stringify(result.capabilities),
        "audit.triage.suspicious": result.suspicious,
      });

      return result;
    }
  );
}
```

### What LLM Metrics Tell You

| Metric | Alert Condition | What It Means |
| --- | --- | --- |
| `gen_ai.client.operation.duration` p99 > 15s | LLM provider degraded | Back off, switch models, or increase timeout |
| `gen_ai.client.token.usage` input spike | Prompt injection or unexpectedly large files | Check file size limits in triage |
| `gen_ai.client.errors.total` rate > 5/min | API key issues, quota exceeded, model unavailable | Check provider status, rotate keys |
| Token cost per audit trending up | Model or prompt changes increasing cost | Review prompts, check for redundant calls |

---

## 8. Docker Sandbox Tracing

### The Challenge

Docker exec runs in a **separate process** with no shared memory. OpenTelemetry context does not propagate automatically across `docker exec` boundaries. You must serialize the trace context and pass it explicitly.

### Instrumented Sandbox Controller

```typescript
// src/sandbox/controller.ts
import { trace, context, propagation, SpanStatusCode } from "@opentelemetry/api";
import { logger } from "../observability/logger.js";

const tracer = trace.getTracer("npmguard-engine.sandbox");

interface SandboxMetrics {
  containerId: string;
  memoryLimitMb: number;
  cpuLimit: number;
  networkMode: string;
}

export class SandboxController {
  private containerId: string | null = null;
  private log: pino.Logger;

  constructor(private auditId: string, private packagePath: string) {
    this.log = logger.child({ auditId, component: "sandbox" });
  }

  async start(): Promise<void> {
    return tracer.startActiveSpan(
      "docker.start",
      { attributes: { "audit.id": this.auditId } },
      async (span) => {
        const startTime = performance.now();
        try {
          const { stdout } = await dockerExec([
            "run", "-d",
            "--network=none",
            "--cap-drop=ALL",
            `--memory=${config.sandbox.memoryMb}m`,
            `--cpus=${config.sandbox.cpus}`,
            "--read-only",
            "--user=1000:1000",
            "--tmpfs=/tmp:noexec,nosuid,size=64m",
            "--pids-limit=64",
            `-v=${this.packagePath}:/pkg:ro`,
            config.sandbox.image,
            "sleep", "infinity",
          ]);

          this.containerId = stdout.trim();
          const durationMs = performance.now() - startTime;

          span.setAttribute("docker.container_id", this.containerId.slice(0, 12));
          span.setAttribute("docker.image", config.sandbox.image);
          span.setAttribute("docker.memory_limit_mb", config.sandbox.memoryMb);
          span.setAttribute("docker.cpu_limit", config.sandbox.cpus);
          span.setAttribute("docker.network_mode", "none");
          span.setAttribute("docker.start_duration_ms", durationMs);

          this.log.info(
            { containerId: this.containerId.slice(0, 12), durationMs: Math.round(durationMs) },
            "sandbox container started"
          );

          span.setStatus({ code: SpanStatusCode.OK });
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          this.log.error({ err }, "failed to start sandbox container");
          throw err;
        } finally {
          span.end();
        }
      }
    );
  }

  async exec(command: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return tracer.startActiveSpan(
      "docker.exec",
      {
        attributes: {
          "audit.id": this.auditId,
          "docker.container_id": this.containerId?.slice(0, 12) || "unknown",
          "docker.exec.command": command[0],
          "docker.exec.timeout_ms": timeoutMs,
        },
      },
      async (span) => {
        const startTime = performance.now();

        try {
          const result = await dockerExec(
            ["exec", this.containerId!, ...command],
            timeoutMs
          );
          const durationMs = performance.now() - startTime;

          span.setAttribute("docker.exec.exit_code", result.exitCode);
          span.setAttribute("docker.exec.stdout_bytes", result.stdout.length);
          span.setAttribute("docker.exec.stderr_bytes", result.stderr.length);
          span.setAttribute("docker.exec.duration_ms", durationMs);

          // OOM detection: exit code 137 = SIGKILL (likely OOM)
          if (result.exitCode === 137) {
            span.addEvent("oom_killed", {
              "docker.exec.command": command.join(" "),
              "docker.memory_limit_mb": config.sandbox.memoryMb,
            });
            span.setStatus({ code: SpanStatusCode.ERROR, message: "Container OOM killed (exit 137)" });

            this.log.error(
              { exitCode: 137, command: command[0], memoryLimitMb: config.sandbox.memoryMb },
              "sandbox OOM killed"
            );
          } else if (result.exitCode !== 0) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: `Exit code ${result.exitCode}` });
          } else {
            span.setStatus({ code: SpanStatusCode.OK });
          }

          return result;
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });

          // Timeout detection
          if ((err as Error).message.includes("timeout")) {
            span.addEvent("exec_timeout", { "docker.exec.timeout_ms": timeoutMs });
            this.log.warn({ command: command[0], timeoutMs }, "sandbox exec timed out");
          }

          throw err;
        } finally {
          span.end();
        }
      }
    );
  }

  async stop(): Promise<void> {
    if (!this.containerId) return;

    return tracer.startActiveSpan("docker.stop", async (span) => {
      try {
        await dockerExec(["rm", "-f", this.containerId!]);
        span.setAttribute("docker.container_id", this.containerId!.slice(0, 12));
        this.log.info({ containerId: this.containerId!.slice(0, 12) }, "sandbox container stopped");
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (err) {
        span.recordException(err as Error);
        this.log.error({ err }, "failed to stop sandbox container");
      } finally {
        span.end();
        this.containerId = null;
      }
    });
  }
}
```

### Context Propagation Across Docker Exec

When you need trace continuity inside the container (e.g., if the sandbox runs its own OTel-instrumented code):

```typescript
// Serialize trace context into environment variables
function getTraceEnvVars(): string[] {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return Object.entries(carrier).map(([k, v]) => `-e=${k}=${v}`);
}

// Pass to docker exec
const traceEnv = getTraceEnvVars();
await dockerExec(["exec", ...traceEnv, containerId, "node", "/pkg/test.js"]);

// Inside the container, extract:
// propagation.extract(ROOT_CONTEXT, { traceparent: process.env.traceparent })
```

---

## 9. External Service Instrumentation (ENS, IPFS, Stripe)

### Auto-Instrumented HTTP Calls

OpenTelemetry auto-instrumentation captures all outbound HTTP calls. ENS RPC calls (via `viem`), Pinata API calls, and Stripe API calls all generate spans automatically.

### Enriching External Service Spans

Auto-instrumented HTTP spans have generic names like `POST https://api.pinata.cloud`. Add semantic context:

```typescript
// src/observability/external-services.ts
import { trace, SpanStatusCode } from "@opentelemetry/api";

const tracer = trace.getTracer("npmguard-engine.external");

/**
 * Wrap ENS write operations with domain-specific context.
 */
export async function traceENSWrite<T>(
  operation: string,
  ensName: string,
  fn: () => Promise<T>
): Promise<T> {
  return tracer.startActiveSpan(
    `ens.${operation}`,
    {
      attributes: {
        "ens.name": ensName,
        "ens.operation": operation,
        "ens.chain": "sepolia",
      },
    },
    async (span) => {
      try {
        const result = await fn();

        if (typeof result === "object" && result !== null && "hash" in result) {
          span.setAttribute("ens.tx_hash", (result as { hash: string }).hash);
        }

        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });

        // Classify ENS errors
        const message = (err as Error).message;
        if (message.includes("revert")) {
          span.setAttribute("ens.error_type", "revert");
        } else if (message.includes("insufficient funds")) {
          span.setAttribute("ens.error_type", "insufficient_funds");
        } else if (message.includes("nonce")) {
          span.setAttribute("ens.error_type", "nonce_conflict");
        }

        throw err;
      } finally {
        span.end();
      }
    }
  );
}

/**
 * Wrap IPFS/Pinata operations.
 */
export async function traceIPFSUpload<T>(
  fileType: "report" | "source",
  fn: () => Promise<T & { IpfsHash?: string; cid?: string }>
): Promise<T> {
  return tracer.startActiveSpan(
    "ipfs.upload",
    {
      attributes: {
        "ipfs.provider": "pinata",
        "ipfs.file_type": fileType,
      },
    },
    async (span) => {
      try {
        const result = await fn();
        const cid = (result as any).IpfsHash || (result as any).cid;
        if (cid) span.setAttribute("ipfs.cid", cid);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    }
  );
}

/**
 * Wrap Stripe operations. Never log API keys or full session objects.
 */
export async function traceStripeOperation<T>(
  operation: string,
  fn: () => Promise<T>
): Promise<T> {
  return tracer.startActiveSpan(
    `stripe.${operation}`,
    {
      attributes: {
        "stripe.operation": operation,
      },
    },
    async (span) => {
      try {
        const result = await fn();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });

        const stripeErr = err as { type?: string; code?: string };
        if (stripeErr.type) span.setAttribute("stripe.error_type", stripeErr.type);
        if (stripeErr.code) span.setAttribute("stripe.error_code", stripeErr.code);

        throw err;
      } finally {
        span.end();
      }
    }
  );
}
```

### Usage in Publish Phase

```typescript
// src/publish.ts
import { traceENSWrite, traceIPFSUpload } from "./observability/external-services.js";

async function publishReport(report: Report, packageName: string) {
  // IPFS upload — traced with CID captured
  const reportCid = await traceIPFSUpload("report", () =>
    pinata.upload.json(report)
  );

  const sourceCid = await traceIPFSUpload("source", () =>
    pinata.upload.file(tarballStream)
  );

  // ENS writes — traced with tx hash and name
  await traceENSWrite("setTextRecord", ensSubname, () =>
    writeTextRecord(ensSubname, "npmguard.verdict", report.verdict)
  );

  await traceENSWrite("setTextRecord", ensSubname, () =>
    writeTextRecord(ensSubname, "npmguard.report_cid", reportCid)
  );
}
```

---

## 10. Metrics: Histograms, Counters, and Gauges

### Metric Definitions

```typescript
// src/observability/metrics.ts
import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("npmguard-engine");

// --- Audit Pipeline Metrics ---

/** Duration of each audit phase (seconds) */
export const phaseDuration = meter.createHistogram("audit.phase.duration", {
  unit: "s",
  description: "Duration of each audit pipeline phase",
});

/** Total audit duration from start to verdict */
export const auditDuration = meter.createHistogram("audit.total.duration", {
  unit: "s",
  description: "Total audit duration",
});

/** Audit verdicts by type */
export const auditVerdicts = meter.createCounter("audit.verdicts.total", {
  description: "Audit verdict counts",
});

/** Audits in progress right now */
const activeAudits = new Set<string>();
export const activeAuditGauge = meter.createObservableGauge("audit.active.count", {
  description: "Number of audits currently in progress",
});
activeAuditGauge.addCallback((result) => {
  result.observe(activeAudits.size);
});

export function trackAuditStart(auditId: string) { activeAudits.add(auditId); }
export function trackAuditEnd(auditId: string) { activeAudits.delete(auditId); }

// --- Queue Metrics ---

/** Pending audits in the queue */
export const queueDepth = meter.createObservableGauge("audit.queue.depth", {
  description: "Number of audits waiting in the queue",
});
// Wire this to the actual queue in index.ts:
// queueDepth.addCallback((result) => { result.observe(auditQueue.length); });

// --- Docker Metrics ---

/** Docker exec duration */
export const dockerExecDuration = meter.createHistogram("docker.exec.duration", {
  unit: "s",
  description: "Duration of Docker exec commands",
});

/** Docker OOM kills */
export const dockerOomKills = meter.createCounter("docker.oom_kills.total", {
  description: "Docker containers killed by OOM",
});

/** Docker exec timeouts */
export const dockerTimeouts = meter.createCounter("docker.timeouts.total", {
  description: "Docker exec commands that timed out",
});

// --- External Service Metrics ---

/** ENS write failures */
export const ensWriteErrors = meter.createCounter("ens.write.errors.total", {
  description: "ENS write operation failures",
});

/** IPFS upload duration */
export const ipfsUploadDuration = meter.createHistogram("ipfs.upload.duration", {
  unit: "s",
  description: "IPFS upload duration",
});

/** Stripe webhook processing */
export const stripeWebhookDuration = meter.createHistogram("stripe.webhook.duration", {
  unit: "s",
  description: "Stripe webhook processing duration",
});
```

### Recording Metrics in the Pipeline

```typescript
// In pipeline.ts — after each phase
phaseDuration.record(phaseElapsedSeconds, {
  "audit.phase": "triage",
  "audit.package": packageName,
});

// On verdict
auditVerdicts.add(1, {
  "audit.verdict": verdict,
  "audit.early_exit": String(earlyExit),
});

auditDuration.record(totalElapsedSeconds, {
  "audit.verdict": verdict,
  "audit.package": packageName,
});
```

### Cardinality Rules

**Do:** Use categorical, bounded attribute values.
```typescript
// Good — bounded cardinality
phaseDuration.record(dur, { "audit.phase": "triage" });          // 6 possible values
llmDuration.record(dur, { "gen_ai.request.model": "claude-3-haiku" }); // ~5 possible values
```

**Don't:** Use high-cardinality attributes on metrics.
```typescript
// Bad — unbounded cardinality, each audit creates a new time series
phaseDuration.record(dur, { "audit.id": auditId });         // Don't do this
phaseDuration.record(dur, { "audit.package": packageName }); // Only if you limit to top-N packages
```

---

## 11. Health Checks Beyond /health

### Three-Probe Architecture

```typescript
// src/observability/health.ts
import { Hono } from "hono";
import { logger } from "./logger.js";

interface HealthCheck {
  name: string;
  check: () => Promise<{ healthy: boolean; latencyMs: number; detail?: string }>;
}

const checks: HealthCheck[] = [
  {
    name: "docker",
    check: async () => {
      const start = performance.now();
      try {
        const { exitCode } = await dockerExec(["info", "--format", "{{.ServerVersion}}"], 5000);
        return {
          healthy: exitCode === 0,
          latencyMs: performance.now() - start,
        };
      } catch {
        return { healthy: false, latencyMs: performance.now() - start, detail: "Docker daemon unreachable" };
      }
    },
  },
  {
    name: "llm_api",
    check: async () => {
      const start = performance.now();
      try {
        // Lightweight model list call — don't burn tokens on health checks
        const resp = await fetch(`${config.llm.baseUrl}/models`, {
          headers: { Authorization: `Bearer ${config.llm.apiKey}` },
          signal: AbortSignal.timeout(5000),
        });
        return {
          healthy: resp.ok,
          latencyMs: performance.now() - start,
          detail: resp.ok ? undefined : `HTTP ${resp.status}`,
        };
      } catch (err) {
        return {
          healthy: false,
          latencyMs: performance.now() - start,
          detail: (err as Error).message,
        };
      }
    },
  },
];

/**
 * Register health endpoints on a Hono app.
 */
export function registerHealthChecks(app: Hono) {
  // Liveness: is the process alive? No external deps.
  // Kubernetes uses this to decide whether to restart the pod.
  app.get("/healthz", (c) => {
    return c.json({ status: "alive", uptime: process.uptime() });
  });

  // Readiness: can this instance handle traffic?
  // Checks critical dependencies. Kubernetes removes from load balancer on failure.
  app.get("/readyz", async (c) => {
    const results = await Promise.allSettled(
      checks.map(async (check) => ({
        name: check.name,
        ...(await check.check()),
      }))
    );

    const checkResults = results.map((r) =>
      r.status === "fulfilled"
        ? r.value
        : { name: "unknown", healthy: false, latencyMs: 0, detail: "check threw" }
    );

    const allHealthy = checkResults.every((r) => r.healthy);

    if (!allHealthy) {
      const unhealthy = checkResults.filter((r) => !r.healthy);
      logger.warn({ checks: unhealthy }, "readiness check failed");
    }

    return c.json(
      {
        status: allHealthy ? "ready" : "not_ready",
        checks: Object.fromEntries(
          checkResults.map((r) => [r.name, { healthy: r.healthy, latencyMs: Math.round(r.latencyMs), detail: r.detail }])
        ),
      },
      allHealthy ? 200 : 503
    );
  });

  // Startup: has initialization completed?
  // Used by Kubernetes to delay liveness checks during startup.
  let startupComplete = false;
  app.get("/startupz", (c) => {
    return c.json({ started: startupComplete }, startupComplete ? 200 : 503);
  });

  return {
    markStartupComplete: () => { startupComplete = true; },
  };
}
```

### Usage

```typescript
// src/index.ts
import { registerHealthChecks } from "./observability/health.js";

const app = new Hono();
const { markStartupComplete } = registerHealthChecks(app);

// After all routes registered and dependencies verified
markStartupComplete();

serve({ fetch: app.fetch, port: config.api.port }, () => {
  logger.info({ port: config.api.port }, "server started");
});
```

### Kubernetes Probe Configuration

```yaml
# k8s deployment excerpt
livenessProbe:
  httpGet:
    path: /healthz
    port: 3000
  periodSeconds: 15
  failureThreshold: 3
  timeoutSeconds: 5
readinessProbe:
  httpGet:
    path: /readyz
    port: 3000
  periodSeconds: 10
  failureThreshold: 2
  timeoutSeconds: 5
startupProbe:
  httpGet:
    path: /startupz
    port: 3000
  periodSeconds: 5
  failureThreshold: 30    # Allows 150s to start
  timeoutSeconds: 3
```

---

## 12. Log Levels Strategy

| Level | When to Use | Examples in NpmGuard |
| --- | --- | --- |
| **fatal** | Unrecoverable error → process must exit | Config validation failure, port already in use |
| **error** | Operation failed, requires attention | LLM API 500, Docker daemon unreachable, ENS revert, Stripe webhook signature invalid |
| **warn** | Recoverable issue, potential problem | LLM retry triggered, sandbox exec timeout (retrying), queue depth > 10, high memory usage |
| **info** | Significant business events | Audit started, phase completed, verdict reached, ENS record published, payment received |
| **debug** | Diagnostic detail for troubleshooting | File classification results, LLM prompt/response lengths, Docker exec stdout preview |
| **trace** | Granular function-level tracing | Tool call arguments, individual file analysis inputs, raw instrumentation log parsing |

### Rules

1. **Production baseline is `info`.** Debug and trace are suppressed unless explicitly enabled via `LOG_LEVEL=debug`.
2. **Never log at `info` inside a tight loop.** Triage analyzes 12+ files — log progress at `debug`, summary at `info`.
3. **Error logs must include context.** Always include `auditId`, the failing operation, and the error object.
4. **Warn means "someone should look at this eventually."** Error means "someone should look at this now."
5. **Fatal must be followed by `process.exit(1)`.** If you log fatal and keep running, it's actually an error.

```typescript
// Good: structured error with full context
log.error({ err, auditId, phase: "verify", containerId: id.slice(0, 12) }, "sandbox verification failed");

// Bad: unstructured, no context
console.error("Error: " + err.message);
```

---

## 13. What to Log at Each Audit Phase

### Phase 0a: Resolve

```typescript
// info: audit started
log.info({ source: "npm", version: "1.2.3" }, "package resolved");

// warn: registry returned unexpected status
log.warn({ statusCode: 429, retryAfter: 30 }, "npm registry rate limited");

// error: package not found
log.error({ packageName, statusCode: 404 }, "package not found on npm registry");

// debug: tarball details
log.debug({ tarballUrl, size: tarballBytes, extractPath }, "tarball downloaded and extracted");
```

### Phase 0b: Inventory

```typescript
// info: summary only
log.info(
  { fileCount: files.length, scriptCount: scripts.length, flagCount: flags.length, hasDealbreaker: dealbreakers.length > 0 },
  "inventory complete"
);

// warn: structural anomalies
log.warn({ flag: "shell_pipe_in_lifecycle", script: "preinstall" }, "inventory flag: shell pipe in lifecycle script");

// debug: individual file classifications
log.debug({ file: record.path, binary: record.isBinary, size: record.size }, "file classified");
```

### Phase 1a: Triage

```typescript
// info: triage result (not per-file)
log.info(
  { riskScore, threshold, verdict: riskScore < threshold ? "SAFE" : "INVESTIGATE", filesAnalyzed: fileVerdicts.length },
  "triage complete"
);

// debug: per-file verdict
log.debug(
  { file: verdict.path, capabilities: verdict.capabilities, suspicious: verdict.suspicious },
  "file triage verdict"
);

// warn: unexpectedly high token usage
log.warn(
  { model, promptTokens, completionTokens, fileCount: files.length },
  "triage token usage exceeds expected range"
);
```

### Phase 1b: Investigation

```typescript
// info: investigation summary
log.info(
  { findingsCount: findings.length, toolCalls: toolCallCount, turns, durationSec },
  "investigation complete"
);

// info: finding discovered (business event)
log.info(
  { capability: finding.capability, confidence: finding.confidence, file: finding.file, line: finding.line },
  "finding discovered"
);

// debug: individual tool calls
log.debug(
  { tool: toolCall.name, args: toolCall.args, resultLength: toolCall.result.length },
  "agent tool call"
);

// warn: injection pattern detected in output
log.warn(
  { pattern: detected, tool: toolCall.name },
  "prompt injection pattern detected in tool result"
);
```

### Phase 1c: Test Generation

```typescript
// info: tests generated
log.info(
  { testsGenerated: tests.length, retriesNeeded: retryCount },
  "test generation complete"
);

// warn: test validation failed, retrying
log.warn(
  { testFile, error: validationError.message, attempt: attemptNum, maxAttempts: 3 },
  "test validation failed, regenerating"
);
```

### Phase 2: Verification

```typescript
// info: verification result
log.info(
  { proofsConfirmed, proofsUnconfirmed, proofsTotal: proofs.length, durationSec },
  "verification complete"
);

// info: proof confirmed (critical business event)
log.info(
  { proofKind: "TEST_CONFIRMED", capability, file, line, testHash },
  "vulnerability proof confirmed"
);

// error: sandbox crashed during verification
log.error(
  { exitCode: 137, containerId: id.slice(0, 12), memoryLimitMb: config.sandbox.memoryMb },
  "sandbox OOM during verification"
);
```

### Publishing

```typescript
// info: publishing results
log.info(
  { reportCid, sourceCid, ensName, verdict },
  "report published to IPFS and ENS"
);

// error: ENS write failed
log.error(
  { err, ensName, operation: "setTextRecord", record: "npmguard.verdict" },
  "ENS write failed"
);
```

---

## 14. Alerting Thresholds

### Defining Alerts

Use metrics from Section 10 to drive alerts. These thresholds are starting points — tune them based on your baseline after 2 weeks of production data.

### LLM Alerts

| Alert | Condition | Severity | Action |
| --- | --- | --- | --- |
| LLM latency spike | `gen_ai.client.operation.duration` p99 > 15s for 5 min | Warning | Check provider status page |
| LLM latency critical | `gen_ai.client.operation.duration` p99 > 30s for 5 min | Critical | Switch to backup model or pause audits |
| LLM error rate | `gen_ai.client.errors.total` rate > 5/min for 3 min | Critical | Check API key, quota, provider status |
| Token budget exceeded | `gen_ai.client.token.usage` daily sum > budget threshold | Warning | Review prompt efficiency, check for large files |

### Docker/Sandbox Alerts

| Alert | Condition | Severity | Action |
| --- | --- | --- | --- |
| OOM kill rate | `docker.oom_kills.total` rate > 2/hour | Warning | Increase `SANDBOX_MEMORY_MB`, investigate package size |
| Sandbox timeout rate | `docker.timeouts.total` rate > 3/hour | Warning | Increase timeout, check for infinite loops |
| Docker daemon unhealthy | `/readyz` Docker check fails for 2 consecutive checks | Critical | Check Docker daemon, disk space, restart Docker |

### External Service Alerts

| Alert | Condition | Severity | Action |
| --- | --- | --- | --- |
| ENS write failure | `ens.write.errors.total` rate > 0 for 5 min | Warning | Check gas, RPC endpoint, wallet balance |
| ENS write failure sustained | `ens.write.errors.total` rate > 0 for 15 min | Critical | Investigate revert reasons, check contract state |
| IPFS upload latency | `ipfs.upload.duration` p95 > 10s for 5 min | Warning | Check Pinata status, network connectivity |
| Stripe webhook failures | `stripe.webhook.duration` p99 > 5s or error rate > 0 | Warning | Check webhook signing secret, Stripe status |

### Pipeline Alerts

| Alert | Condition | Severity | Action |
| --- | --- | --- | --- |
| Audit duration anomaly | `audit.total.duration` p95 > 120s | Warning | Profile slow phases, check LLM latency contribution |
| Queue backing up | `audit.queue.depth` > 5 for 5 min | Warning | Scale horizontally or throttle incoming requests |
| Zero audits completing | `audit.verdicts.total` rate = 0 for 30 min (during business hours) | Critical | Check all health probes, LLM API, Docker daemon |
| High DANGEROUS rate | `audit.verdicts.total{verdict=DANGEROUS}` rate spike 3x baseline | Info | Review — could be a legitimate wave of malicious packages, or a regression in triage threshold |

### Grafana Alert Rule Example

```yaml
# alerting/audit-pipeline.yaml
apiVersion: 1
groups:
  - orgId: 1
    name: npmguard-engine
    interval: 1m
    rules:
      - uid: llm-latency-warning
        title: "LLM API Latency Spike"
        condition: B
        data:
          - refId: A
            queryType: range
            datasourceUid: prometheus
            model:
              expr: histogram_quantile(0.99, rate(gen_ai_client_operation_duration_bucket{service_name="npmguard-engine"}[5m]))
          - refId: B
            queryType: classic_conditions
            model:
              conditions:
                - evaluator: { type: gt, params: [15] }
                  reducer: { type: avg }
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "LLM API p99 latency > 15s for 5 minutes"
          runbook: "Check provider status, consider model fallback"
```

---

## 15. Sensitive Data Redaction

### Defense in Depth: Three Layers

**Layer 1: Pino redaction** (application code — see Section 3)
- Catches secrets before they enter any log transport
- Uses fast-redact for zero-overhead path-based redaction

**Layer 2: OpenTelemetry span attribute filtering** (SDK level)

```typescript
// src/observability/otel.ts — add a SpanProcessor that scrubs attributes
import { SpanProcessor, ReadableSpan } from "@opentelemetry/sdk-trace-base";

const SENSITIVE_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /token/i,
  /authorization/i,
  /private[_-]?key/i,
  /cookie/i,
];

class RedactingSpanProcessor implements SpanProcessor {
  onStart() {}
  onEnd(span: ReadableSpan) {
    for (const [key, value] of Object.entries(span.attributes)) {
      if (SENSITIVE_PATTERNS.some((p) => p.test(key))) {
        // Can't mutate ReadableSpan attributes directly — filter at export
        // This processor serves as a safety net to detect leaks
        logger.warn({ attributeKey: key }, "sensitive attribute detected in span — check instrumentation");
      }
    }
  }
  shutdown() { return Promise.resolve(); }
  forceFlush() { return Promise.resolve(); }
}
```

**Layer 3: OTel Collector processor** (infrastructure level)

```yaml
# otel-collector-config.yaml
processors:
  attributes/redact:
    actions:
      - key: http.request.header.authorization
        action: delete
      - key: http.request.header.cookie
        action: delete
      - key: http.request.header.x-api-key
        action: delete
      - key: url.full
        action: hash    # Hash URLs to preserve cardinality without leaking tokens in query strings
```

### What to Redact

| Category | Fields | Method |
| --- | --- | --- |
| API keys | `ANTHROPIC_API_KEY`, `NPMGUARD_LLM_API_KEY`, `PINATA_JWT` | Pino redact paths |
| Payment secrets | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Pino redact paths |
| Blockchain keys | `SEPOLIA_PRIVATE_KEY`, wallet mnemonics | Pino redact paths |
| Auth headers | `Authorization`, `Cookie`, `X-API-Key` | OTel Collector attribute processor |
| LLM prompts with user data | Full prompts containing package source code | Log prompt length, not content (at info level) |
| Environment variables | Entire `process.env` dumps from sandbox | Truncate, hash, or redact sensitive keys |

---

## 16. Cost-Effective Observability

### Cost Distribution

In a typical OpenTelemetry stack, **traces account for 60-70%** of storage/egress cost, logs 20-30%, and metrics 5-15%. Optimize in that order.

### Sampling Strategy

```typescript
// src/observability/otel.ts
import { TraceIdRatioBasedSampler, ParentBasedSampler } from "@opentelemetry/sdk-trace-base";

const sdk = new NodeSDK({
  // Parent-based: if the incoming request has a sampled parent, keep it.
  // Otherwise, sample 20% of traces.
  sampler: new ParentBasedSampler({
    root: new TraceIdRatioBasedSampler(0.2),
  }),
  // ...rest of config
});
```

**But:** For a low-volume service like NpmGuard (audits are expensive, not frequent), **start with 100% sampling**. You're processing maybe 100-1000 audits per day — that's a few thousand traces. Sampling becomes relevant at >10,000 traces/hour.

### Tail Sampling at the Collector

The Collector can make smarter sampling decisions because it sees the complete trace:

```yaml
# otel-collector-config.yaml
processors:
  tail_sampling:
    policies:
      # Always keep error traces
      - name: errors
        type: status_code
        status_code: { status_codes: [ERROR] }
      # Always keep slow traces (>30s total)
      - name: slow
        type: latency
        latency: { threshold_ms: 30000 }
      # Always keep DANGEROUS verdicts
      - name: dangerous
        type: string_attribute
        string_attribute:
          key: audit.verdict
          values: [DANGEROUS]
      # Sample 20% of everything else
      - name: baseline
        type: probabilistic
        probabilistic: { sampling_percentage: 20 }
```

### Log Volume Reduction

```yaml
# otel-collector-config.yaml
processors:
  filter/logs:
    logs:
      # Drop debug logs in production (should be suppressed at source, but defense in depth)
      exclude:
        match_type: strict
        severity_texts: ["DEBUG", "TRACE"]

  filter/health:
    logs:
      # Drop health check logs (filtered at pino-http level too, but belt and suspenders)
      exclude:
        match_type: regexp
        bodies: ["GET /health.*"]
```

### What This Costs

For a service doing ~500 audits/day (each generating ~50 spans + ~100 log lines):

| Signal | Volume/Day | Estimated Cost (Grafana Cloud free tier) |
| --- | --- | --- |
| Traces | ~25,000 spans | Free tier covers 50GB/month |
| Logs | ~50,000 lines | Free tier covers 50GB/month |
| Metrics | ~20 time series | Free tier covers 10,000 series |

At this scale, a self-hosted Grafana + Tempo + Loki + Prometheus stack on a single $20/month VPS handles everything comfortably. You don't need to optimize cost until you hit 10x this volume.

---

## 17. Anti-Patterns

### Anti-Pattern 1: Console.log in Production

Unstructured text with no levels, no context, no redaction, and no transport flexibility.

```typescript
// WRONG — unstructured, no context, blocks event loop with sync write
console.log("Starting audit for " + packageName);
console.error("Error: " + err.message);

// RIGHT — structured JSON, auto-correlated with traces, async transport
const log = logger.child({ auditId, packageName, component: "pipeline" });
log.info("audit started");
log.error({ err }, "audit failed");
```

### Anti-Pattern 2: Logging Sensitive Data

Secrets in logs end up in log storage, dashboards, and alert messages.

```typescript
// WRONG — API key in the log, visible to anyone with dashboard access
logger.info({ apiKey: config.llm.apiKey }, "connecting to LLM provider");
logger.debug({ env: process.env }, "environment dump");

// RIGHT — redact at the logger level, log only what's needed
logger.info({ provider: config.llm.backend, model: config.triage.model }, "connecting to LLM provider");
// process.env is never logged — sandbox instrumentation captures specific accesses
```

### Anti-Pattern 3: Same Endpoint for Liveness and Readiness

Different failure modes need different responses. A dead database should not trigger pod restarts.

```typescript
// WRONG — single health check that queries the database
app.get("/health", async (c) => {
  await db.query("SELECT 1");  // If DB is down, Kubernetes restarts the pod
  return c.json({ status: "ok" });  // Cascading restarts don't fix a DB outage
});

// RIGHT — separate probes with different semantics
app.get("/healthz", (c) => c.json({ status: "alive" }));  // Liveness: is the process alive?
app.get("/readyz", async (c) => {                           // Readiness: can I handle traffic?
  const dbOk = await checkDb();
  return c.json({ ready: dbOk }, dbOk ? 200 : 503);       // 503 removes from LB, doesn't restart
});
```

### Anti-Pattern 4: Missing Error Context

An error log without context is useless at 3am.

```typescript
// WRONG — which audit? which file? which phase? what was the input?
logger.error("LLM call failed");
logger.error(err.message);

// RIGHT — full context for debugging without reproduction
logger.error(
  { err, auditId, phase: "triage", file: filePath, model: config.triage.model, attempt: 2, maxAttempts: 3 },
  "LLM call failed during triage"
);
```

### Anti-Pattern 5: High-Cardinality Metric Attributes

Every unique attribute combination creates a new time series. Unbounded values cause metric explosion.

```typescript
// WRONG — each audit creates a new time series that lives forever
phaseDuration.record(dur, { "audit.id": auditId });            // Unbounded
phaseDuration.record(dur, { "audit.package": "react@19.0.1" }); // Too many package versions

// RIGHT — bounded, categorical attributes only
phaseDuration.record(dur, { "audit.phase": "triage" });         // 6 possible values
phaseDuration.record(dur, { "audit.verdict": "DANGEROUS" });    // 2 possible values
```

### Anti-Pattern 6: Initializing OTel After Application Code

Auto-instrumentation works by monkey-patching Node.js modules at import time. If `http` is imported before OTel starts, HTTP calls won't be traced.

```typescript
// WRONG — OTel initializes after http is already imported
import { serve } from "@hono/node-server";  // Imports http internally
import { setupOtel } from "./otel.js";
setupOtel();  // Too late — http is already loaded without instrumentation

// RIGHT — OTel loads first via --import flag
// package.json: "start": "node --import ./dist/observability/otel.js ./dist/index.js"
// otel.ts runs before any application import
```

### Anti-Pattern 7: Logging Inside Tight Loops

Logging per-file in triage (12+ files × 3 log calls = 36+ lines) buries signal in noise.

```typescript
// WRONG — info-level log for every file in triage, every tool call in investigation
for (const file of files) {
  log.info({ file: file.path }, "analyzing file");          // 12+ lines of noise
  const result = await analyzeFile(file);
  log.info({ file: file.path, result }, "file analyzed");   // 12+ more lines
}

// RIGHT — debug per-file, info for the batch summary
for (const file of files) {
  log.debug({ file: file.path }, "analyzing file");         // Suppressed in production
  const result = await analyzeFile(file);
  log.debug({ file: file.path, capabilities: result.capabilities }, "file analyzed");
}
log.info({ filesAnalyzed: files.length, riskScore }, "triage complete");  // One info line
```

### Anti-Pattern 8: Not Recording Exceptions on Spans

Silent error spans make traces useless for debugging.

```typescript
// WRONG — span ends without recording what went wrong
tracer.startActiveSpan("audit.triage", async (span) => {
  try {
    await runTriage();
  } catch (err) {
    span.end();  // No error info recorded — trace shows green, but it failed
    throw err;
  }
});

// RIGHT — exception recorded, status set, then span ends
tracer.startActiveSpan("audit.triage", async (span) => {
  try {
    await runTriage();
    span.setStatus({ code: SpanStatusCode.OK });
  } catch (err) {
    span.recordException(err as Error);   // Stack trace attached to the span
    span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
    throw err;
  } finally {
    span.end();  // Always end, even on error
  }
});
```

### Anti-Pattern 9: 100% Sampling with No Tail Sampling

At scale, 100% head sampling bankrupts your observability budget. But at low scale, aggressive sampling loses the one trace you need.

```typescript
// WRONG at scale — every trace stored, $500/month in Grafana Cloud for 50k traces/day
const sdk = new NodeSDK({ sampler: new AlwaysOnSampler() });

// WRONG at low volume — 1% sampling, you'll miss the one DANGEROUS audit that matters
const sdk = new NodeSDK({ sampler: new TraceIdRatioBasedSampler(0.01) });

// RIGHT — start at 100%, add tail sampling at the Collector when volume demands it
// Head sampling: keep all traces in the app
const sdk = new NodeSDK({ sampler: new AlwaysOnSampler() });
// Tail sampling in the Collector: always keep errors and slow traces, sample 20% of the rest
// See Section 16 for Collector config
```

### Anti-Pattern 10: Checking External Deps in Liveness Probes

If your database is down, restarting all pods simultaneously makes it worse.

```typescript
// WRONG — cascading restart storm when the DB hiccups
app.get("/healthz", async (c) => {
  const dbOk = await db.ping();
  const redisOk = await redis.ping();
  const dockerOk = await exec("docker info");
  return c.json({ ok: dbOk && redisOk && dockerOk }, dbOk && redisOk && dockerOk ? 200 : 500);
});

// RIGHT — liveness is process-internal only
app.get("/healthz", (c) => c.json({ status: "alive" }));
// Dependency health belongs in /readyz — failure removes from LB, doesn't trigger restarts
```

### Anti-Pattern 11: Orphaned Spans from Docker Exec

Docker exec creates a process boundary. Without explicit context propagation, child spans are orphaned — they appear as separate, disconnected traces.

```typescript
// WRONG — docker exec runs in a separate process, no trace context passed
const result = await exec(`docker exec ${containerId} node /pkg/test.js`);
// The test.js spans (if any) have no parent — they're orphaned

// RIGHT — serialize trace context and pass via environment variables
const carrier: Record<string, string> = {};
propagation.inject(context.active(), carrier);
const envArgs = Object.entries(carrier).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
const result = await exec(`docker exec ${envArgs.join(" ")} ${containerId} node /pkg/test.js`);
// Inside test.js: propagation.extract(ROOT_CONTEXT, process.env)
```

### Anti-Pattern 12: Logging Health Checks

Health checks fire every 5-15 seconds. At info level, they generate 4,000-8,000 log lines per day of pure noise.

```typescript
// WRONG — health check logs drown out actual signal
app.use("*", (c, next) => {
  console.log(`${c.req.method} ${c.req.url}`);  // Logs every health check
  return next();
});

// RIGHT — filter at the HTTP logger level
const httpLogger = pinoHttp({
  autoLogging: {
    ignore(req) {
      return req.url === "/healthz" || req.url === "/readyz" || req.url === "/startupz";
    },
  },
});
```

---

## 18. Projects Studied

| # | Repository | Stars | Category | Key Pattern Learned |
| --- | --- | --- | --- | --- |
| 1 | [pinojs/pino](https://github.com/pinojs/pino) | ~17.6k | Logging library | Worker-thread transports, redaction config, child logger patterns |
| 2 | [open-telemetry/opentelemetry-js](https://github.com/open-telemetry/opentelemetry-js) | ~4k | Tracing SDK | NodeSDK bootstrap, auto-instrumentation, context propagation |
| 3 | [pinojs/pino-opentelemetry-transport](https://github.com/pinojs/pino-opentelemetry-transport) | ~200 | Log bridge | Sending Pino logs as OTLP LogRecords with trace correlation |
| 4 | [open-telemetry/opentelemetry-js-contrib](https://github.com/open-telemetry/opentelemetry-js-contrib) | ~700 | Instrumentations | `instrumentation-pino` for automatic trace-log correlation |
| 5 | [SigNoz/signoz](https://github.com/SigNoz/signoz) | ~26.4k | Observability platform | Full OTel-native log/trace/metric correlation in one UI |
| 6 | [openobserve/openobserve](https://github.com/openobserve/openobserve) | ~18.5k | Observability platform | Cost-effective storage tiering for high-volume telemetry |
| 7 | [hyperdxio/hyperdx](https://github.com/hyperdxio/hyperdx) | ~9.4k | Observability platform | Unified session replay + logs + traces via ClickHouse and OTel |
| 8 | [traceloop/openllmetry](https://github.com/traceloop/openllmetry) | ~6.4k | LLM observability | GenAI semantic conventions, auto-instrumenting LLM providers |
| 9 | [traceloop/openllmetry-js](https://github.com/traceloop/openllmetry-js) | ~388 | LLM observability (JS) | TypeScript patterns for LLM call tracing and token tracking |
| 10 | [langfuse/langfuse](https://github.com/langfuse/langfuse) | ~15k | LLM platform | LLM observability, evaluation, prompt management with OTel integration |
| 11 | [open-telemetry/opentelemetry-demo](https://github.com/open-telemetry/opentelemetry-demo) | ~3k | Reference architecture | Canonical multi-service OTel demo — "Astronomy Shop" |
| 12 | [pragmaticivan/nestjs-otel](https://github.com/pragmaticivan/nestjs-otel) | ~768 | Framework integration | Framework-level OTel tracing + metrics module pattern |
| 13 | [mnadeem/nodejs-opentelemetry-tempo](https://github.com/mnadeem/nodejs-opentelemetry-tempo) | ~300 | Full stack demo | Complete Prometheus + Loki + Tempo + Grafana with OTel |
| 14 | [Effect-TS/effect](https://github.com/Effect-TS/effect) | ~13.8k | TypeScript framework | Built-in observability/tracing primitives in a production TS framework |
| 15 | [goldbergyoni/nodebestpractices](https://github.com/goldbergyoni/nodebestpractices) | ~100k | Best practices | Canonical Node.js production logging and error handling patterns |
| 16 | [highlight/highlight](https://github.com/highlight/highlight) | ~8k | Full-stack monitoring | Error monitoring, session replay, logging, distributed tracing in TypeScript |
| 17 | [pinojs/pino-http](https://github.com/pinojs/pino-http) | ~1k | HTTP logging | Request logging middleware with automatic context propagation |
| 18 | [magsther/awesome-opentelemetry](https://github.com/magsther/awesome-opentelemetry) | ~300 | Curated list | Comprehensive catalog of OTel tooling, exporters, and integrations |

*Generated from studying 18 production codebases with a combined 270k+ GitHub stars, cross-referenced with official OpenTelemetry documentation, GenAI semantic conventions, Pino documentation, and community best practices as of April 2026.*
