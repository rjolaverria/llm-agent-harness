import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runAgent } from '../src/run.js';
import { tool } from '../src/tool.js';
import { fakeBinding, finalAnswer, scriptedModel, toolTurn, type FakeMessage } from './fake.js';

const echo = tool({
  name: 'echo',
  description: 'Echoes the input back',
  schema: z.object({ text: z.string() }),
  jsonSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  execute: ({ text }) => `echo: ${text}`,
});

const initialMessages: FakeMessage[] = [{ kind: 'user', text: 'hi' }];

describe('runAgent happy path', () => {
  it('executes a tool call, folds results, and stops on the final answer', async () => {
    const { callModel, calls } = scriptedModel([
      toolTurn({ id: 'c1', name: 'echo', args: { text: 'hello' } }),
      finalAnswer('done!'),
    ]);

    const result = await runAgent({
      binding: fakeBinding,
      callModel,
      tools: [echo],
      initialMessages,
    });

    expect(result.reason).toBe('done');
    expect(result.turns).toBe(2);
    expect(result.toolCallsMade).toBe(1);
    expect(result.lastResponse?.text).toBe('done!');

    // Second model call saw: user, assistant(tool call), tool_results.
    expect(calls[1]).toEqual([
      { kind: 'user', text: 'hi' },
      {
        kind: 'assistant',
        response: toolTurn({ id: 'c1', name: 'echo', args: { text: 'hello' } }),
      },
      {
        kind: 'tool_results',
        results: [{ toolCallId: 'c1', toolName: 'echo', result: 'echo: hello', isError: false }],
      },
    ]);

    // Complete transcript: final assistant answer IS folded in.
    expect(result.messages).toHaveLength(4);
    expect(result.messages[3]).toEqual({ kind: 'assistant', response: finalAnswer('done!') });
  });

  it('does not mutate the caller-provided initialMessages array', async () => {
    const { callModel } = scriptedModel([finalAnswer('hi')]);
    const mine: FakeMessage[] = [{ kind: 'user', text: 'hi' }];
    await runAgent({ binding: fakeBinding, callModel, tools: [], initialMessages: mine });
    expect(mine).toHaveLength(1);
  });

  it('treats a response with no tool calls as terminal even when isDone is false', async () => {
    const { callModel } = scriptedModel([{ toolCalls: [], text: 'truncated', done: false }]);
    const result = await runAgent({
      binding: fakeBinding,
      callModel,
      tools: [echo],
      initialMessages,
    });
    expect(result.reason).toBe('done');
    expect(result.turns).toBe(1);
  });

  it('does not execute tools present alongside a done response', async () => {
    let executed = false;
    const spy = tool({
      name: 'spy',
      description: 'records execution',
      schema: z.object({}),
      jsonSchema: { type: 'object' },
      execute: () => {
        executed = true;
        return '';
      },
    });
    const { callModel } = scriptedModel([
      { toolCalls: [{ id: 'c1', name: 'spy', args: {} }], text: 'bye', done: true },
    ]);
    const result = await runAgent({
      binding: fakeBinding,
      callModel,
      tools: [spy],
      initialMessages,
    });
    expect(result.reason).toBe('done');
    expect(executed).toBe(false);
  });

  it('stops with max_turns when the model keeps calling tools', async () => {
    const looping = toolTurn({ id: 'c1', name: 'echo', args: { text: 'again' } });
    const { callModel } = scriptedModel([looping, looping, looping]);
    const result = await runAgent({
      binding: fakeBinding,
      callModel,
      tools: [echo],
      initialMessages,
      maxTurns: 3,
    });
    expect(result.reason).toBe('max_turns');
    expect(result.turns).toBe(3);
    // max_turns transcript is complete: 1 user + 3 × (assistant + tool_results).
    expect(result.messages).toHaveLength(7);
  });

  it('throws on duplicate tool names (programming error)', async () => {
    const { callModel } = scriptedModel([finalAnswer('x')]);
    await expect(
      runAgent({ binding: fakeBinding, callModel, tools: [echo, echo], initialMessages }),
    ).rejects.toThrow(/duplicate tool name/i);
  });
});
