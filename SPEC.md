# edgeworks-router - shared contract (Python + TypeScript must behave identically)

The repository root is the router home by default.

## 0. Confirmed API facts (taken from the public Claude API docs as of 2026-09-28; re-check before relying on them)
- Model IDs: Sonnet 5.5 `claude-sonnet-5-5`, Opus 5.5 `claude-opus-5-5`, Haiku 4.5 `claude-haiku-4-5-20251001`, Sonnet 5 `claude-sonnet-5` (possible served fallback).
- Effort: request field `output_config.effort`, values `low|medium|high|xhigh|max`, no beta header. Default: Sonnet 5.5 = `high`, Opus 5.5 = `medium`. Haiku 4.5: effort NOT supported → never send `output_config.effort` to Haiku.
- stop_reason values: `end_turn, max_tokens, stop_sequence, tool_use, pause_turn, refusal, model_context_window_exceeded`. Refusal is HTTP 200.
- Usage fields: `input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens` (input_tokens excludes cached tokens). Response top-level `model` = model that actually produced the message.
- Pricing $/MTok (input / output / 5m cache write / cache read): Sonnet 5.5 2/10/2.50/0.20; Opus 5.5 4/20/5/0.20; Haiku 4.5 1/5/1.25/0.10. Batch = 50% off, stacks with caching.
- Batches: `POST /v1/messages/batches` body `{requests:[{custom_id, params}]}`; custom_id `^[a-zA-Z0-9_-]{1,64}$`; `processing_status`: `in_progress|canceling|ended`; results JSONL lines `{custom_id, result:{type: succeeded|errored|canceled|expired, message?|error?}}`, order NOT guaranteed. Python SDK: `client.messages.batches.create/retrieve/results`. A batched refusal = `succeeded` with `stop_reason:"refusal"`.
- BREAKING on Sonnet 5.5 AND Opus 5.5 (400 invalid_request_error):
  - `tool_choice` `{type:"tool"}` / `{type:"any"}` → fix: `tool_choice:{type:"auto"}` + tool `strict:true` (+ `additionalProperties:false` on every object; max 20 strict tools). The prompt must say when to call the tool.
  - `temperature` != 1.0 → 400; `top_k` any → 400; `top_p` < 0.99 → 400.
  - `thinking:{type:"disabled"}` → use `{type:"between_tools"}`; `thinking:{type:"enabled",budget_tokens}` → use `{type:"adaptive"}`.
  - Assistant prefill (last message role `assistant`) → 400.
  - Thinking is ON by default (adaptive); thinking blocks come back with empty `thinking` text; ALWAYS read content blocks by `type`, never `content[0]`. `max_tokens` covers thinking + text.
- Strict tool schemas (structured outputs) have keyword limitations — implementations should consult the structured-outputs / strict tool use doc page (platform.claude.com/docs/en/build-with-claude/structured-outputs) and strip unsupported keywords (e.g. numeric/string/array bounds if listed as unsupported) from the schema SENT to the API, while the ORIGINAL schema stays in the local `json_schema` validator. Record what is stripped.

## 1. Layout
```
edgeworks-router/
  routing.json            # THE single shared config (both languages read it)
  SPEC.md
  python/  pyproject.toml (console_script `router`), edgeworks_router/, tests/
  ts/      package.json (name "@edgeworks/router"), src/core/ (browser-safe, NO node imports), src/node/ (fs sinks), test/
  shared/fixtures/parity.json   # cross-language parity cases (Section 9), both test suites MUST run it
  logs/router-YYYY-MM.jsonl, logs/payloads/<task_id>.json, logs/verification/, logs/rejections/
```
Env: `EDGEWORKS_ROUTER_HOME` (default = the edgeworks-router root), `EDGEWORKS_ROUTING_JSON` (override config path), `EDGEWORKS_ROUTER_SPEND_CAP_USD` (optional hard cap), `ANTHROPIC_API_KEY` (never print/log/persist). Tests MUST point HOME at a temp dir — never write test lines into the real logs.

## 2. routing.json (exact shape)
```json
{
  "version": 1,
  "models": { "sonnet": "claude-sonnet-5-5", "opus": "claude-opus-5-5", "grader": "claude-haiku-4-5-20251001" },
  "pricing": {
    "sonnet": { "input": 2.00, "output": 10.00, "cache_write_5m": 2.50, "cache_read": 0.20 },
    "opus":   { "input": 4.00, "output": 20.00, "cache_write_5m": 5.00, "cache_read": 0.20 },
    "haiku":  { "input": 1.00, "output": 5.00,  "cache_write_5m": 1.25, "cache_read": 0.10 }
  },
  "model_pricing": {
    "claude-sonnet-5-5": "sonnet", "claude-sonnet-5": "sonnet",
    "claude-opus-5-5": "opus", "claude-haiku-4-5-20251001": "haiku", "claude-haiku-4-5": "haiku"
  },
  "batch_discount": 0.5,
  "defaults": {
    "ladder": [
      { "model": "sonnet", "effort": "high" },
      { "model": "opus",   "effort": "medium" },
      { "model": "opus",   "effort": "xhigh", "critical_only": true }
    ],
    "max_attempts": 3,
    "grader_threshold": 7,
    "retry": { "max_retries": 4, "base_ms": 1000, "max_ms": 30000 },
    "batch_poll_seconds": 30
  },
  "report": { "pin_escalation_rate": 0.40, "pin_window": 50, "medium_pass_rate": 0.95, "medium_window": 100 },
  "pipelines": {
    "<name>": {
      "description": "...",
      "ladder": null,
      "validators": [],
      "grader": { "enabled": false, "threshold": 7, "rubric": "..." },
      "max_attempts": 3,
      "batchable": false,
      "critical": false,
      "pinned_model": null
    }
  }
}
```
`model` in a ladder step is an alias key of `models` (or a literal model id). Unknown served model for pricing → price at the REQUESTED model's alias and add `"pricing_fallback"` to `adaptations`.

Effective ladder = pipeline.ladder ?? defaults.ladder; drop `critical_only` steps unless pipeline.critical; truncate to max_attempts. `pinned_model` set → ladder = `[{model: pinned_model, effort: null}]` (no escalation; effort null = omit field = model API default).

Seed `pipelines` with a `smoke-test` pipeline (validators: `[{"type":"json"},{"type":"required_fields","fields":["ok"]}]`) and a `smoke-force-escalation` pipeline (validators: `[{"type":"custom","name":"fail_on_step_1"}]` — built-in custom validator in BOTH languages that fails iff step==1). Real pipelines are added per project.

## 3. Request adaptation (applied to every outgoing request; each change recorded as a string in `adaptations`)
1. Set `model` and (if effort non-null and model is not Haiku) merge `output_config.effort` into any existing `output_config`.
2. `tool_choice.type` in {`tool`,`any`} → `{type:"auto"}`; mark the named tool (or all tools for `any`) `strict:true`; recursively add `additionalProperties:false` to every object schema; strip unsupported strict keywords (Section 0). adaptation `"forced_tool_use->auto_strict"`.
3. `temperature` present and != 1 → delete (`"temperature_removed"`); `top_k` → delete; `top_p` < 0.99 → delete.
4. `thinking.type=="disabled"` → `{type:"between_tools"}`; `"enabled"` → `{type:"adaptive"}`.
5. Last message role `assistant` → raise a PrefillNotSupported error before sending (do not silently mutate).
6. Never send Anthropic beta headers unless the call site passed them. Header `anthropic-version: 2023-06-01`.
The stored payload (Section 6) is the call-site's ORIGINAL params (pre-adaptation, minus `model`), so a re-run re-applies adaptation.

## 4. Attempt evaluation (in order; first failure = `validation_reason`)
- `stop_reason` in {`max_tokens`,`refusal`,`model_context_window_exceeded`,`pause_turn`} → fail `stop_reason:<value>`.
- Extract: `text` = all `type=="text"` blocks joined with `"\n"`, trimmed; `tool_uses` = `type=="tool_use"` blocks.
- Empty (no text and no tool_use) → fail `empty`.
- Validators run in order over an "output value" (initially `text`):
  - `{"type":"tool_use","name":X}` → requires a tool_use block named X; output value := its `input`. Fail `tool_use_missing:X`.
  - `{"type":"json","extract":"array"|"object"|null}` → strip ``` fences; if extract set, slice from first `[`/`{` to last `]`/`}`; parse; output value := parsed. Fail `json_parse`.
  - `{"type":"json_schema","schema":{...}}` → validate output value with the built-in zero-dependency schema subset (type incl. arrays of types, required, properties, additionalProperties(bool), items, enum, minimum, maximum, minLength, maxLength, minItems, maxItems, pattern). Fail `schema:<json-pointer>:<keyword>`.
  - `{"type":"required_fields","fields":[...]}` (output value must be object, or array of objects → each) fail `required_fields:<name>`.
  - `{"type":"length","min":N,"max":N}` on text chars. Fail `length`.
  - `{"type":"regex","pattern":P,"must_match":true|false}` on text. Fail `regex`.
  - `{"type":"banned_phrases","phrases":[...],"case_insensitive":true}` on text. Fail `banned_phrase:<phrase>`.
  - `{"type":"command","cmd":[...,"{file}"]}` (Node/Python only; not in browser core) → write output to temp file, run, pass iff exit 0. Fail `command_exit:<code>`.
  - `{"type":"custom","name":N}` → in-process registry `name -> fn(output_value, ctx{step, message, text}) -> (ok, reason)`. Unregistered → does NOT fail; appends `custom:<N>:unavailable` to reason and continues (needed for cross-language `reject`).
- Grader: ONLY if `grader.enabled` AND the pipeline has no deterministic validators other than `custom`-unavailable. Call models.grader (Haiku, no effort) with a fixed grader system prompt + pipeline rubric + original user content (text parts only) + candidate text; require JSON `{"score":0-10,"reason":"..."}`. score < threshold → fail `grader:<score>`. Grader call is logged as its own line with `role:"grader"` (cost counted). Grader infra/parse error → attempt passes with `validation_reason:"grader_error:<detail>"` (logged, never silent).
- Attempt score (for best-attempt selection): stop_reason/empty failure = 0; else validators_passed/validators_total (grader score/10 if graded); pass = 1. Ties → the later (higher) step.

## 5. Routing loop
For each step of the effective ladder: send (with infra retry), evaluate. Pass → return. Fail → log `escalated:true` and go to next step. All fail → return best-scoring attempt with `status:"failed_all"` (never throw for validation failures, never silent).
Infra retry (NOT escalation): HTTP 429, 529, 5xx, timeout, network error → retry SAME model up to `max_retries`(4) with delay = min(max_ms, base_ms*2^n) * random(0.5..1.0) full-jitter, honoring `retry-after` header if larger. Exhausted → log a line (`validation_reason:"infra:<code>"`, `final:true`, zero tokens) and raise RouterInfraError. Non-retryable 4xx (400/401/403/404/413/422) → log line `validation_reason:"http_<code>"`, `final:true`, raise RouterRequestError (do not escalate — the request itself is wrong).
Spend cap: if `EDGEWORKS_ROUTER_SPEND_CAP_USD` set, before every live call compute total `cost_usd` of all log lines in logs/ (cache incrementally); if total >= cap raise SpendCapExceeded.
Result object: `{status: "passed"|"escalated_passed"|"failed_all", task_id, final_step, message (raw Message), output (final output value), text, served_model, total_cost_usd, attempts:[{step, model, effort, passed, reason, cost_usd}]}`. Python: sync `route()` + async `aroute()`; accept an injected client (SDK client or fake). TS: `createRouter({config, fetch, sink, apiKey, validators})` + `router.route(pipeline, params, opts)`.

## 6. Logging (one JSONL line per attempt; append-only; UTF-8; file `logs/router-YYYY-MM.jsonl` by UTC month)
Required fields, exact names:
`timestamp` (ISO-8601 UTC, ms, `Z`), `task_id`, `pipeline`, `step` (1-based index into effective ladder), `requested_model`, `served_model`, `effort` (string|null), `input_tokens`, `output_tokens`, `cache_read_tokens` (=usage.cache_read_input_tokens), `cache_write_tokens` (=usage.cache_creation_input_tokens), `cost_usd` (rounded to 6 dp), `latency_ms`, `validation_passed`, `validation_reason` (null if passed w/o note), `escalated`, `final`, `batch`.
Extra fields: `role` ("attempt"|"grader"|"rejection"), `status` (on the final line only), `stop_reason`, `retries`, `model_mismatch` (bool), `human_rejected` (bool), `rejected_task_id` (on reject runs), `adaptations` (array), `lang` ("py"|"ts").
cost_usd = (input*in + output*out + cache_write*cw5m + cache_read*cr)/1e6, × batch_discount if batch, priced by SERVED model via model_pricing.
Payload: before the first send, write `logs/payloads/<task_id>.json` = `{task_id, pipeline, lang, created, params}` (original params minus `model`; no headers/keys). task_id = `<pipeline>-<yyyymmddHHMMSS>-<8 hex>` (safe as batch custom_id after truncation to 64).
Sinks: core supports a pluggable sink `{writeLine(obj), savePayload(id,obj), totalSpend()}`; default Node/Python sink = files above; `noop` sink available (for on-device apps).

## 7. Batch mode
`route_batch(pipeline, items:[{custom_id?, params}])` (pipeline must be `batchable:true` else error). Step 1 → submit one Message Batch; poll `retrieve` every `batch_poll_seconds` until `ended`; stream results; match by custom_id (order not guaranteed); evaluate each with Section 4. Failures (validation fail, refusal, `errored`, `expired`, `canceled`) → resubmit ONLY those as a new batch at the next ladder step; repeat to end of ladder. Every attempt logged with `batch:true` and discounted cost. Items failing every step → `failed_all` with best attempt. Returns list of results in input order. Grader calls (if any) are synchronous non-batch. Payload saved per item.
CLI: `router batch <pipeline> <input.jsonl> [--out results.jsonl]`.

## 8. CLI (Python; `router` console script)
- `router reject <task_id> --reason "..."`: load payload; write a `role:"rejection"` line (`human_rejected:true`, `validation_reason:"human_rejected: <reason>"`, zero tokens); re-run with new task_id `<task_id>-r<N>` starting at the FIRST ladder step whose model is opus (critical step 3 included if critical); all its lines carry `human_rejected:true`, `rejected_task_id`. Print result JSON; save to `logs/rejections/<new_task_id>.json`.
- `router report [--days N]` (default 30): per pipeline: calls (distinct task_ids with a final line), escalation rate (tasks with >1 attempt step / tasks), pass rate per step (passed attempts at step k / attempts at step k), total cost (incl. grader lines), `opus_only_est` = per task: cost of its first opus attempt if any, else its step-1 tokens repriced at opus (same batch discount; grader excluded) — header MUST say "ESTIMATE", savings $ and %, RECOMMENDATION: `PIN TO OPUS` if escalation rate over the last `pin_window` tasks > `pin_escalation_rate`; else `TRY SONNET MEDIUM` if step-1 pass rate over last `medium_window` step-1 attempts > `medium_pass_rate`; else `KEEP`. Show sample size n used for each rule. TOTAL row.
- `router spend`: total cost across all logs (for checking against a spend cap).
- `router batch ...` (Section 7).
TS: expose the same functions programmatically (reject/report may be Python-only CLI; TS must write identical log/payload formats so Python CLI can reject/report TS tasks).

## 9. Parity fixture (write verbatim to shared/fixtures/parity.json; BOTH test suites load it)
Mock responses are Messages API JSON. Expected costs to 6 dp.
```json
{
  "cases": [
    { "name": "pass_step1_with_cache",
      "validators": [{"type":"json"},{"type":"required_fields","fields":["ok"]}],
      "responses": [ {"model":"claude-sonnet-5-5","stop_reason":"end_turn","content":[{"type":"text","text":"{\"ok\":true}"}],"usage":{"input_tokens":1000,"output_tokens":500,"cache_read_input_tokens":2000,"cache_creation_input_tokens":400}} ],
      "expect": {"status":"passed","final_step":1,"lines":[{"step":1,"requested_model":"claude-sonnet-5-5","effort":"high","validation_passed":true,"escalated":false,"final":true,"cost_usd":0.0084}]} },
    { "name": "json_fail_then_opus",
      "validators": [{"type":"json"},{"type":"required_fields","fields":["ok"]}],
      "responses": [
        {"model":"claude-sonnet-5-5","stop_reason":"end_turn","content":[{"type":"text","text":"not json"}],"usage":{"input_tokens":100,"output_tokens":50}},
        {"model":"claude-opus-5-5","stop_reason":"end_turn","content":[{"type":"text","text":"{\"ok\":1}"}],"usage":{"input_tokens":100,"output_tokens":50}} ],
      "expect": {"status":"escalated_passed","final_step":2,"lines":[
        {"step":1,"validation_passed":false,"validation_reason":"json_parse","escalated":true,"final":false,"cost_usd":0.0007},
        {"step":2,"requested_model":"claude-opus-5-5","effort":"medium","validation_passed":true,"escalated":false,"final":true,"cost_usd":0.0014}]} },
    { "name": "max_tokens_escalates",
      "validators": [],
      "responses": [
        {"model":"claude-sonnet-5-5","stop_reason":"max_tokens","content":[{"type":"text","text":"partial"}],"usage":{"input_tokens":10,"output_tokens":10}},
        {"model":"claude-opus-5-5","stop_reason":"end_turn","content":[{"type":"text","text":"done"}],"usage":{"input_tokens":10,"output_tokens":10}} ],
      "expect": {"status":"escalated_passed","final_step":2,"lines":[{"step":1,"validation_reason":"stop_reason:max_tokens","cost_usd":0.00012},{"step":2,"cost_usd":0.00024}]} },
    { "name": "all_fail_best_attempt_is_step1",
      "validators": [{"type":"json"},{"type":"required_fields","fields":["ok"]}],
      "responses": [
        {"model":"claude-sonnet-5-5","stop_reason":"end_turn","content":[{"type":"text","text":"{\"nope\":1}"}],"usage":{"input_tokens":1,"output_tokens":1}},
        {"model":"claude-opus-5-5","stop_reason":"end_turn","content":[{"type":"text","text":"garbage"}],"usage":{"input_tokens":1,"output_tokens":1}} ],
      "expect": {"status":"failed_all","final_step":1,"lines":[{"step":1,"validation_reason":"required_fields:ok"},{"step":2,"validation_reason":"json_parse","final":true}]} },
    { "name": "served_model_mismatch",
      "validators": [],
      "responses": [ {"model":"claude-sonnet-5","stop_reason":"end_turn","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":1000000,"output_tokens":0}} ],
      "expect": {"status":"passed","final_step":1,"lines":[{"requested_model":"claude-sonnet-5-5","served_model":"claude-sonnet-5","model_mismatch":true,"cost_usd":2.0}]} },
    { "name": "batch_discount_cost", "batch": true,
      "validators": [],
      "responses": [ {"model":"claude-sonnet-5-5","stop_reason":"end_turn","content":[{"type":"text","text":"x"}],"usage":{"input_tokens":1000,"output_tokens":1000}} ],
      "expect": {"lines":[{"batch":true,"cost_usd":0.006}]} },
    { "name": "forced_tool_adapted",
      "request": {"max_tokens":100,"messages":[{"role":"user","content":"x"}],"tools":[{"name":"t","input_schema":{"type":"object","properties":{"a":{"type":"string"}},"required":["a"]}}],"tool_choice":{"type":"tool","name":"t"},"temperature":0.2},
      "validators": [{"type":"tool_use","name":"t"},{"type":"required_fields","fields":["a"]}],
      "responses": [ {"model":"claude-sonnet-5-5","stop_reason":"tool_use","content":[{"type":"tool_use","id":"tu1","name":"t","input":{"a":"b"}}],"usage":{"input_tokens":1,"output_tokens":1}} ],
      "expect": {"status":"passed","sent_request":{"tool_choice":{"type":"auto"},"tools[0].strict":true,"tools[0].input_schema.additionalProperties":false,"temperature":"<absent>","output_config.effort":"high"},"lines":[{"adaptations_include":["forced_tool_use->auto_strict","temperature_removed"]}]} }
  ]
}
```
Pipelines for parity cases: default ladder, non-critical, max_attempts 3.
