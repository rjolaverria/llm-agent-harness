import { describe, expect, expectTypeOf, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { anthropicBinding, toAnthropicTools } from '../src/anthropic.js';
import { runAgent } from '../src/run.js';
import { tool } from '../src/tool.js';

const toolUseResponse = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-6',
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
  content: [
    { type: 'text', text: 'Let me check.', citations: null },
    { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { location: 'SF' } },
  ],
} as unknown as Anthropic.Message;

const finalResponse = {
  ...toolUseResponse,
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: 'Sunny.', citations: null }],
} as unknown as Anthropic.Message;

const maxTokensWithToolUse = {
  ...toolUseResponse,
  stop_reason: 'max_tokens',
} as unknown as Anthropic.Message;

const refusalWithToolUse = {
  ...toolUseResponse,
  stop_reason: 'refusal',
} as unknown as Anthropic.Message;

const maxTokensToolOnly = {
  ...toolUseResponse,
  stop_reason: 'max_tokens',
  content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { location: 'SF' } }],
} as unknown as Anthropic.Message;

describe('anthropicBinding', () => {
  it('extracts tool_use blocks', () => {
    expect(anthropicBinding.extractToolCalls(toolUseResponse)).toEqual([
      { toolCallId: 'toolu_1', toolName: 'get_weather', rawArgs: { location: 'SF' } },
    ]);
  });

  it('does not extract tool calls when stop_reason is max_tokens, even if a tool_use block is present', () => {
    expect(anthropicBinding.extractToolCalls(maxTokensWithToolUse)).toEqual([]);
  });

  it('does not extract tool calls when stop_reason is refusal, even if a tool_use block is present', () => {
    expect(anthropicBinding.extractToolCalls(refusalWithToolUse)).toEqual([]);
  });

  it('is done on end_turn, not on tool_use', () => {
    expect(anthropicBinding.isDone(finalResponse)).toBe(true);
    expect(anthropicBinding.isDone(toolUseResponse)).toBe(false);
  });

  it('folds the assistant turn preserving content blocks', () => {
    expect(anthropicBinding.toAssistantMessage(toolUseResponse)).toEqual({
      role: 'assistant',
      content: toolUseResponse.content,
    });
  });

  it('drops tool_use blocks when folding an abnormal finish, keeping text blocks', () => {
    expect(anthropicBinding.toAssistantMessage(maxTokensWithToolUse)).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Let me check.', citations: null }],
    });
  });

  it('drops tool_use blocks when folding a refusal, keeping text blocks', () => {
    expect(anthropicBinding.toAssistantMessage(refusalWithToolUse)).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Let me check.', citations: null }],
    });
  });

  it('folds a placeholder text block when an abnormal finish has only tool_use content', () => {
    expect(anthropicBinding.toAssistantMessage(maxTokensToolOnly)).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: '[response truncated]' }],
    });
  });

  it('formats tool results as a single user message with tool_result blocks', () => {
    const msg = anthropicBinding.toToolResultMessage([
      { toolCallId: 'toolu_1', toolName: 'get_weather', result: '72°F', isError: false },
      { toolCallId: 'toolu_2', toolName: 'other', result: 'nope', isError: true },
    ]);
    expect(msg).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: '72°F' },
        { type: 'tool_result', tool_use_id: 'toolu_2', content: 'nope', is_error: true },
      ],
    });
  });

  it('maps tool definitions to Anthropic wire format', () => {
    const t = tool({
      name: 'get_weather',
      description: 'Get weather',
      schema: z.object({ location: z.string() }),
      jsonSchema: { type: 'object', properties: { location: { type: 'string' } } },
      execute: () => '',
    });
    expect(toAnthropicTools([t])).toEqual([
      {
        name: 'get_weather',
        description: 'Get weather',
        input_schema: { type: 'object', properties: { location: { type: 'string' } } },
      },
    ]);
  });

  it('drives a full runAgent round-trip with scripted Anthropic responses', async () => {
    const script = [toolUseResponse, finalResponse];
    let i = 0;
    const weather = tool({
      name: 'get_weather',
      description: 'Get weather',
      schema: z.object({ location: z.string() }),
      jsonSchema: { type: 'object', properties: { location: { type: 'string' } } },
      execute: ({ location }) => `72°F in ${location}`,
    });
    const result = await runAgent({
      binding: anthropicBinding,
      callModel: (messages) => {
        // Type-level: messages must be Anthropic.MessageParam[], inferred from the binding.
        expectTypeOf(messages).toEqualTypeOf<Anthropic.MessageParam[]>();
        return Promise.resolve(script[i++]!);
      },
      tools: [weather],
      initialMessages: [{ role: 'user', content: 'Weather in SF?' }],
    });
    expect(result.reason).toBe('done');
    expect(result.messages).toHaveLength(4); // user, assistant(tool_use), user(tool_result), assistant(final)
    expectTypeOf(result.lastResponse).toEqualTypeOf<Anthropic.Message | undefined>();
  });

  it('treats an abnormal finish carrying a tool_use block as terminal, without executing it', async () => {
    let executed = false;
    const weather = tool({
      name: 'get_weather',
      description: 'Get weather',
      schema: z.object({ location: z.string() }),
      jsonSchema: { type: 'object', properties: { location: { type: 'string' } } },
      execute: ({ location }) => {
        executed = true;
        return `72°F in ${location}`;
      },
    });
    const result = await runAgent({
      binding: anthropicBinding,
      callModel: () => Promise.resolve(maxTokensWithToolUse),
      tools: [weather],
      initialMessages: [{ role: 'user', content: 'Weather in SF?' }],
    });
    expect(executed).toBe(false);
    expect(result.reason).toBe('done');
    expect(result.lastResponse).toBe(maxTokensWithToolUse);
  });
});
