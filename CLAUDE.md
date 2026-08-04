# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

`llm-agent-harness` is a minimal tool-loop harness for LLM agents — the missing layer between a provider SDK and a full agent framework. The application keeps calling its provider SDK directly, with the provider's own native types; the harness owns only the generic tool-loop mechanics: tool dispatch, argument validation, concurrent execution, model-visible error feedback, transcript updates, and stopping conditions.

```
your app          — provider client, model choice, prompts, tool implementations
llm-agent-harness — tool(), runAgent(), ProviderBinding + reference bindings  ← this repo
llm-agent-loop    — agentLoop / agentLoopStream (dependency)
provider SDK      — types + HTTP; the app calls it, the harness never does
```

Positioning: "Keep your provider SDK. Keep your messages. Keep your architecture. Add a correct tool loop." It is **not** a smaller replacement for agent frameworks and must never grow toward one. The full design rationale lives in `docs/design.md`.

## Non-Negotiable Design Constraints

- **Zero runtime dependencies except `llm-agent-loop`.** Provider SDKs are type-only optional peer dependencies; `@standard-schema/spec` is types-only. Never add a runtime dependency without explicit discussion.
- **Provider-native types end to end.** No normalized message shape, no wrapper types, ever. The core is generic over `TResponse`/`TMessage`; inference is single-sourced from the `ProviderBinding`.
- **The `ProviderBinding` interface is the product; shipped bindings are sugar.** Bindings (`src/anthropic.ts`, `src/openai.ts`, `src/gemini.ts`) are reference implementations exposed as subpath exports. Keep each small (~100–150 lines) and copyable — their source doubles as documentation. Docs teach building a binding first, shipped bindings second.
- **The harness never performs network calls.** `callModel` belongs to the application.
- **Model-visible error feedback.** Invalid tool args, unknown tools, and thrown `execute` functions become `isError` tool results the model can react to — they never throw. Programming errors always throw.
- **Exactly two hooks** (`onStep`, `beforeToolCall`). New hooks need a reason the caller can't achieve through `callModel` ownership.
- Scope discipline: structured output, streaming deltas, telemetry, MCP, approval subsystems, and DI-for-tools are explicitly out of scope for v1 (see the non-goals and roadmap in `docs/design.md`).

## Commands

```bash
npm run build         # compile with tsc into dist/
npm test              # vitest run (once)
npm run test:watch    # vitest watch mode
npm run coverage      # vitest with coverage
npm run typecheck     # tsc --noEmit
npm run lint          # ESLint
npm run format        # Prettier write
npm run format:check  # Prettier check (CI)
```

The pre-commit hook runs `lint-staged` (ESLint + Prettier auto-fix on staged files).

## Architecture

Single package, ESM, published to npm. Layout:

```
src/
  index.ts       # runAgent, tool(), public types (ProviderBinding, ToolCallRequest, ...)
  tool.ts        # tool() helper + Standard Schema validation
  run.ts         # generic tool loop, driving agentLoop underneath
  anthropic.ts   # subpath export: llm-agent-harness/anthropic
  openai.ts      # subpath export: llm-agent-harness/openai (Chat Completions)
  gemini.ts      # subpath export: llm-agent-harness/gemini
```

Subpath exports are wired in `package.json` `exports` so importing one binding never pulls in another provider's SDK types.

## Library Documentation

**Before writing code that calls a library, fetch up-to-date documentation for it.** Training-data knowledge of library APIs is frequently stale or version-skewed, and writing against remembered APIs produces hallucinated calls that waste a fix-and-retry loop. This matters doubly here: bindings encode exact provider SDK response/message shapes, and those SDKs change fast.

### When to fetch

Required:

- adding a new dependency (including type-only peer deps) to `package.json`
- writing or modifying a binding — verify the provider SDK's current response/message types against the pinned version
- writing code that imports or calls into an existing dependency you have not already read in the current session
- generating examples, snippets, or scaffolds that mention a specific library
- debugging an error that originates inside a library

Exempt — training-data knowledge is reliable enough; skip the fetch unless behaviour is suspect:

- the Node.js standard library (`node:fs`, `path`, etc.)
- existing in-repo usage patterns — follow what's already wired up
- trivial well-known calls (`JSON.parse`, `Array.from`, etc.)

Always reconcile what you fetch against the version pinned in `package.json` / the lockfile. If the docs describe a newer API than the installed version, downgrade your code to match the installed version, or upgrade the dependency in a separate, intentional commit.

### Sources, in order of preference

1. **Context7 MCP** — `resolve-library-id` to find the library, `query-docs` to fetch (pin `/org/project/version` when the installed version matters).
2. **Context Hub (`chub` CLI)** — `chub search <query>`, `chub get <pkg>/<topic>` when Context7 doesn't cover the library well.
3. **WebSearch / WebFetch** — against the canonical source (the project's own docs site or repo), not blog posts.
4. **Local `node_modules`** — offline fallback that exactly matches the installed version: the package's `README.md`, `**/*.d.ts`, and `package.json` `exports`.

Confirm availability before using each source and fall through to the next when one isn't wired up.

If a fetched doc materially shaped the implementation, cite the specific page or doc ID in the commit message or PR description. Routine confirmation lookups don't need citation.

## Code Style

Prettier: single quotes, 100-char print width (matches `llm-agent-loop`). ESLint uses `typescript-eslint` with type-aware rules. `strict: true` TypeScript, ESM throughout.

Always use curly braces on every block statement (`if`, `for`, `while`, etc.) — never braceless single-line bodies.

Do not reference PR review comments, reviewers, or review threads inside code comments. PR-review context belongs in the commit message or PR thread reply, not in the source. Code comments should explain the code on its own terms.

## Functions and State

Prefer pure functions. The core loop should hold state in local variables of the run, not module-level state.

Validation happens at exactly one boundary: model-supplied tool arguments, via each tool's Standard Schema. Inside the system, pass regular typed TypeScript objects — do not re-validate data that is already typed. Never import a specific validator library (Zod, Valibot); the harness only calls `schema['~standard'].validate`.

Use discriminated unions when modelling variants (e.g. tool outcomes as success vs error vs blocked), not single interfaces with optional fields.

## Tests

Write a test for every function that contains non-trivial logic. Skip tests that would only verify what TypeScript or ESLint already enforce statically.

- **No live API calls in CI, ever.** Core logic is tested against an in-repo fake binding; each shipped binding gets a fixture-driven simulation suite using recorded response shapes (tool-call turn, final turn, parallel calls, JSON-string args, invalid args, unknown tool, error feedback round-trip).
- **Type-level tests** (`expectTypeOf`) cover arg inference from schemas and binding → `callModel`/result inference — typed DX is half the product, so inference regressions are test failures.
- Live smoke examples live in `examples/`, one per provider, run manually with real keys.

## Task Workflow

While working:

- Keep each unit of work to its own set of commits. Do not bundle multiple unrelated changes into one commit.
- If you discover follow-up work that is out of scope for the current change, track it separately rather than expanding the current change.
- Design documents under `docs/` are working notes — do not commit them unless explicitly asked. The canonical project/design doc lives in Notion.

A change is **only** complete when **all** of the following are true:

1. New and existing tests pass: `npm test` is green.
2. Type checking passes: `npm run typecheck` is green.
3. Linting passes: `npm run lint` is green.
4. Formatting passes: `npm run format:check` is green.
5. The pre-commit hook ran successfully on the final commit (never bypass it with `--no-verify`).
6. The work is committed (and pushed, if the branch is shared).

A green typecheck alone is not "done" — the manual acceptance criteria for the change must also be verified.

## PR Review Comments

Always reply to PR review comments after addressing them. After making the change (or deciding not to), post a reply on the comment thread that says what you did — e.g. the commit SHA that fixed it, or why you pushed back. Do not silently resolve threads; reviewers should be able to see the response without having to diff the branch themselves. If a comment can't be acted on or you disagree, still reply with the reasoning.
