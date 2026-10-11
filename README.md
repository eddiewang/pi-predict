# pi-predict

When a run of the agent settles, pi-predict predicts the next message that you
will send. It shows the prediction above the editor, and Tab puts the
prediction in the editor. pi-predict never sends a message; you press Enter.

The design follows Codex's composer predictions: the prediction request uses
the session model and continues the session's own prompt, so the provider's
cache serves it. Plan: `docs/plans/2026-10-10-pi-predict.md` in pi-config.

## How a prediction runs

1. Pi captures the session's last request as it went to the provider: the
   messages from `context_with_system` and the payload from
   `before_provider_request`.
2. On `agent_settled`, pi-predict checks the skip rules. Then it sends one
   request: the captured messages, the run's final reply, and one instruction
   message.
3. Before the request leaves, the **prefix guard** compares its payload with
   the captured payload. All request settings must be equal, and the captured
   messages must be a prefix of the new messages. On a mismatch, pi-predict
   sends nothing.
4. The prediction shows while the branch still ends at the same message. A new
   message, a tree move, a compaction, a new context window, a model change,
   or the session's end drops it.
5. Your next message gives the outcome (`accepted`, `edited`, `typed`, or
   `missed`), which `/predict stats` reports.

Effort: a model with `compat.supportsMidConvoEffort` (the owner's
`claude-opus-5-5`) gets "low" effort in the transcript. This keeps the
request's thinking settings, so the cached prefix stays valid. Other models
keep the session's thinking level. Anthropic models with budget-based thinking
get no predictions, because a lower output cap changes the cache key.

## History

The instruction can include up to `examples` of your earlier replies to
similar agent messages. The default scope is replies from the same project,
plus replies of 60 characters or less from all projects. Pi ranks them with
BM25 on the end of the agent's message, with a 1.5x weight for the same project
and a 30-day recency half-life. After a run that ends in an error or an abort,
pi-predict makes no model call. Instead, it offers the reply that most often
followed such a stop, if that reply occurred at least 3 times (for the owner,
"continue").

The index is `<agentDir>/pi-predict/history-v2.json`. Its sources are the
top-level session files in `<agentDir>/sessions`, so subagent transcripts are
not included. These are left out:

- sessions in temporary directories
- the live session
- replies that start with `<`
- replies longer than 2,000 characters

The build starts 5 s after a session starts. It reads only the lines that each
file gained since the last build. One builder runs at a time, by a lock file. On
the owner's 4.7 GB of sessions, the first build took about 11 s and peaked at
about 440 MB RSS in a standalone Node process. A later refresh took 0.15 s.

## Skips and limits

pi-predict makes no request in these cases:

- predictions are off or paused
- the mode is print or JSON
- the session is a pi-subagents child
- Pi is busy or has queued messages
- the editor has a draft
- the run did not end with a normal reply
- the model's API has no prefix check
- the estimated price is above `maxCostPerPrediction`
- the predictions of the day (from all Pi processes) used up `dailyBudget`

If two predictions in a row read less than `minCacheReadRatio` of their prompt
from the cache, the session pauses until `/predict resume`. Prompts smaller
than 8,192 tokens are not checked.

## Configuration

`<agentDir>/pi-predict.json`. Every key is optional:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `/predict on` and `/predict off` write it. |
| `display` | `"auto"` | `"auto"`, `"ghost"`, or `"line"`. Ghost text needs a later fork API, so `"auto"` shows the line for now. |
| `history` | `"project+short"` | Which past replies can be examples: `"project+short"`, `"project"`, `"all"`, or `"off"`. |
| `examples` | `6` | The maximum number of examples (0-12). |
| `maxCostPerPrediction` | `0.40` | Dollars. |
| `dailyBudget` | `10` | Dollars per local day. |
| `minCacheReadRatio` | `0.8` | The minimum share of the prompt read from the cache. |

The log is `<agentDir>/pi-predict/log/YYYY-MM.jsonl`. Pi deletes logs older
than three months.

## Command and API

- `/predict` shows the status. The subcommands are `on`, `off`, `now`,
  `stats`, and `resume`.
- `globalThis[Symbol.for("pi-predict:api.v1")]` has
  `{ version: 1, current(sessionId), subscribe(listener) }`. Each state is
  `{ sessionId, sourceEntryId, state, text, at }`, and `state` is `running`,
  `completed`, `failed`, or `cleared`. Pi also emits each change on `pi.events`
  as `predict:updated.v1`.

## Constraints

- pi-predict compares with the payload that its own `before_provider_request`
  handler sees. An extension that changes provider payloads must load before
  pi-predict, or the guard checks a payload that the provider did not get.
  Today, no package in the overlay changes payloads.
- pi-predict uses no fork capability yet. Ghost text in the editor will need
  the fork's editor suggestion API (plan unit U4).

## Removal condition

Remove pi-predict if Pi gets native next-message prediction, or if
`accepted` + `edited` is below 20% over 200 shown predictions.
