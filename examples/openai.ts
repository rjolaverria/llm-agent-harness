// Live smoke example for the OpenAI binding (Chat Completions API). Same
// weather-tool scenario as examples/anthropic.ts. Imports from ../src (not
// the package name) so `npx tsx examples/openai.ts` works from a clone
// without a build step first — see examples/README.md.
//
// Requires: OPENAI_API_KEY
// Run: npx tsx examples/openai.ts
import OpenAI from 'openai';
import { z } from 'zod';
import { runAgent, tool } from '../src/index.js';
import { openaiBinding, toOpenAITools } from '../src/openai.js';

const weatherSchema = z.object({ location: z.string() });
const weather = tool({
  name: 'get_weather',
  description: 'Get the current weather for a location.',
  schema: weatherSchema,
  jsonSchema: z.toJSONSchema(weatherSchema),
  execute: ({ location }) => `The weather in ${location} is sunny and 72°F.`,
});

async function main() {
  const client = new OpenAI();

  const result = await runAgent({
    binding: openaiBinding,
    callModel: (messages) =>
      client.chat.completions.create({
        model: 'gpt-4o',
        tools: toOpenAITools([weather]),
        messages,
      }),
    tools: [weather],
    initialMessages: [{ role: 'user', content: 'What is the weather in San Francisco?' }],
  });

  console.log('reason:', result.reason);
  console.log('turns:', result.turns);

  const last = result.messages[result.messages.length - 1];
  console.log('final text:', last?.content);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
