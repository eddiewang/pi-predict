# pi-predict design

This document gives the decisions behind pi-predict and the reasons for them.
The code comments refer to them as "design D1" to "design D12".

## Goal

When a run of the agent settles, predict the next message that the user will
send. Show the prediction so that one key puts it in the editor. Never send
it.

The design follows the composer predictions of OpenAI's Codex: the session's
own model continues the session's own cached prompt. pi-predict adds examples
of the user's own earlier replies.

## Background

### Codex composer predictions

Source: `openai/codex` at `de8fab6d7a` (2026-10-10).

- Protocol types only (#49480,
  `codex-rs/app-server-protocol/src/protocol/v2/thread_prediction.rs`). The
  request is `thread/prediction/request {threadId, sourceTurnId}`. The
  notification is `thread/prediction/updated {threadId, sourceTurnId, result}`.
  The result is `completed {text?}` or `failed`.
- Prediction forks (#51884). `thread/fork` accepts `experimentalPredictionMode`
  only for an ephemeral fork of a loaded parent, and only without config
  overrides. The fork gets the parent's config, tools, and history. It turns
  on `reasoning_effort_override`, so it can use a different effort with the
  same request prefix. A test checks that the fork's request is equal to the
  parent's next request (`core/tests/suite/reasoning_effort_override.rs`).
- The prediction prompt and the UI are not in the open-source repository.

### Cache rules

- Pi's cache warmer replays "the request exactly as sent". Anthropic's
  budget-based thinking makes `budget_tokens` part of the message cache key
  (`core/cache-warmer.ts` in Pi).
- Anthropic's documentation: a change to `tool_choice`, to the thinking
  settings, or to `output_config.effort` invalidates the messages cache.
- pi-ai can carry the effort in the transcript. For a model with
  `compat.forceAdaptiveThinking` and `compat.supportsMidConvoEffort`, it sets
  the request's effort to "high" for every request and sends the active effort
  as a trailing system message. So a request at a lower effort keeps the
  cached prefix. This is the same idea as Codex's `reasoning_effort_override`.
- A copy of the last request as Pi sent it keeps the cache. In one test on a
  context of about 9k tokens, a side request read 0 tokens from the cache
  without the copy and 9,331 tokens with it.

## Decisions

| # | Decision | Why | Rejected |
|---|---|---|---|
| D1 | Make one direct `ctx.modelRegistry.streamSimple` call: the session model, the session id, a copy of the session's last request, then one instruction message. | A prediction needs no tools and no agent loop. The copy keeps the provider's cache of the session. | A sub-session (`createAgentSession`): it adds a loader, settings, and an agent loop for no gain. A second, cheaper model: it has no cache of the session, so it reads the whole context at full price. |
| D2 | Effort: send "low" when the model has `supportsMidConvoEffort`. Otherwise, send the session's thinking level. | A change to the request-level thinking or effort invalidates Anthropic's messages cache. With `supportsMidConvoEffort`, the effort goes in the transcript, after the prefix. | Always "low": this causes a full cache miss on other models. |
| D3 | `maxTokens` is 2,048 when the effort goes in the transcript or the model does not think, and 8,192 when the prediction keeps the session's thinking level. Anthropic models with budget-based thinking get no prediction. Do not set `toolChoice`. A tool call or the `length` stop reason makes the prediction fail. | Follows the cache warmer's `isReplayable` rule and Anthropic's `tool_choice` rule. With budget-based thinking, the session's `max_tokens` would let the model think up to its whole budget. | A small `maxTokens` with budget thinking: this changes `budget_tokens`, which is part of the cache key. |
| D4 | The prefix guard fails closed. In `onPayload`, compare the prediction's payload with the main payload that `before_provider_request` captured. The settings must be equal, except the fields that only bound the output, and the main messages must be a prefix of the prediction's messages (`cache_control` markers are ignored). On a mismatch, abort and send nothing. Known payloads: `anthropic-messages`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, and `openai-completions`. Other APIs get no predictions. | A cache miss writes the whole prompt again: about $0.70 for 114k tokens and $2.30 for 366k tokens at $6.25 per million cache-write tokens. The check is local and costs nothing. | Measuring `cacheRead` only after the request: this finds a miss only after it is paid. D9 keeps this as a second guard. |
| D5 | Trigger on `agent_settled`. Skip when Pi is not idle, messages are pending, the session is a subagent child, the mode is print or JSON, the editor has a draft, predictions are off, or a cap is reached. | `agent_end` can come before retries, compaction, or queued work. | Trigger on `agent_end`. |
| D6 | The staleness key is the id of the last message entry on the branch (the same idea as Codex's `sourceTurnId`). A prediction shows only while that entry is still the last message. Abort on `input`, `agent_start`, a tree move, a compaction, a new context window, a model change, and shutdown. | Other extensions append `custom` entries after a run. These entries change the leaf but not the conversation. | Key on the leaf id. |
| D7 | After a run that ends in an error or an abort, predict from history only, with no model call. Use the reply that most often followed the same kind of stop, if it occurred 3 times or more. | A model call after a provider error is likely to fail too, and the replies after such a stop are often the same word, such as "continue". | Skip these runs. |
| D8 | History examples: up to 6 earlier pairs of (the end of the agent's message, the user's reply). By default, candidates come from the same working directory. The `"project+short"` scope adds replies of 60 characters or less from all projects. Rank with local BM25. The examples go in the instruction message, after the cached prefix. | BM25 needs no dependency and no extra model call. The examples come after the prefix, so they do not change the cache. Short replies are habits that carry over between projects, but they then leave their project, so the default keeps examples in the project. | Embeddings: these need a dependency or model calls. |
| D9 | Cost guards. (a) Estimate the price before the request from the last usage, and skip above `maxCostPerPrediction` (default $0.40). (b) Stop at `dailyBudget` (default $10) for all Pi processes. (c) If 2 predictions in a row read less than `minCacheReadRatio` (80%) of their prompt from the cache, pause the session's predictions and say so once. | Limits the cost of failures that the prefix guard cannot see, for example a gateway that sends a request to a different upstream account. | No caps. |
| D10 | Display `"auto"`: ghost text when `ctx.ui.editorSuggestionVersion === 1`, and a line above the editor otherwise. The config can force either one. Never show both. | Ghost text is the better experience; the line works with every Pi. | Both at once: they repeat the same text. |
| D11 | Cache parity needs no change to Pi. D1 and D4 give it, and the guard checks it. Ghost text needs an editor suggestion API in Pi's editor. | The guard proves parity locally for each request. | A Pi API that replays the last request: a host change for parity that pi-predict checks without it. |
| D12 | Other extensions and remote clients read predictions through `Symbol.for("pi-predict:api.v1")` and the event `predict:updated.v1` on `pi.events`, keyed by session id. | It mirrors Codex's `thread/prediction/updated`, and it needs no new transport. | New RPC commands in pi-predict. |

## Prediction lifecycle

1. **Capture.** On `context_with_system`, keep the messages and the id of the
   leaf. The next `before_provider_request` payload is the main request as Pi
   sent it; keep it. Cache-warmer replays do not fire `context_with_system`,
   so pi-predict does not capture them.
2. **Trigger.** On `agent_settled`, apply D5. Then start one prediction for
   the id of the last message entry. Use the history path (D7) when the last
   assistant message stopped with `error` or `aborted`.
3. **Build.** The messages are the captured messages, then the messages of
   the entries after them (the final reply), then one user message with the
   instruction and the examples. Where pi-ai has `fitImagesToInputLimits`,
   the prediction leaves out the same images as the agent loop. The options
   are the session model, `sessionId`, the effort of D2, `maxTokens` of D3,
   `onPayload` (the guard), an abort signal, and a 45 s timeout.
4. **Guard.** Apply D4 in `onPayload`. On a mismatch, abort, log
   `prefix_mismatch`, and send nothing. A reply to a request whose provider
   gave no payload to check is not trusted: it fails as `unguarded`.
5. **Parse.** Use the text parts only, not the thinking. Trim the text and
   remove one pair of quotes around it. `<none>` or no text gives `completed`
   with `text: null`. Text longer than 600 characters, a tool call, the
   `length` stop reason, or an error gives `failed`.
6. **Publish.** If the source entry is still the last message, show the
   prediction, update the API state, and emit `predict:updated.v1`.
7. **Outcome.** On the next `input`, compare it with the prediction and log
   the result:
   - `accepted`: the user took the prediction with the key and sent it
     without a change;
   - `edited`: the user took it, then changed it (similarity 0.6 or more);
   - `typed`: the user typed the same text without the key;
   - `missed`: the user sent different text.
8. **After.** Record the usage and the cache-read share. Apply D9(c).

## Instruction message

```text
<next_message_prediction>
Stop the task for a moment. Do not call tools. Predict the next message that the user will send you in
this conversation, after your last reply.

Write it as this user writes: the same language, length, tone, and habits. Many of their replies are
short commands.
Their replies to similar messages in earlier sessions:

- After "…I pushed the branch. Do you want me to open the PR?" they wrote: yes please

Reply with the message only, without quotes. If you cannot predict it with fair confidence, reply with
exactly: <none>
</next_message_prediction>
```

The examples part is present only when there are examples.

## History index

- File: `<agentDir>/pi-predict/history-v2.json`. For each session file, it
  keeps the bytes read (the end of the last complete line), the working
  directory, the reply pairs `{ts, after (400 characters or less), afterStop,
  reply (400 characters or less)}`, and the agent's last message that the next
  reply pairs with. The index keeps at most 20,000 pairs.
- Sources: the top-level `<agentDir>/sessions/*/*.jsonl` files only.
  pi-subagents keeps child transcripts in subfolders, so they are not read.
  These are left out:
  - sessions in temporary directories (`os.tmpdir()`, `/tmp`, `/private/tmp`,
    `/var/folders`);
  - the live session file;
  - replies that start with `<` (injected blocks);
  - replies longer than 2,000 characters (usually pasted logs).
- Build: a background task 5 s after `session_start`, never in the factory.
  Session files are append-only, so a build reads only the complete lines that
  a file gained; a file that became smaller is read again from its start. A
  lock file (`O_EXCL`, stale after 10 minutes) and an atomic rename keep
  concurrent Pi processes safe.
- Query: the last 1,000 characters of the final assistant text. Rank with BM25
  on the `after` text, for pairs whose agent message ended normally. A reply
  from the same project gets a 1.5x weight. An older reply loses up to half of
  its weight, with a half-life of 30 days. Keep the best pair of each reply
  (compared after normalization), then take the top `examples`.

## Display

- **Line**: the widget `pi-predict` above the editor shows `↳ <prediction>
  tab`. It shows only while the editor is empty and the prediction is
  current. A raw-input handler takes Tab only while the line shows, no
  extension UI prompt is open (`ui_prompt_start` and `ui_prompt_end`), and Pi
  is idle. It then calls `setEditorText`. The line never replaces the editor,
  so a custom editor stays.
- **Ghost text** (not built yet): `ctx.ui.setEditorSuggestion(text)` while the
  prediction is current, and `setEditorSuggestion(undefined)` when it becomes
  stale. It needs a Pi build with `ctx.ui.editorSuggestionVersion === 1`.

## API v1

```ts
globalThis[Symbol.for("pi-predict:api.v1")] = {
  version: 1,
  current(sessionId): PredictionState | undefined,
  subscribe(listener: (state: PredictionState) => void): () => void,
};
type PredictionState = {
  sessionId: string;
  sourceEntryId: string;
  state: "running" | "completed" | "failed" | "cleared";
  text: string | null;
  at: number;
};
// Each change is also emitted as pi.events "predict:updated.v1" with the same object.
```

The registry lives on `globalThis`, so `/reload` keeps the listeners of a
reader that loaded earlier.

## Economics

Prices of Claude Opus per million tokens: $5 input, $25 output, $0.50 cache
read, and $6.25 cache write.

- With a cache hit, a prompt of 114k tokens costs about $0.06 for the cache
  read, $0.02 to $0.03 to write the new tail, and $0.01 of output: about
  $0.09. A prompt of 366k tokens costs about $0.21.
- With a cache miss, the same prompts cost about $0.71 and $2.29.
- The author's first 10 predictions (prompts of 44k to 413k tokens) each read
  94.6% to 99.3% of the prompt from the cache. The median latency was 2.2 s,
  and each one cost $0.04 to $0.22.
