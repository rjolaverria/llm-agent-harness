import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runAgent } from '../src/run.js';
import { tool } from '../src/tool.js';
import { fakeBinding, finalAnswer, scriptedModel, toolTurn, type FakeMessage } from './fake.js';

const initialMessages: FakeMessage[] = [{ kind: 'user', text: 'hi' }];

const strict = tool({
  name: 'strict',
  description: 'requires a string',
  schema: z.object({ text: z.string() }),
  jsonSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  execute: ({ text }) => text.toUpperCase(),
});

const boom = tool({
  name: 'boom',
  description: 'always throws',
  schema: z.object({}),
  jsonSchema: { type: 'object' },
  execute: () => {
    throw new Error('kaboom');
  },
});

describe('model-visible error feedback', () => {
  it('feeds validation failures back as isError results and lets the model correct', async () => {
    const { callModel, calls } = scriptedModel([
      toolTurn({ id: 'c1', name: 'strict', args: { text: 42 } }),
      toolTurn({ id: 'c2', name: 'strict', args: { text: 'ok' } }),
      finalAnswer('fixed'),
    ]);
    const result = await runAgent({
      binding: fakeBinding,
      callModel,
      tools: [strict],
      initialMessages,
    });

    expect(result.reason).toBe('done');
    const secondCall = calls[1]!;
    const errorFold = secondCall[2];
    expect(errorFold?.kind).toBe('tool_results');
    if (errorFold?.kind === 'tool_results') {
      expect(errorFold.results[0]).toMatchObject({ toolCallId: 'c1', isError: true });
      expect(errorFold.results[0]!.result).toContain('Invalid arguments');
    }
  });

  it('reports unknown tools by name with the available list', async () => {
    const { callModel, calls } = scriptedModel([
      toolTurn({ id: 'c1', name: 'nope', args: {} }),
      finalAnswer('ok'),
    ]);
    await runAgent({ binding: fakeBinding, callModel, tools: [strict], initialMessages });
    const fold = calls[1]![2];
    if (fold?.kind === 'tool_results') {
      expect(fold.results[0]!.isError).toBe(true);
      expect(fold.results[0]!.result).toContain('Unknown tool "nope"');
      expect(fold.results[0]!.result).toContain('strict');
    }
  });

  it('turns a thrown execute into an isError result containing the message', async () => {
    const { callModel, calls } = scriptedModel([
      toolTurn({ id: 'c1', name: 'boom', args: {} }),
      finalAnswer('ok'),
    ]);
    const result = await runAgent({
      binding: fakeBinding,
      callModel,
      tools: [boom],
      initialMessages,
    });
    expect(result.reason).toBe('done');
    const fold = calls[1]![2];
    if (fold?.kind === 'tool_results') {
      expect(fold.results[0]!.result).toContain('kaboom');
      expect(fold.results[0]!.isError).toBe(true);
    }
  });

  it('stops with max_tool_errors once errors exceed the cap, without another model call', async () => {
    const errorTurn = toolTurn({ id: 'c1', name: 'boom', args: {} });
    const { callModel, calls } = scriptedModel([errorTurn, errorTurn, errorTurn]);
    const result = await runAgent({
      binding: fakeBinding,
      callModel,
      tools: [boom],
      initialMessages,
      maxToolErrors: 1,
    });
    expect(result.reason).toBe('max_tool_errors');
    expect(result.turns).toBe(2); // two real model turns; the stop consumed no model call
    expect(calls).toHaveLength(2);
    // Transcript still contains both error folds.
    expect(result.messages.filter((m) => m.kind === 'tool_results')).toHaveLength(2);
  });

  it('maxToolErrors: 0 stops after the first error turn', async () => {
    const errorTurn = toolTurn({ id: 'c1', name: 'boom', args: {} });
    const { callModel, calls } = scriptedModel([errorTurn, errorTurn]);
    const result = await runAgent({
      binding: fakeBinding,
      callModel,
      tools: [boom],
      initialMessages,
      maxToolErrors: 0,
    });
    expect(result.reason).toBe('max_tool_errors');
    expect(calls).toHaveLength(1);
  });
});
