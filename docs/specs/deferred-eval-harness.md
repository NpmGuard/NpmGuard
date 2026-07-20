# Deferred: evaluation harness redesign

Status: deferred until the Python backend migration is complete.

The current Datadog benchmark is a useful dataset and end-to-end suite, but it
is not yet a trustworthy evaluation harness. Rebuild it as an eval control
plane using the patterns in `/home/wookie/zen/ops/interviews/fde`.

The redesign must:

- score every terminal audit outcome, including infrastructure and model
  errors, instead of silently removing failures from the denominator;
- record immutable run configuration, prompts, model/provider, tool traces,
  evidence, timings, cost, and terminal status;
- evaluate individual pipeline stages as well as the final verdict;
- separate deterministic assertions from calibrated LLM-as-judge scoring;
- maintain golden regression cases, a held-out set, negative controls, and
  production-sampled cases;
- poll an audit's terminal state rather than infer completion from package
  report availability;
- replace the stale legacy proof/capability schemas with the current report,
  evidence, graph, and event contracts;
- expose uncertainty and abstention/error rates alongside precision and
  recall.

The backend migration should preserve enough durable event and run metadata to
support this work without another storage redesign.
