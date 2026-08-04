import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runAgent, type AgentStep } from '../src/run.js';
import { tool } from '../src/tool.js';
import {
  fakeBinding,
  finalAnswer,
  scriptedModel,
  toolTurn,
  type FakeMessage,
  type FakeResponse,
} from './fake.js';

const initialMessages: FakeMessage[] = [{ kind: 'user', text: 'hi' }];

const echo = tool({
  name: 'echo',
  description: 'echoes',
  schema: z.object({ text: z.string() }),
  jsonSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  execute: ({ text }) => `echo: ${text}`,
});

describe('beforeToolCall', () => {
  it('blocks execution and surfaces the block string as a non-error result', async () => {
    let executed = false;
    const guarded = tool({
      name: 'guarded',
      description: 'guarded',
      schema: z.object({}),
      jsonSchema: { type: 'object' },
      execute: () => {
        executed = true;
        return 'ran';
      },
    });
    const { callModel, calls } = scriptedModel([
      toolTurn({ id: 'c1', name: 'guarded', args: {} }),
      finalAnswer('ok'),
    ]);
    const result = await runAgent({
      binding: fakeBinding,
      callModel,
      tools: [guarded],
      initialMessages,
      maxToolErrors: 0, // proves blocks don't count toward the cap
      beforeToolCall: () => ({ block: 'User denied the request.' }),
    });
    expect(executed).toBe(false);
    expect(result.reason).toBe('done'); // not max_tool_errors
    const fold = calls[1]![2];
    if (fold?.kind === 'tool_results') {
      expect(fold.results[0]).toMatchObject({
        result: 'User denied the request.',
        isError: false,
      });
    }
  });

  it('supports async guards (awaiting approval)', async () => {
    const { callModel } = scriptedModel([
      toolTurn({ id: 'c1', name: 'echo', args: { text: 'x' } }),
      finalAnswer('ok'),
    ]);
    const result = await runAgent({
      binding: fakeBinding,
      callModel,
      tools: [echo],
      initialMessages,
      beforeToolCall: () => Promise.resolve(undefined), // approve: proceed normally
    });
    expect(result.reason).toBe('done');
    expect(result.toolCallsMade).toBe(1);
  });
});

describe('onStep', () => {
  it('fires once per turn with tool results, and once for the terminal turn', async () => {
    const steps: AgentStep<FakeResponse>[] = [];
    const { callModel } = scriptedModel([
      toolTurn({ id: 'c1', name: 'echo', args: { text: 'a' } }),
      finalAnswer('bye'),
    ]);
    await runAgent({
      binding: fakeBinding,
      callModel,
      tools: [echo],
      initialMessages,
      onStep: (s) => {
        steps.push(s);
      },
    });
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ turn: 1, willStop: false });
    expect(steps[0]!.toolResults[0]!.result).toBe('echo: a');
    expect(steps[1]).toMatchObject({ turn: 2, willStop: true, toolResults: [] });
    expect(steps[1]!.response.text).toBe('bye');
  });
});

describe('concurrency', () => {
  it('runs parallel tool calls concurrently and preserves call order in results', async () => {
    const order: string[] = [];
    const slow = tool({
      name: 'slow',
      description: 'slow',
      schema: z.object({}),
      jsonSchema: { type: 'object' },
      execute: async () => {
        order.push('slow-start');
        await new Promise((r) => setTimeout(r, 20));
        order.push('slow-end');
        return 'slow-done';
      },
    });
    const fast = tool({
      name: 'fast',
      description: 'fast',
      schema: z.object({}),
      jsonSchema: { type: 'object' },
      execute: () => {
        order.push('fast');
        return 'fast-done';
      },
    });
    const { callModel, calls } = scriptedModel([
      toolTurn({ id: 'c1', name: 'slow', args: {} }, { id: 'c2', name: 'fast', args: {} }),
      finalAnswer('ok'),
    ]);
    await runAgent({ binding: fakeBinding, callModel, tools: [slow, fast], initialMessages });
    // fast finished while slow was still sleeping → concurrent.
    expect(order).toEqual(['slow-start', 'fast', 'slow-end']);
    // …but results keep provider call order: c1 first.
    const fold = calls[1]![2];
    if (fold?.kind === 'tool_results') {
      expect(fold.results.map((r) => r.toolCallId)).toEqual(['c1', 'c2']);
    }
  });
});

describe('abort and retry', () => {
  it('resolves aborted when the signal aborts between turns', async () => {
    const controller = new AbortController();
    const { callModel } = scriptedModel([
      toolTurn({ id: 'c1', name: 'echo', args: { text: 'x' } }),
      finalAnswer('never reached'),
    ]);
    const result = await runAgent({
      binding: fakeBinding,
      callModel,
      tools: [echo],
      initialMessages,
      signal: controller.signal,
      onStep: () => {
        controller.abort();
      },
    });
    expect(result.reason).toBe('aborted');
  });

  it('routes transport failures to retry and succeeds on the retried call', async () => {
    let attempts = 0;
    const callModel = (_messages: FakeMessage[]): Promise<FakeResponse> => {
      attempts++;
      if (attempts === 1) {
        return Promise.reject(new Error('rate limited'));
      }
      return Promise.resolve(finalAnswer('recovered'));
    };
    const result = await runAgent({
      binding: fakeBinding,
      callModel,
      tools: [],
      initialMessages,
      retry: (_error, { attempt }) => (attempt < 3 ? 'retry' : 'throw'),
    });
    expect(result.reason).toBe('done');
    expect(result.lastResponse?.text).toBe('recovered');
    expect(attempts).toBe(2);
  });

  it("maps retry 'stop' to reason 'error' without counting a phantom turn", async () => {
    const callModel = (): Promise<FakeResponse> => Promise.reject(new Error('down'));
    const result = await runAgent({
      binding: fakeBinding,
      callModel,
      tools: [],
      initialMessages,
      retry: () => 'stop',
    });
    expect(result.reason).toBe('error');
    expect(result.turns).toBe(0);
  });

  it('rejects the run on transport failure when no retry handler is given', async () => {
    const callModel = (): Promise<FakeResponse> => Promise.reject(new Error('down'));
    await expect(
      runAgent({ binding: fakeBinding, callModel, tools: [], initialMessages }),
    ).rejects.toThrow('down');
  });
});
