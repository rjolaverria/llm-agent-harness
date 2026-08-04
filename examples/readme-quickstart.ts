// Compiled by tsconfig.examples.json to keep the README's quick-start snippet
// honest — this file must stay byte-for-byte identical to the code block in
// README.md's "Quick start" section.
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
