import type { ProviderBinding, ToolResultItem } from '../src/types.js';

export interface FakeToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface FakeResponse {
  toolCalls: FakeToolCall[];
  text: string;
  done: boolean;
}

export type FakeMessage =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; response: FakeResponse }
  | { kind: 'tool_results'; results: ToolResultItem[] };

export const fakeBinding: ProviderBinding<FakeResponse, FakeMessage> = {
  extractToolCalls: (r) =>
    r.toolCalls.map((c) => ({ toolCallId: c.id, toolName: c.name, rawArgs: c.args })),
  isDone: (r) => r.done,
  toAssistantMessage: (r) => ({ kind: 'assistant', response: r }),
  toToolResultMessage: (results) => ({ kind: 'tool_results', results }),
};

/** Returns callModel yielding the scripted responses in order, recording each messages arg. */
export function scriptedModel(responses: FakeResponse[]): {
  callModel: (messages: FakeMessage[]) => Promise<FakeResponse>;
  calls: FakeMessage[][];
} {
  let i = 0;
  const calls: FakeMessage[][] = [];
  return {
    calls,
    callModel: (messages) => {
      calls.push([...messages]);
      const next = responses[i++];
      if (next === undefined) {
        return Promise.reject(new Error('scriptedModel: script exhausted'));
      }
      return Promise.resolve(next);
    },
  };
}

export const finalAnswer = (text: string): FakeResponse => ({ toolCalls: [], text, done: true });
export const toolTurn = (...toolCalls: FakeToolCall[]): FakeResponse => ({
  toolCalls,
  text: '',
  done: false,
});
