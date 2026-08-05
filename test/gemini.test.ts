import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Content, GenerateContentResponse } from '@google/genai';
import { z } from 'zod';
import { geminiBinding, toGeminiTools } from '../src/gemini.js';
import { runAgent } from '../src/run.js';
import { tool } from '../src/tool.js';

function response(parts: unknown[], finishReason = 'STOP'): GenerateContentResponse {
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason, index: 0 }],
  } as unknown as GenerateContentResponse;
}

const toolCallResponse = response([
  { functionCall: { id: 'fc_1', name: 'get_weather', args: { location: 'SF' } } },
]);
const finalResponse = response([{ text: 'Sunny.' }]);

const maxTokensWithFunctionCall = response(
  [{ functionCall: { id: 'fc_1', name: 'get_weather', args: { location: 'SF' } } }],
  'MAX_TOKENS',
);

const malformedFunctionCall = response(
  [{ functionCall: { id: 'fc_1', name: 'get_weather', args: { location: 'SF' } } }],
  'MALFORMED_FUNCTION_CALL',
);

describe('geminiBinding', () => {
  it('extracts functionCall parts', () => {
    expect(geminiBinding.extractToolCalls(toolCallResponse)).toEqual([
      { toolCallId: 'fc_1', toolName: 'get_weather', rawArgs: { location: 'SF' } },
    ]);
  });

  it('does not extract tool calls when finishReason is MAX_TOKENS, even if a functionCall part is present', () => {
    expect(geminiBinding.extractToolCalls(maxTokensWithFunctionCall)).toEqual([]);
  });

  it('does not extract tool calls when finishReason is MALFORMED_FUNCTION_CALL, even if a functionCall part is present', () => {
    expect(geminiBinding.extractToolCalls(malformedFunctionCall)).toEqual([]);
  });

  it('synthesizes a stable id when functionCall.id is missing', () => {
    const noId = response([{ functionCall: { name: 'get_weather', args: {} } }]);
    const [call] = geminiBinding.extractToolCalls(noId);
    expect(call!.toolCallId).toBe('get_weather-0');
  });

  it('is done exactly when there are no functionCall parts', () => {
    expect(geminiBinding.isDone(finalResponse)).toBe(true);
    expect(geminiBinding.isDone(toolCallResponse)).toBe(false);
  });

  it('folds the assistant turn as the candidate content', () => {
    const msg = geminiBinding.toAssistantMessage(toolCallResponse);
    expect(msg.role).toBe('model');
    expect(msg.parts).toHaveLength(1);
  });

  it('formats tool results as functionResponse parts in one user message', () => {
    const msg = geminiBinding.toToolResultMessage([
      { toolCallId: 'fc_1', toolName: 'get_weather', result: '72°F', isError: false },
      { toolCallId: 'fc_2', toolName: 'x', result: 'failed', isError: true },
    ]) as Content;
    expect(msg.role).toBe('user');
    expect(msg.parts).toEqual([
      { functionResponse: { id: 'fc_1', name: 'get_weather', response: { result: '72°F' } } },
      { functionResponse: { id: 'fc_2', name: 'x', response: { error: 'failed' } } },
    ]);
  });

  it('maps tool definitions to a functionDeclarations Tool', () => {
    const t = tool({
      name: 'get_weather',
      description: 'Get weather',
      schema: z.object({ location: z.string() }),
      jsonSchema: { type: 'object', properties: { location: { type: 'string' } } },
      execute: () => '',
    });
    const [geminiTool] = toGeminiTools([t]);
    expect(geminiTool!.functionDeclarations).toHaveLength(1);
    expect(geminiTool!.functionDeclarations![0]!.name).toBe('get_weather');
  });

  it('drives a full runAgent round-trip with scripted Gemini responses', async () => {
    const script = [toolCallResponse, finalResponse];
    let i = 0;
    const weather = tool({
      name: 'get_weather',
      description: 'Get weather',
      schema: z.object({ location: z.string() }),
      jsonSchema: { type: 'object', properties: { location: { type: 'string' } } },
      execute: ({ location }) => `72°F in ${location}`,
    });
    const result = await runAgent({
      binding: geminiBinding,
      callModel: (messages) => {
        expectTypeOf(messages).toEqualTypeOf<Content[]>();
        return Promise.resolve(script[i++]!);
      },
      tools: [weather],
      initialMessages: [{ role: 'user', parts: [{ text: 'Weather in SF?' }] }],
    });
    expect(result.reason).toBe('done');
    expect(result.messages).toHaveLength(4);
  });
});
