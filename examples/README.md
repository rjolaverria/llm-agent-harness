# Examples

Live smoke scripts, one per supported provider. Each drives the same
weather-tool scenario end to end against the real API: a model call, a tool
call, tool execution, and a follow-up model call that answers using the tool
result.

These hit real, paid APIs. **They are never run in CI** — CI only typechecks
this directory (see below); running any of these scripts costs you API
credits and requires a real key.

## Import style

The `examples/` scripts import from the local source (`../src/index.js`,
`../src/anthropic.js`, etc.) so `npx tsx examples/<file>.ts` works straight
from a clone with no build step; this differs from the README's quick-start
snippet, which uses the published package name (`llm-agent-harness`) because
that snippet is written for consumers who installed from npm.

## Running

Each script requires the matching provider's API key as an environment
variable and fails fast with a clear auth error if it's missing.

```bash
# Anthropic — requires ANTHROPIC_API_KEY
npx tsx examples/anthropic.ts

# OpenAI — requires OPENAI_API_KEY
npx tsx examples/openai.ts

# Gemini — requires GEMINI_API_KEY (or GOOGLE_API_KEY)
npx tsx examples/gemini.ts
```

Each script prints the run's stop `reason`, the number of model `turns`, and
the final text response.

## Typechecking

CI (and the local gate) typechecks this directory without running anything:

```bash
npm run typecheck:examples
```

This runs `tsc -p tsconfig.examples.json --noEmit` over `src/` and
`examples/` together, so the examples always compile against the current
source.
