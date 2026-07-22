# Kit LLM transport audit — 2026-07-20

## Conclusion

The live failures are a transport-contract failure, not a Gemini quality
failure. Kit's Pydantic output sugar sends only `response_format:
{"type":"json_object"}`. The provider never receives the Pydantic schema;
the local parser is the first place the contract exists. The synthetic tool
transport does send a schema, but it asks a model to express a deeply nested
Pydantic union as a function call. Gemini calls the function, then emits
stringified pseudo-calls and prose in fields that require objects. Adding
`strict: true` to the function definition did not change that behavior.

The durable design is:

1. Make structured response schema a first-class provider request, not a
   boolean JSON-mode flag.
2. Use strict response JSON for final data. Do not use a fake function call as
   a structured-output channel.
3. Keep agentic function calling separate from final-output encoding.
4. Run app semantic validation in Kit's bounded repair loop, after structural
   decoding and before returning a result.
5. Treat provider/model capabilities as runtime data. Record the actual
   provider, finish reason, refusal, reasoning, and usage in every attempt.
6. Use portable wire DTOs for strict providers: no arbitrary maps, defaults,
   discriminator/oneOf machinery, or unconstrained nested unions. The app
   converts that DTO deterministically into its internal tool calls.

## Evidence

### Production

The dev server at `root@91.99.207.103` was running Python with
`google/gemini-2.5-flash` for both triage and investigation. The eight-package
run on 2026-07-20 produced one successful audit and seven failures.

* FLAG failures were `role 'flag': no model produced parseable output`.
  Captured outputs used legacy shapes such as `capabilities: {ENV_VARS: true}`
  and flags with `lineNumberRange`, `reason`, or `severity` instead of the
  contract's `lines` and `why`.
* HYPOTHESIZE failures called Kit's `emit_output` tool but put prose strings in
  `claim`, `trigger`, and `setup` instead of objects. Every physical attempt
  was invalid; bounded repair repeated the same incompatible shape.
* The ledger shows 87 invalid HYPOTHESIZE attempts across dotenv and semver.
  Concurrent flags multiplied one logical failure into three billed calls per
  flag. This is why the failure was expensive even though the error was
  deterministic.
* Intent also needed repair: Gemini initially put free-form capability
  descriptions into a literal enum. This is the same missing-schema problem
  in another role.

### Code path

* `engine/kit_llm/parser.py:41` maps every Pydantic output to a boolean
  `wants_json`.
* `engine/kit_llm/provider.py:119` turns that boolean into JSON object mode;
  the schema is absent.
* `engine/kit_llm/client.py:239` derives a synthetic `emit_output` function
  for tool transport, but `engine/kit_llm/client.py:248` disables JSON mode
  whenever tools are present. The function definition has no strict marker or
  provider capability routing.
* `engine/npmguard/phases.py:460` uses that fake tool for HYPOTHESIZE, then
  calls `compile_experiment` only after Kit has returned. A semantically bad
  but structurally valid plan cannot enter Kit's repair loop.
* `ProviderResult` does not retain the actual routed provider, finish reason,
  refusal, or reasoning. A top-level provider error can arrive in an HTTP 200
  envelope; the adapter only checks `choices`, so diagnostics are poor.

## Controlled live benchmark

Each cell used eight concurrent OpenRouter calls, small source input, the
actual Pydantic HYPOTHESIZE shape for the first matrix, and then a proposed
portable plan DTO. Costs below are provider-reported and exclude failed calls
where the provider returned no usage.

### Current contract and transports

| Cell | Structural pass | Observation |
|---|---:|---|
| Gemini JSON-object FLAG | 0/8 | Invented legacy keys and map-valued capabilities |
| Gemini forced-tool HYPOTHESIZE | 0/8 | Tool called, nested arguments were pseudo-code strings |
| Gemini forced-tool + `strict:true` | 0/8 | No improvement |
| Gemini strict response JSON FLAG | 8/8 | Valid shape; roughly $0.0062 for eight calls |
| Gemini strict response JSON HYPOTHESIZE | 8/8 | Valid shape; roughly $0.0072 for eight calls |
| DeepSeek V4 Flash strict response HYPOTHESIZE | 5/8 | Empty/truncated outputs across routed providers |
| GPT-5 nano strict response, unmodified Pydantic schema | 0/8 | Provider rejected schema: `additionalProperties` must be false |
| Qwen3.5 Flash strict response | 0/8 | Alibaba returned HTTP 200 with an upstream error; it requires the prompt to contain “JSON” and mapped the request to JSON-object mode |

### Proposed portable plan DTO

The second matrix used a strict response schema with fixed setup fields,
key/value arrays instead of maps, all fields required, and no discriminator.
The app would compile this DTO into the existing `ToolCall[]`. A semantic pass
required the right claim/gate, canary file, URL stub, trigger, and no truthy
`CI` injection.

| Model class | Structural pass | Semantic pass | Notes |
|---|---:|---:|---|
| Gemini 2.5 Flash | 7/8 | 6/8 | Best overall; one schema drift despite strict routing |
| Gemini 2.5 Flash Lite | 7/8 | 5/8 | Much cheaper, slightly less stable |
| GPT-4.1 nano | 8/8 | 0/8 | Exact shape, but plans were unusable |
| DeepSeek V4 Flash | 3/8 | 0/8 | Slow, truncated/empty responses and provider variance |
| Qwen3.5 Flash | 0/8 | 0/8 | Returned a different legacy contract |
| Mistral Small 3.2 | 8/8 | 0/8 | Exact shape, poor task adherence |

The result is decisive: structural enforcement and semantic correctness are
separate acceptance criteria. A model can be 8/8 schema-valid and still be
0/8 usable for an audit.

## Recommended Kit redesign

### Diff A — provider-aware strict response transport (required)

```diff
 class ProviderRequest:
     ...
-    json_response: bool = False
+    response_schema: dict[str, Any] | None = None
+    response_mode: Literal["text", "json_object", "json_schema"] = "text"
+    provider_options: dict[str, Any] | None = None

 class ProviderResult:
     ...
+    provider: str | None
+    finish_reason: str | None
+    refusal: str | None
+    reasoning: Any | None

 def _request_kwargs(request):
     ...
-    if request.json_response:
-        kwargs["response_format"] = {"type": "json_object"}
+    if request.response_schema is not None:
+        kwargs["response_format"] = {
+            "type": "json_schema",
+            "json_schema": {
+                "name": request.role,
+                "strict": True,
+                "schema": request.response_schema,
+            },
+        }
+        kwargs["provider"] = {
+            "require_parameters": True,
+            **(request.provider_options or {}),
+        }
+    elif request.response_mode == "json_object":
+        kwargs["response_format"] = {"type": "json_object"}
```

`Role`/`ModelSpec` should carry `output_mode`, `max_output_tokens`, optional
reasoning policy, and provider routing. The chain must not assume every model
supports the same transport. The adapter must reject top-level `{error: ...}`
responses even when HTTP status is 200 and capture provider metadata.

### Diff B — separate wire DTO, decoder, and semantic validator (required for
NpmGuard)

```diff
-result = await llm.run("hypothesis", output=HypothesisSubmission,
-                       output_transport="tool", ...)
+result = await llm.run(
+    "hypothesis",
+    output=PortableExperimentPlan,
+    output_transport="json_schema",
+    validate=validate_experiment_plan,
+    decode=compile_portable_plan,
+    ...,
+)
```

Kit should parse the strict wire DTO, call `validate`, and on a domain error
append the error to the repair transcript before spending the next attempt.
`decode` runs only after validation. This moves `compile_experiment` failures
inside the existing bounded repair mechanism instead of surfacing them as a
terminal audit error.

The NpmGuard wire DTO should use fixed arrays (`environment`, `files`,
`urlStubs`, `filePatches`) and key/value records for maps. Its compiler can
continue producing the current `ToolCall[]` and report schema. Add explicit
field descriptions for security-sensitive semantics, e.g. “do not set CI to
`false`; non-empty strings are truthy in JavaScript.”

### Diff C — capability discovery and honest fallback (required for Kit)

At startup or first use, fetch/cache model metadata (supported parameters,
pricing, context length). Build a per-model capability plan:

* strict response schema → only models/providers advertising structured outputs;
* agentic tool loop → tools/tool_choice;
* reasoning models → explicit reasoning budget or disabled reasoning;
* provider routing → `require_parameters: true` and configured provider order.

If no endpoint supports the requested contract, fail before billing with a
typed `UnsupportedOutputTransport`, not an `OutputInvalid` after three repairs.
If a provider emits an HTTP-200 error envelope, classify it as provider error
and advance the chain.

### Diff D — quality and spend controls

Add a semantic validator to the benchmark harness and make every live cell
record schema pass, semantic pass, provider, finish reason, latency, tokens,
and cost. Add per-role concurrency/budget reservations so eight concurrent
flags cannot all pass the spend guard against the same stale balance. Repair
structural errors only when the transport is not strict; for strict transports
prefer provider fallback or a schema simplification over three blind repairs.

## Acceptance bar

Kit is ready for an app like NpmGuard only when a portable DTO benchmark shows
at least 8/8 structural validity and 8/8 semantic validity for the selected
primary model, with a second model at least 7/8, no silent HTTP-200 provider
errors, captured provider attribution, and bounded cost under concurrent load.
The benchmark must include a benign flag, a real exfiltration flag, a gate, a
large-ish file, and a semantic-invalid candidate so the validator/repair path
is exercised—not just an easy JSON echo.

No production files were changed by this audit.
