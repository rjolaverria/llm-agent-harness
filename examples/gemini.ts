// Live smoke example for the Gemini binding. Same weather-tool scenario as
// examples/anthropic.ts. Imports from ../src (not the package name) so
// `npx tsx examples/gemini.ts` works from a clone without a build step
// first — see examples/README.md.
//
// The Gemini binding synthesizes a toolCallId when functionCall.id is absent
// and echoes that same id back in functionResponse.id (see src/gemini.ts).
// This has not been exercised against the live API — running this example
// with a real GEMINI_API_KEY is the empirical check for whether Gemini
// accepts a synthesized functionResponse.id it never issued itself.
//
// Requires: GEMINI_API_KEY (or GOOGLE_API_KEY)
// Run: npx tsx examples/gemini.ts
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { runAgent, tool } from '../src/index.js';
import { geminiBinding, toGeminiTools } from '../src/gemini.js';

const weatherSchema = z.object({ location: z.string() });
const weather = tool({
  name: 'get_weather',
  description: 'Get the current weather for a location.',
  schema: weatherSchema,
  jsonSchema: z.toJSONSchema(weatherSchema),
  execute: ({ location }) => `The weather in ${location} is sunny and 72°F.`,
});

async function main() {
  // The no-arg `new GoogleGenAI()` form only console.warns when no API key is
  // configured and can silently fall through to ambient Google auth (e.g. a
  // gcloud ADC credential) instead of failing — read and check the key
  // ourselves so a missing key fails loudly instead of routing somewhere
  // unexpected.
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (apiKey === undefined) {
    throw new Error('GEMINI_API_KEY (or GOOGLE_API_KEY) must be set to run this example.');
  }
  const client = new GoogleGenAI({ apiKey });

  const result = await runAgent({
    binding: geminiBinding,
    callModel: (messages) =>
      client.models.generateContent({
        model: 'gemini-2.0-flash',
        config: { tools: toGeminiTools([weather]) },
        contents: messages,
      }),
    tools: [weather],
    initialMessages: [{ role: 'user', parts: [{ text: 'What is the weather in San Francisco?' }] }],
  });

  console.log('reason:', result.reason);
  console.log('turns:', result.turns);

  const last = result.messages[result.messages.length - 1];
  const textPart = last?.parts?.find((part) => part.text !== undefined);
  console.log('final text:', textPart?.text ?? last?.parts);

  // A smoke test that never calls the tool proves nothing about the tool
  // loop — fail loudly instead of exiting 0 on a no-op run.
  if (result.reason !== 'done' || result.toolCallsMade === 0) {
    throw new Error(
      `expected the loop to finish 'done' having made at least one tool call, got reason=${result.reason} toolCallsMade=${result.toolCallsMade}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
