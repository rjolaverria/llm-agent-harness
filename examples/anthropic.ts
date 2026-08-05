// Live smoke example for the Anthropic binding. Mirrors the scenario in
// README.md's "Quick start" section, but imports from ../src (not the
// package name) so `npx tsx examples/anthropic.ts` works from a clone
// without a build step first, and adds a main()/console.log wrapper so it's
// runnable end to end. See examples/README.md for the import-style rationale.
//
// Requires: ANTHROPIC_API_KEY
// Run: npx tsx examples/anthropic.ts
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { runAgent, tool } from '../src/index.js';
import { anthropicBinding, toAnthropicTools } from '../src/anthropic.js';

const client = new Anthropic();

const weatherSchema = z.object({ location: z.string() });
const weather = tool({
  name: 'get_weather',
  description: 'Get the current weather for a location.',
  schema: weatherSchema,
  jsonSchema: z.toJSONSchema(weatherSchema),
  execute: ({ location }) => `The weather in ${location} is sunny and 72°F.`,
});

async function main() {
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

  console.log('reason:', result.reason);
  console.log('turns:', result.turns);

  const last = result.messages[result.messages.length - 1];
  const textBlock =
    last && Array.isArray(last.content)
      ? last.content.find((block) => block.type === 'text')
      : undefined;
  console.log('final text:', textBlock?.text ?? last?.content);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
