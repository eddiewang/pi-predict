# pi-predict

A [Pi](https://pi.dev) extension. When a run of the agent settles, pi-predict
predicts the next message that you will send. It shows the prediction above
the editor, and Tab puts the prediction in the editor. pi-predict never sends
a message; you press Enter.

```text
↳ commit and push  tab
```

Status: experimental (0.x). Each prediction is one more model request, so read
[What it sends and what it costs](#what-it-sends-and-what-it-costs) before
you install it.

## Install

```sh
pi install npm:@eddiewang/pi-predict
# or from a git tag
pi install git:github.com/eddiewang/pi-predict@v0.1.0
# or for one run only
pi -e npm:@eddiewang/pi-predict
```

It needs Pi 0.87.1 or later. CI tests it with Pi 0.87.1 and with the latest
Pi release, on each change and each week.

## How a prediction runs

1. pi-predict keeps a copy of the session's last request as Pi sent it to the
   provider: the messages from `context_with_system` and the payload from
   `before_provider_request`.
2. When the run settles (`agent_settled`), pi-predict checks the skip rules
   (see [Skips](#skips)). Then it sends one request to the session's model:
   the copied messages, the run's final reply, and one instruction message.
3. Before the request leaves, the **prefix guard** compares its payload with
   the copied payload. All request settings must be equal, and the copied
   messages must be a prefix of the new messages. If they are not, pi-predict
   sends nothing. So the provider's prompt cache serves the request.
4. The prediction shows while the branch still ends at the same message. A new
   message, a tree move, a compaction, a new context window, a model change,
   or the end of the session drops it.
5. Your next message gives the outcome: `accepted` (Tab, then sent without a
   change), `edited` (Tab, then changed), `typed` (the same text, typed), or
   `missed`. `/predict stats` shows the counts.

## What it sends and what it costs

Each settled run can cause one extra request to the session's own provider,
with the session id. The request holds the same context as your last request,
the final reply of the agent, and an instruction. The instruction can hold
examples of your earlier replies (see [History](#history)). pi-predict starts
no process and opens no other connection.

With a cache hit, a prediction costs a cache read of the prompt, a cache write
of the new tail, and its output, which is short. With Claude Opus prices ($5
input, $25 output, $0.50 cache read, and $6.25 cache write per million
tokens), that is about $0.09 for a prompt of 114k tokens. A cache miss writes
the whole prompt again: about $0.71 for the same prompt.

These guards limit the cost:

- **Prefix guard.** pi-predict sends nothing when the request does not
  continue the cached prefix.
- **Price cap.** pi-predict skips a prediction when its estimated price is
  above `maxCostPerPrediction` ($0.40). The estimate counts a cache hit, at
  the price tier of the request's size, and the full output cap. A model
  without a cache price pays the input price for the whole prompt. Just
  before the request leaves, pi-predict checks again with the output cap of
  the payload itself. A payload without an output cap counts the model's
  largest output, so a priced model then gets no prediction.
- **Daily budget.** Predictions stop for the day when the predictions of all
  Pi processes cost `dailyBudget` ($10). Each process checks the budget
  before it sends, so the total can pass the budget by one prediction for
  each Pi process. A request that stops before the provider reports its
  usage (for example, because you sent a message first) counts its
  estimate. If pi-predict cannot read its log, it sends nothing; if it
  cannot write the log, it stops until `/predict resume`.
- **Cache pause.** If two predictions in a row read less than
  `minCacheReadRatio` (80%) of their prompt from the cache, the session
  pauses until `/predict resume`. Prompts smaller than 8,192 tokens are not
  checked.

The request keeps the cache key of the session:

- A model with `compat.supportsMidConvoEffort` gets "low" effort in the
  transcript, after the cached prefix. The request keeps its thinking
  settings. The output cap is 2,048 tokens.
- Other models keep the session's thinking level, with an output cap of 8,192
  tokens. When thinking is off, the cap is 2,048 tokens.
- Anthropic models with budget-based thinking get no predictions, because a
  lower output cap changes the cache key.

The prefix guard knows the payloads of these APIs: `anthropic-messages`,
`openai-responses`, `openai-codex-responses`, `azure-openai-responses`, and
`openai-completions`. Models of other APIs get no predictions.

## History

The instruction can hold up to `examples` of your earlier replies to similar
messages of the agent. pi-predict ranks them with BM25 on the end of the
agent's message. A reply from the same project gets a 1.5x weight. An older
reply loses up to half of its weight, with a half-life of 30 days.

- `history: "project"` (the default) uses replies from sessions in the same
  working directory only.
- `"project+short"` also uses replies of 60 characters or less from all
  projects. These replies then go to the provider of the current session.
- `"all"` uses replies from all projects. `"off"` uses none.

After a run that ends in an error or an abort, pi-predict makes no model call.
It offers the reply that most often followed such a stop in your history, if
that reply occurred 3 times or more (for example, "continue").

The index is `<agentDir>/pi-predict/history-v2.json`. Its sources are the
top-level session files in `<agentDir>/sessions`, so subagent transcripts in
subfolders are not read. These are left out:

- sessions in temporary directories
- the live session
- replies that start with `<`
- replies longer than 2,000 characters

The first build starts 5 s after a session starts and reads every session file
once. Later builds read only the lines that each file gained. One builder runs
at a time, by a lock file. On 4.7 GB of session files, the first build took
about 11 s and peaked at about 440 MB RSS. A later refresh took 0.15 s.

## Skips

pi-predict makes no request in these cases:

- predictions are off or paused
- the mode is print or JSON
- pi-subagents reports the session as a child
  (`Symbol.for("pi-subagents:session-status.v1")`)
- Pi is busy or has queued messages
- the editor has a draft
- the run did not end with a normal reply
- the model's API has no prefix check
- the estimated price is above `maxCostPerPrediction`
- the predictions of the day (from all Pi processes) used up `dailyBudget`

## Configuration

`<agentDir>/pi-predict.json`. Every key is optional:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `/predict on` and `/predict off` write it. |
| `display` | `"auto"` | `"auto"`, `"ghost"`, or `"line"`. Ghost text needs an editor suggestion API that stock Pi does not have yet, so `"auto"` shows the line. |
| `history` | `"project"` | Which earlier replies can be examples: `"project"`, `"project+short"`, `"all"`, or `"off"`. |
| `examples` | `6` | The maximum number of examples (0-12). |
| `maxCostPerPrediction` | `0.40` | Dollars. |
| `dailyBudget` | `10` | Dollars per local day. |
| `minCacheReadRatio` | `0.8` | The minimum share of the prompt read from the cache. |

## Command

`/predict` shows the status. The subcommands are `on`, `off`, `now` (predict
even when the editor has a draft), `stats` (today and the last 7 days), and
`resume` (after a cache pause).

## API

Other extensions in the same Pi process can read the predictions:

```ts
const api = globalThis[Symbol.for("pi-predict:api.v1")];
// { version: 1, current(sessionId), subscribe(listener) => unsubscribe }
```

Each state is `{ sessionId, sourceEntryId, state, text, at }`. `state` is
`running`, `completed`, `failed`, or `cleared`. `sourceEntryId` is the message
entry that the prediction continues. Pi also emits each change on `pi.events`
as `predict:updated.v1`.

## Files

pi-predict writes these files:

- `<agentDir>/pi-predict.json` (only `/predict on|off` writes it)
- `<agentDir>/pi-predict/history-v2.json` and `history.lock`
- `<agentDir>/pi-predict/log/YYYY-MM.jsonl`: one line for each prediction (its
  text, usage, cost, and cache-read share) and one line for each outcome. Logs
  older than three months are deleted.

## Limits

- The prefix guard compares with the payload that pi-predict's own
  `before_provider_request` handler sees, and the prediction request does not
  go through the `before_provider_request` handlers of other extensions. An
  extension that changes provider payloads has this effect:
  - If it loads before pi-predict, the guard sees the changed payload. The
    predictions then fail the guard, and pi-predict sends nothing.
  - If it loads after pi-predict, the guard sees the payload before the
    change. A prediction can then pass the guard and still miss the cache.
    The cache pause stops the predictions after two such misses.

  So load such an extension before pi-predict, or turn pi-predict off.
- Some Pi builds have features that stock Pi does not have. pi-predict uses
  them when they are present:
  - pi-ai's `fitImagesToInputLimits`: the prediction leaves out the same
    images as the agent loop.
  - the `session_context_window` event: a new context window drops the
    prediction.
  - an editor suggestion API (`ctx.ui.editorSuggestionVersion === 1`): ghost
    text in the editor. This is not built yet.

## Uninstall

```sh
pi remove npm:@eddiewang/pi-predict
```

Then delete `<agentDir>/pi-predict.json` and `<agentDir>/pi-predict/`.

## Design

[`docs/design.md`](docs/design.md) gives the decisions and the reasons for
them. The idea comes from the composer predictions of OpenAI's Codex; this is
an independent implementation, with no Codex code.

## Development

```sh
npm ci
npm run check   # Biome and tsc
npm test        # Vitest, against the Pi SDK in package-lock.json
npm run smoke   # pack the package, load the tarball in Pi, and find /predict
npm run test:sdk -- <directory with pi-ai.tgz, pi-coding-agent.tgz, pi-tui.tgz>
```

`test:sdk` runs the tests against other Pi SDK builds, for example a fork. The
tests that need a feature of such a build run only there.

[`RELEASING.md`](RELEASING.md) gives the release steps.

## License

MIT
