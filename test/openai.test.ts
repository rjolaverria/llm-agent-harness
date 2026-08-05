import { describe, expect, expectTypeOf, it } from 'vitest';
import type OpenAI from 'openai';
import { z } from 'zod';
import { openaiBinding, toOpenAITools } from '../src/openai.js';
import { runAgent } from '../src/run.js';
import { tool } from '../src/tool.js';

function completion(message: Record<string, unknown>, finishReason: string): OpenAI.ChatCompletion {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-4o',
    choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
  } as unknown as OpenAI.ChatCompletion;
}

const toolCallResponse = completion(
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"location":"SF"}' },
      },
    ],
  },
  'tool_calls',
);

const finalResponse = completion({ role: 'assistant', content: 'Sunny.' }, 'stop');

const lengthWithToolCalls = completion(
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"location":"SF"}' },
      },
    ],
  },
  'length',
);

const contentFilterWithToolCalls = completion(
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"location":"SF"}' },
      },
    ],
  },
  'content_filter',
);

describe('openaiBinding', () => {
  it('extracts tool calls and JSON-parses the string arguments', () => {
    expect(openaiBinding.extractToolCalls(toolCallResponse)).toEqual([
      { toolCallId: 'call_1', toolName: 'get_weather', rawArgs: { location: 'SF' } },
    ]);
  });

  it('does not extract tool calls when finish_reason is length, even if tool_calls are present', () => {
    expect(openaiBinding.extractToolCalls(lengthWithToolCalls)).toEqual([]);
  });

  it('does not extract tool calls when finish_reason is content_filter, even if tool_calls are present', () => {
    expect(openaiBinding.extractToolCalls(contentFilterWithToolCalls)).toEqual([]);
  });

  it('passes unparseable argument strings through for validation to reject', () => {
    const bad = completion(
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{oops' } },
        ],
      },
      'tool_calls',
    );
    const [call] = openaiBinding.extractToolCalls(bad);
    expect(call!.rawArgs).toBe('{oops'); // schema validation will produce the model-visible error
  });

  it('is done on finish_reason stop, not tool_calls', () => {
    expect(openaiBinding.isDone(finalResponse)).toBe(true);
    expect(openaiBinding.isDone(toolCallResponse)).toBe(false);
  });

  it('handles empty choices as done-with-no-calls', () => {
    const empty = { ...finalResponse, choices: [] } as unknown as OpenAI.ChatCompletion;
    expect(openaiBinding.extractToolCalls(empty)).toEqual([]);
  });

  it('folds the assistant message preserving content and tool_calls', () => {
    const msg = openaiBinding.toAssistantMessage(toolCallResponse);
    expect(msg).toMatchObject({ role: 'assistant', content: null });
    expect((msg as { tool_calls: unknown[] }).tool_calls).toHaveLength(1);
  });

  it('folds only function tool_calls into the assistant message, dropping custom tool_calls', () => {
    const mixed = completion(
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"location":"SF"}' },
          },
          { id: 'call_2', type: 'custom', custom: { name: 'shell', input: 'ls' } },
        ],
      },
      'tool_calls',
    );
    const msg = openaiBinding.toAssistantMessage(mixed) as { tool_calls?: unknown[] };
    expect(msg.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"location":"SF"}' },
      },
    ]);
  });

  it('folds a placeholder content string when finish_reason is length and content is only tool_calls', () => {
    const msg = openaiBinding.toAssistantMessage(lengthWithToolCalls) as { tool_calls?: unknown[] };
    expect(msg).not.toHaveProperty('tool_calls');
    expect(msg).toEqual({ role: 'assistant', content: '[response truncated]' });
  });

  it('folds a placeholder content string when finish_reason is content_filter and content is only tool_calls', () => {
    const msg = openaiBinding.toAssistantMessage(contentFilterWithToolCalls) as {
      tool_calls?: unknown[];
    };
    expect(msg).not.toHaveProperty('tool_calls');
    expect(msg).toEqual({ role: 'assistant', content: '[response truncated]' });
  });

  it('omits tool_calls entirely when the only calls present are custom', () => {
    const customOnly = completion(
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_2', type: 'custom', custom: { name: 'shell', input: 'ls' } }],
      },
      'tool_calls',
    );
    const msg = openaiBinding.toAssistantMessage(customOnly) as { tool_calls?: unknown[] };
    expect(msg).not.toHaveProperty('tool_calls');
  });

  it('formats tool results as one role:tool message per call', () => {
    const msgs = openaiBinding.toToolResultMessage([
      { toolCallId: 'call_1', toolName: 'get_weather', result: '72°F', isError: false },
      { toolCallId: 'call_2', toolName: 'x', result: 'failed', isError: true },
    ]);
    expect(msgs).toEqual([
      { role: 'tool', tool_call_id: 'call_1', content: '72°F' },
      { role: 'tool', tool_call_id: 'call_2', content: 'failed' },
    ]);
  });

  it('maps tool definitions to OpenAI wire format', () => {
    const t = tool({
      name: 'get_weather',
      description: 'Get weather',
      schema: z.object({ location: z.string() }),
      jsonSchema: { type: 'object', properties: { location: { type: 'string' } } },
      execute: () => '',
    });
    expect(toOpenAITools([t])).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: { location: { type: 'string' } } },
        },
      },
    ]);
  });

  it('drives a full runAgent round-trip with scripted OpenAI responses', async () => {
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
      binding: openaiBinding,
      callModel: (messages) => {
        expectTypeOf(messages).toEqualTypeOf<OpenAI.ChatCompletionMessageParam[]>();
        return Promise.resolve(script[i++]!);
      },
      tools: [weather],
      initialMessages: [{ role: 'user', content: 'Weather in SF?' }],
    });
    expect(result.reason).toBe('done');
    // user, assistant(tool_calls), tool, assistant(final)
    expect(result.messages).toHaveLength(4);
  });
});
