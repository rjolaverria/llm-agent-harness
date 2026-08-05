# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-08-05

Documentation-only release. The published artifact (`dist/`) is byte-identical
to `0.1.0`; this version exists because npm renders a package's README from its
most recently published version, and the README gained the structured-output
recipe after `0.1.0` was cut.

### Changed

- **Structured output is now documented as a recipe rather than promised as a
  feature.** A typed, validated final answer with model-visible retry is about
  a dozen lines of application code — you own request construction (so your
  provider's native JSON mode is available at full fidelity) and
  `result.lastResponse` is your SDK's own type (so extracting the answer needs
  no abstraction). Building it in would have meant a fifth `ProviderBinding`
  method or a harness-owned tool list; the README now shows the pattern
  instead, in both flavors (validate-the-final-text and final-answer-as-a-tool).
- Non-goals now state that structured output is not a gap, and that token-level
  streaming stays out until there is a concrete reason — replacing the earlier
  "on the post-v1 roadmap" wording for both.

### Added

- Release workflow publishing to npm with provenance via OIDC trusted
  publishing, triggered by a published GitHub release, running the full gate
  (lint, format, typecheck, examples typecheck, test, build) first.

## [0.1.0] - 2026-08-05

Initial release.

### Added

- `runAgent`: the tool loop. Parses tool calls from a provider response,
  validates arguments, executes tools concurrently, folds results back into the
  transcript, and decides when to stop — while your application keeps calling
  the provider SDK directly with its own message and response types.
- `tool()`: tool definitions validated by any
  [Standard Schema](https://standardschema.dev/) validator (Zod, Valibot,
  ArkType, ...), with `execute` arguments typed by inference from the schema.
- `ProviderBinding`: the four-function provider translation contract, and the
  documented API surface of this library. Reference bindings ship as subpath
  exports — `llm-agent-harness/anthropic`, `/openai` (Chat Completions), and
  `/gemini` — each with a `toXTools()` helper for your own request. Provider
  SDKs are type-only optional peer dependencies.
- Model-visible error feedback: invalid tool arguments, unknown tool names, and
  tools that throw all become error tool results the model can react to and
  correct, never exceptions. Bounded by `maxTurns` and a `maxToolErrors` cap so
  a stuck model cannot loop forever.
- Two hooks: `onStep` for per-turn observability, and `beforeToolCall` as the
  guard primitive for human-in-the-loop approval, policy allowlists, and
  dry-run modes. Blocked calls do not count toward `maxToolErrors`.
- Cancellation via `signal`, and transport-failure handling via `retry`, both
  passed through to the underlying loop.
- `result.messages` is always the complete transcript in your provider's own
  types, including the final assistant turn.

### Notes on provider safety

The bindings deliberately do not surface tool calls from a turn that did not
finish as a well-formed tool-call turn (Anthropic `stop_reason` other than
`tool_use`, OpenAI `finish_reason` other than `tool_calls`, Gemini
`finishReason` other than `STOP`). A truncated or filtered response therefore
ends the run for the caller to inspect rather than executing a side-effecting
tool from an incomplete request. For the same reason, an abnormal terminal turn
is folded into the transcript without its unanswered tool-call parts, so
`result.messages` stays replayable as provider history.

[unreleased]: https://github.com/rjolaverria/llm-agent-harness/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/rjolaverria/llm-agent-harness/releases/tag/v0.1.1
[0.1.0]: https://www.npmjs.com/package/llm-agent-harness/v/0.1.0
