import type { AgentLoopAbortSignal } from 'llm-agent-loop';

/** A tool invocation the model requested, normalized only in *envelope* (never message shape). */
export interface ToolCallRequest {
  toolCallId: string;
  toolName: string;
  /** Provider-parsed arguments; bindings decode JSON-string args before handing them over. */
  rawArgs: unknown;
}

/** Outcome of one tool call, fed back to the model via the binding. */
export interface ToolResultItem {
  toolCallId: string;
  toolName: string;
  result: string;
  isError: boolean;
}

/**
 * The provider translation contract — the core of this library. Implementations
 * must be pure: `extractToolCalls` may be called more than once per response.
 */
export interface ProviderBinding<TResponse, TMessage> {
  extractToolCalls(response: TResponse): ToolCallRequest[];
  isDone(response: TResponse): boolean;
  toAssistantMessage(response: TResponse): TMessage;
  toToolResultMessage(results: ToolResultItem[]): TMessage | TMessage[];
}

/** Passed to every tool `execute`. Anything else a tool needs, it closes over. */
export interface ToolContext {
  toolCallId: string;
  signal?: AgentLoopAbortSignal;
}
