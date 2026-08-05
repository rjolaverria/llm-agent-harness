# llm-agent-harness

**Keep your provider SDK. Keep your messages. Keep your architecture. Add a correct tool loop.**

## Why

Agent frameworks work great right up until an LLM provider ships something the
framework hasn't caught up with yet — a new request field, a new message
format, a built-in tool, a reasoning control, a caching feature. When that
happens you're stuck waiting for a framework release, working around the
abstraction, or forking it.

The problem isn't framework _size_. It's framework _ownership of the provider
interaction_. This harness avoids that structurally: your application keeps
calling the provider SDK directly — you write `callModel`, you own the
request, you see your SDK's own message and response types. The harness owns
exactly one thing: the generic tool-loop mechanics (parse tool calls, validate
arguments, execute tools, fold results back into history, decide when to
stop). New provider capabilities land in your `callModel` the moment the
provider ships them — no harness release required.

| The application owns               | The harness owns                        |
| ---------------------------------- | --------------------------------------- |
| provider SDK, model invocation     | tool dispatch                           |
| request options                    | argument validation                     |
| retries, authentication, transport | concurrent execution                    |
| provider-specific capabilities     | model-visible error feedback            |
|                                    | transcript updates, stopping conditions |

`llm-agent-harness` builds on [`llm-agent-loop`](https://github.com/rjolaverria/llm-agent-loop),
which stops even lower: `llmCaller`, `stopCondition`, `updateContext`,
`onError`, abort. This package adds exactly the layer every agent framework
provides on top of a loop like that — and where they tend to bury it under
telemetry, middleware, registries, and UI integration.

## Install

```bash
npm install llm-agent-harness
```

You also need your provider's SDK and a [Standard Schema](https://standardschema.dev/)
validator (Zod ≥3.24, Valibot ≥1.0, ArkType ≥2.0, ...) — for example:

```bash
npm install @anthropic-ai/sdk zod
```

Provider SDKs (`@anthropic-ai/sdk`, `openai`, `@google/genai`) are **type-only
optional peer dependencies** of `llm-agent-harness` — they're only required if
you import the corresponding subpath (`llm-agent-harness/anthropic`, etc.), and
even then only for their types. The harness never imports a provider SDK at
runtime.

## Quick start

```ts
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { runAgent, tool } from 'llm-agent-harness';
import { anthropicBinding, toAnthropicTools } from 'llm-agent-harness/anthropic';

const client = new Anthropic();

const weatherSchema = z.object({ location: z.string() });
const weather = tool({
  name: 'get_weather',
  description: 'Get the current weather for a location.',
  schema: weatherSchema,
  jsonSchema: z.toJSONSchema(weatherSchema),
  execute: ({ location }) => `The weather in ${location} is sunny and 72°F.`,
});

const result = await runAgent({
  binding: anthropicBinding,
  callModel: (messages) =>
    client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      tools: toAnthropicTools([weather]),
      messages,
    }),
  tools: [weather],
  initialMessages: [{ role: 'user', content: 'What is the weather in San Francisco?' }],
});

console.log(result.reason, result.messages);
```

`client` is a plain `Anthropic` instance — nothing wraps it. `callModel` is a
function you wrote, calling `client.messages.create` exactly as you would
without this library, with whatever request options you want. `messages` and
`result.messages` are `Anthropic.MessageParam[]` — your SDK's own type, not a
normalized one. The only things `llm-agent-harness` adds are `runAgent`,
`tool()`, and the `anthropicBinding`/`toAnthropicTools` pair that tells the
loop how Anthropic's wire format works.

(This scenario is exercised live in
[`examples/anthropic.ts`](./examples/anthropic.ts) — the same weather-tool
call, wrapped in a runnable `main()` — and every file under `examples/` is
typechecked via `npm run typecheck:examples`
(`tsc -p tsconfig.examples.json --noEmit`), wired into CI. See
[`examples/README.md`](./examples/README.md) to run it yourself.)

## Build a binding from scratch

Shipped bindings are the fastest way to get started, but the documented API
surface of this library — the thing you're actually meant to learn — is the
`ProviderBinding` interface. It's four small, pure functions answering the
four questions that differ per provider:

```ts
interface ProviderBinding<TResponse, TMessage> {
  /** Tool calls requested in this response. */
  extractToolCalls(response: TResponse): ToolCallRequest[];

  /** Model finished with a plain answer — no more tool calls this turn. */
  isDone(response: TResponse): boolean;

  /** Fold this response into history as the assistant turn. */
  toAssistantMessage(response: TResponse): TMessage;

  /** Format executed-tool results for the next request. */
  toToolResultMessage(results: ToolResultItem[]): TMessage | TMessage[];
}
```

`ToolCallRequest` is `{ toolCallId, toolName, rawArgs: unknown }`. `rawArgs`
is provider-parsed — a binding decodes JSON-string arguments (OpenAI does
this) before handing them to you. `ToolResultItem` is
`{ toolCallId, toolName, result: string, isError: boolean }`.

Here is the entire shipped Anthropic binding, `src/anthropic.ts`, unabridged —
about 40 lines once you strip comments:

```ts
import type Anthropic from '@anthropic-ai/sdk';
import type { ProviderBinding, ToolResultItem } from './types.js';
import type { AnyToolDefinition } from './tool.js';

export const anthropicBinding: ProviderBinding<Anthropic.Message, Anthropic.MessageParam> = {
  extractToolCalls(response) {
    if (response.stop_reason !== 'tool_use') {
      return [];
    }
    return response.content
      .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
      .map((block) => ({ toolCallId: block.id, toolName: block.name, rawArgs: block.input }));
  },

  isDone(response) {
    return response.stop_reason === 'end_turn';
  },

  toAssistantMessage(response) {
    return { role: 'assistant', content: response.content };
  },

  toToolResultMessage(results: ToolResultItem[]) {
    return {
      role: 'user',
      content: results.map((r) => ({
        type: 'tool_result' as const,
        tool_use_id: r.toolCallId,
        content: r.result,
        ...(r.isError ? { is_error: true } : {}),
      })),
    };
  },
};

/** Map harness tool definitions to Anthropic's wire format for your own messages.create call. */
export function toAnthropicTools(tools: readonly AnyToolDefinition[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.jsonSchema as Anthropic.Tool.InputSchema,
  }));
}
```

Walking through it:

- **`extractToolCalls`** — gated on `stop_reason === 'tool_use'` first: any
  other stop reason returns `[]` even if a `tool_use` block happens to be
  present, because an abnormal finish (`max_tokens`, `refusal`, ...) can carry
  an incomplete or unsafe tool call that shouldn't be executed. Only once that
  guard passes does it filter `response.content` for `type === 'tool_use'` and
  map each block's `id`/`name`/`input` onto the harness's neutral
  `ToolCallRequest` shape. No parsing needed — Anthropic's `input` is already a
  structured object.
- **`isDone`** — Anthropic sets `stop_reason: 'end_turn'` when the model is
  finished talking. Any other stop reason (`tool_use`, `max_tokens`,
  `stop_sequence`) means "not done" as far as the harness is concerned; the
  loop's own logic (see below) additionally treats "no tool calls extracted"
  as terminal, which — combined with the `extractToolCalls` gate above —
  covers `max_tokens` truncation and other abnormal finishes gracefully
  instead of spinning forever or running an unsafe call.
- **`toAssistantMessage`** — fold the raw response into history exactly as
  Anthropic's own multi-turn API expects it: `{ role: 'assistant', content:
response.content }`, content blocks (text and tool_use) included verbatim.
- **`toToolResultMessage`** — Anthropic wants tool results back as a single
  `user` message containing one `tool_result` content block per call, each
  tagged with the `tool_use_id` it answers and an optional `is_error` flag.
  Returning one message (not an array) is fine — the harness accepts either.

`toAnthropicTools` isn't part of `ProviderBinding` at all; it's a plain helper
mapping `{ name, description, jsonSchema }` to Anthropic's `Tool[]` wire
format, for you to pass to your own `client.messages.create({ tools: ... })`
call. Every shipped binding exports one.

### The three shipped bindings, side by side

The four `ProviderBinding` functions exist because these three things differ
per provider. Once you've read one binding, the others are the same shape
with different plumbing:

|                               | Where tool calls live                                   | How "done" is signaled                                                                                                             | How results go back                                                                                       |
| ----------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Anthropic**                 | `tool_use` blocks in `response.content`                 | `stop_reason === 'end_turn'`                                                                                                       | one `user` message with `tool_result` content blocks (one per call, keyed by `tool_use_id`)               |
| **OpenAI** (Chat Completions) | `message.tool_calls`, arguments as a JSON _string_      | `finish_reason === 'stop'`                                                                                                         | one `role: 'tool'` message per call, keyed by `tool_call_id`                                              |
| **Gemini**                    | `functionCall` parts in the candidate's `content.parts` | _absence_ of `functionCall` parts (Gemini reports `finishReason: STOP` even on tool-call turns, so that field alone is unreliable) | one `user` message with `functionResponse` parts, each wrapping the result as `{ result }` or `{ error }` |

Every shipped binding's `extractToolCalls` is gated on its provider's own
"this is a well-formed tool-call turn" signal (`stop_reason === 'tool_use'`
for Anthropic, `finish_reason === 'tool_calls'` for OpenAI, `finishReason ===
'STOP'` for Gemini) and returns `[]` for anything else, even if a tool-call
shape happens to be present in the response. An abnormal finish therefore
never executes a tool — it becomes a terminal turn (`reason: 'done'`) for the
caller to inspect via `lastResponse`.

Two provider quirks worth calling out because they're easy to miss when
writing your own binding:

- **OpenAI's arguments arrive as a string.** `openaiBinding.extractToolCalls`
  runs `JSON.parse` on `call.function.arguments` before handing `rawArgs` to
  the harness; a parse failure is passed through as the raw string so
  schema validation rejects it visibly instead of the binding swallowing it.
  Relatedly, `toAssistantMessage` folds only `type: 'function'` tool_calls
  into history — the same ones `extractToolCalls`/execution act on — so a
  mixed function-and-custom-tool response never echoes a custom tool_call_id
  that would go unanswered on the next request.
- **Gemini's tool-call `id` is optional.** When Gemini omits
  `functionCall.id`, `geminiBinding` synthesizes a `name-index` id per call
  and echoes it back in the matching `functionResponse.id`. This is accepted
  by the typed API (`id` is an optional field) but has not yet been verified
  against live Gemini responses — treat it as a reasonable guess, not a
  documented contract.

### Shipped bindings are sugar — the interface is the product

None of this is special. `anthropicBinding`, `openaiBinding`, and
`geminiBinding` are reference implementations, not a walled garden. If your
provider isn't one of the three, or you'd rather not add a type-only peer
dependency, or you disagree with a detail of how one of them formats
messages: **copy the ~100 lines and own them.** The `ProviderBinding`
interface — four pure functions, no client, no HTTP, no types of its own — is
the actual documented surface of this library. The shipped bindings' source
doubles as their own documentation; reading this section _is_ reading the
binding.

## API reference

### `runAgent(options)`

```ts
const result = await runAgent({
  binding, // ProviderBinding<TResponse, TMessage>
  callModel, // (messages: TMessage[]) => Promise<TResponse>
  tools, // ToolDefinition[]
  initialMessages, // TMessage[]
  maxTurns, // number, default 10
  maxToolErrors, // number, default 5
  signal, // AbortSignal, optional
  retry, // (error, { attempt }) => 'retry' | 'stop' | 'throw', optional
  onStep, // per-turn observability callback, optional
  beforeToolCall, // tool-call guard hook, optional
});
```

| Option            | Type                                                   | Default         | Notes                                                                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `binding`         | `ProviderBinding<TResponse, TMessage>`                 | —               | Required. Also single-sources the types of `callModel` and `result.messages` — pass `anthropicBinding` and both are typed as Anthropic's own types, no casts.                                                                                                          |
| `callModel`       | `(messages: TMessage[]) => Promise<TResponse>`         | —               | Required. Your provider call, in full — request options, model choice, and retries/auth/transport are entirely yours.                                                                                                                                                  |
| `tools`           | `ToolDefinition[]`                                     | —               | Required. Duplicate tool names throw synchronously (a harness-level programming error, never swallowed).                                                                                                                                                               |
| `initialMessages` | `TMessage[]`                                           | —               | Required. The starting transcript, in your provider's own message format.                                                                                                                                                                                              |
| `maxTurns`        | `number`                                               | `10`            | Maximum model turns before the run stops with `reason: 'max_turns'`.                                                                                                                                                                                                   |
| `maxToolErrors`   | `number`                                               | `5`             | Tolerated error tool results across the whole run; one more than this stops the run with `reason: 'max_tool_errors'`. See below for what counts.                                                                                                                       |
| `signal`          | `AbortSignal`                                          | —               | Forwarded to the underlying loop. If aborted, the run resolves with `reason: 'aborted'` (never throws). It does **not** interrupt an in-flight `callModel` — forward it into your own request (e.g. `fetch`'s `signal`) if you want the network call itself cancelled. |
| `retry`           | `(error, { attempt }) => 'retry' \| 'stop' \| 'throw'` | rejects the run | Handles `callModel` rejections (transport failures) only — this is `llm-agent-loop`'s `onError` under the hood. Return `'retry'` to call the model again, `'stop'` to end the run with `reason: 'error'`, or `'throw'` to re-raise.                                    |
| `onStep`          | `(step) => void \| Promise<void>`                      | —               | Per-turn observability; see below.                                                                                                                                                                                                                                     |
| `beforeToolCall`  | `(call) => void \| { block: string } \| Promise<...>`  | —               | The one guard hook, called before every tool execution; see below.                                                                                                                                                                                                     |

#### Result

```ts
{
  messages: TMessage[];          // complete transcript, final answer included
  lastResponse: TResponse | undefined;
  reason: 'done' | 'max_turns' | 'max_tool_errors' | 'aborted' | 'error';
  turns: number;
  toolCallsMade: number;
  durationMs: number;
}
```

`messages` is always the complete transcript, including the final assistant
answer — the harness folds the terminal turn in itself, so you never have to
special-case "the last response isn't in the array yet."

`reason` values:

- `'done'` — the model produced a plain answer (`binding.isDone` was true, or
  no tool calls were extracted at all — which also covers abnormal finishes
  like `max_tokens` truncation or a refused/filtered response that happened to
  carry a tool-call shape; shipped bindings only extract tool calls from a
  well-formed tool-call turn, so any other finish reason ends the run here
  too; inspect `lastResponse` to tell these cases apart).
- `'max_turns'` — `maxTurns` was reached before the model finished.
- `'max_tool_errors'` — more than `maxToolErrors` tool calls came back as
  errors across the run.
- `'aborted'` — `signal` fired.
- `'error'` — `retry` returned `'stop'` for a `callModel` rejection. This is
  the only path that produces `'error'`.

### `tool(def)`

```ts
function tool<TSchema extends StandardSchemaV1>(def: {
  name: string;
  description: string;
  schema: TSchema; // any Standard Schema validator
  jsonSchema: Record<string, unknown>; // what goes on the wire to the provider
  execute: (
    args: StandardSchemaV1.InferOutput<TSchema>, // fully typed, no casts
    ctx: { toolCallId: string; signal?: AbortSignal },
  ) => unknown | Promise<unknown>;
}): ToolDefinition<TSchema>;
```

- `schema` is any [Standard Schema](https://standardschema.dev/) validator —
  Zod ≥3.24, Valibot ≥1.0, ArkType ≥2.0 all comply natively, with no adapter
  needed. `execute`'s `args` parameter is inferred from it directly.
- `jsonSchema` is **explicit and required**, separate from `schema`. Standard
  Schema is a validation contract, not a schema-description format — it
  carries no JSON Schema, and generating one from an arbitrary validator would
  mean depending on a specific one. For Zod v4 this is a one-liner:
  `jsonSchema: z.toJSONSchema(schema)`. This keeps the harness at zero runtime
  dependencies except `llm-agent-loop` (plus the types-only
  `@standard-schema/spec`, which ships as a regular `dependencies` entry so
  consumers' TypeScript can resolve the `StandardSchemaV1` types our own
  `dist/*.d.ts` reference, but contributes no runtime code), at the cost of
  one explicit field.
- `execute`'s return value: a `string` passes through untouched; `undefined`
  becomes `''`; anything else is `JSON.stringify`'d. Thrown errors never
  escape — see the error-handling table below.
- `ctx` is deliberately minimal: `{ toolCallId, signal }`, where `signal` is
  the run's own `AbortSignal` (if you passed one to `runAgent`) so a
  long-running tool can cancel cooperatively. Anything else a tool needs, it
  closes over.

### `onStep`

```ts
onStep?: (step: {
  turn: number;
  response: TResponse;
  toolCalls: ToolCallRequest[];
  toolResults: ToolResultItem[];
  willStop: boolean;
}) => void | Promise<void>;
```

Called once per turn, after tool execution for that turn has completed (on
the final, tool-call-free turn, `toolCalls` and `toolResults` are both empty
and `willStop` is `true`). Use it for logging, tracing, or token accounting.
If it returns a promise, the run awaits it before continuing.

### `beforeToolCall`

```ts
beforeToolCall?: (call: { toolName: string; toolCallId: string; args: unknown }) =>
  | void                 // proceed
  | { block: string }    // skip execution; the string becomes the tool result
                          //   the model sees (isError: false — does not count
                          //   toward maxToolErrors, blocks are intentional)
  | Promise<void | { block: string }>;
```

This is the one hook the harness needs, because tool execution is the only
black box it introduces — everything else (model calls, history, settings)
you already control via `callModel`. It's the primitive for human-in-the-loop
approval, policy allowlists, dry-run modes, and audit-with-veto. An approval
gate looks like this:

```ts
const result = await runAgent({
  // ...
  beforeToolCall: async ({ toolName, args }) => {
    if (toolName !== 'delete_file') return; // no approval needed

    const approved = await askUserToApprove(`Delete ${(args as { path: string }).path}?`);
    if (!approved) {
      return { block: 'User denied the request.' };
    }
    // fall through — implicit `return;` proceeds with execution
  },
});
```

Deliberately out of scope for this hook: mutating arguments (the validation
feedback path — an error result the model can self-correct from — is the
mechanism for wrong args, not silent rewriting) and an `afterToolCall`
counterpart (that's what `onStep` is for).

### Error handling

None of the tool-call failure modes below throw out of `runAgent` — they all
become a model-visible tool result so the model can see what happened (and,
for validation and unknown-tool errors, usually self-correct):

| Failure                                                          | Behavior                                                                                                                                |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `callModel` rejects (transport)                                  | Routed to `retry` (the loop's `onError`); default is to reject the run.                                                                 |
| Model sends invalid tool arguments                               | Error tool result with the Standard Schema issues, formatted readably; **counts toward `maxToolErrors`**.                               |
| Model calls an unknown tool name                                 | Error tool result naming the available tools; **counts toward `maxToolErrors`**.                                                        |
| Tool `execute` throws                                            | Error tool result with the thrown error's message; **counts toward `maxToolErrors`**.                                                   |
| `beforeToolCall` returns `{ block }`                             | Non-error tool result (the block string); **does not count** toward `maxToolErrors` — blocks are intentional, not failures.             |
| `signal` aborts                                                  | The run resolves with `reason: 'aborted'` (never throws); forward the signal into `callModel` yourself to cut off an in-flight request. |
| Binding or harness programming error (e.g. duplicate tool names) | Throws. Never swallowed.                                                                                                                |

`maxToolErrors` (default `5`) exists to stop infinite error ping-pong between
the model and the harness: it's a per-run cap across the three counted cases
above, combined. Exceed it and the run stops immediately with
`reason: 'max_tool_errors'` instead of burning another model call.

## Shipped bindings

Each provider binding lives behind its own subpath, so importing one doesn't
pull the other providers' types into your build:

```ts
import { anthropicBinding, toAnthropicTools } from 'llm-agent-harness/anthropic';
import { openaiBinding, toOpenAITools } from 'llm-agent-harness/openai';
import { geminiBinding, toGeminiTools } from 'llm-agent-harness/gemini';
```

| Subpath                       | Binding                            | Tools helper              | Peer dependency     |
| ----------------------------- | ---------------------------------- | ------------------------- | ------------------- |
| `llm-agent-harness/anthropic` | `anthropicBinding`                 | `toAnthropicTools(tools)` | `@anthropic-ai/sdk` |
| `llm-agent-harness/openai`    | `openaiBinding` (Chat Completions) | `toOpenAITools(tools)`    | `openai`            |
| `llm-agent-harness/gemini`    | `geminiBinding`                    | `toGeminiTools(tools)`    | `@google/genai`     |

The corresponding provider SDK is a **type-only, optional** peer dependency:
`llm-agent-harness` never imports it at runtime (`import type` only), so
these subpaths add zero runtime weight beyond the types. You need the SDK
installed as a real dependency in your own app regardless, since you're the
one calling `client.messages.create` / `client.chat.completions.create` /
`client.models.generateContent`.

Each `toXTools(tools)` helper maps your `tool()` definitions' `{ name,
description, jsonSchema }` to that provider's wire format for the `tools`
field of your own request — nothing more.

## Relationship to `llm-agent-loop`

`llm-agent-harness` is built on top of
[`llm-agent-loop`](https://github.com/rjolaverria/llm-agent-loop), unmodified
— `runAgent` drives `agentLoop` underneath, mapping `callModel` to
`llmCaller`, `maxTurns` to `maxLoops`, and folding tool dispatch into
`updateContext`/`stopCondition`. `llm-agent-loop` is the actual dependency
(zero dependencies of its own); this package adds only the tool-loop layer
described above.

If you don't need tool calling at all — or want to hand-roll your own
tool-dispatch logic instead of using this harness's — depend on
`llm-agent-loop` directly. It's the smaller, more general primitive, and
everything here is built from public pieces of it.

## Non-goals

This library intentionally does not do the following (see `docs/design.md`
for the full rationale):

- **Provider abstraction / normalized messages.** Refusing this is the point
  of the design — you always see your provider's own types.
- **Telemetry, middleware, registries, UI helpers, RAG, handoffs, MCP,
  evals.** Out of scope; compose them yourself around `callModel` and
  `onStep`.
- **Dependency-injection context for tools.** Tools close over what they
  need instead.
- **A tool-approval subsystem.** `beforeToolCall` is the primitive; build
  policy on top of it.
- **Structured output** and **streaming text deltas** — both are on the
  post-v1 roadmap (additive; per-turn `onStep` observability exists from day
  one, ahead of streaming).
