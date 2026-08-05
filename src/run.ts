import { agentLoop, type AgentLoopAbortSignal, type AgentLoopErrorAction } from 'llm-agent-loop';
import type { ProviderBinding, ToolCallRequest, ToolResultItem } from './types.js';
import { stringifyToolResult, validateToolArgs, type AnyToolDefinition } from './tool.js';

export interface AgentStep<TResponse> {
  turn: number;
  response: TResponse;
  toolCalls: ToolCallRequest[];
  toolResults: ToolResultItem[];
  willStop: boolean;
}

export type BeforeToolCallOutcome = undefined | void | { block: string };

export interface RunAgentOptions<TResponse, TMessage> {
  binding: ProviderBinding<TResponse, TMessage>;
  callModel: (messages: TMessage[]) => Promise<TResponse>;
  tools: readonly AnyToolDefinition[];
  initialMessages: readonly TMessage[];
  /** Maximum model turns before stopping with reason 'max_turns'. Default 10. */
  maxTurns?: number;
  /** Tolerated error tool results per run; one more stops with 'max_tool_errors'. Default 5. */
  maxToolErrors?: number;
  signal?: AgentLoopAbortSignal;
  /** Transport-failure handler for callModel rejections (the loop's onError). Default: 'throw'. */
  retry?: (
    error: unknown,
    info: { attempt: number },
  ) => AgentLoopErrorAction | Promise<AgentLoopErrorAction>;
  onStep?: (step: AgentStep<TResponse>) => void | Promise<void>;
  beforeToolCall?: (call: {
    toolName: string;
    toolCallId: string;
    args: unknown;
  }) => BeforeToolCallOutcome | Promise<BeforeToolCallOutcome>;
}

export type RunAgentReason = 'done' | 'max_turns' | 'max_tool_errors' | 'aborted' | 'error';

export interface RunAgentResult<TResponse, TMessage> {
  /** Complete transcript, final assistant answer included. */
  messages: TMessage[];
  lastResponse: TResponse | undefined;
  reason: RunAgentReason;
  turns: number;
  toolCallsMade: number;
  durationMs: number;
}

interface RunContext<TMessage> {
  messages: TMessage[];
  turn: number;
  toolErrors: number;
  toolCallsMade: number;
  capExceeded: boolean;
}

/**
 * Sentinel thrown by our own llmCaller wrapper to stop the loop after the
 * tool-error cap is exceeded, without spending another model call. Routed to
 * 'stop' by our onError; never escapes runAgent.
 */
class MaxToolErrorsStop extends Error {
  constructor() {
    super('maxToolErrors exceeded');
  }
}

export async function runAgent<TResponse, TMessage>(
  options: RunAgentOptions<TResponse, TMessage>,
): Promise<RunAgentResult<TResponse, TMessage>> {
  const {
    binding,
    callModel,
    tools,
    initialMessages,
    maxTurns = 10,
    maxToolErrors = 5,
    signal,
    retry,
    onStep,
    beforeToolCall,
  } = options;

  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  if (toolsByName.size !== tools.length) {
    throw new Error('runAgent: duplicate tool name in tools array');
  }

  const executeToolCall = async (call: ToolCallRequest): Promise<ToolResultItem> => {
    const base = { toolCallId: call.toolCallId, toolName: call.toolName };

    if (beforeToolCall) {
      const outcome = await beforeToolCall({
        toolName: call.toolName,
        toolCallId: call.toolCallId,
        args: call.rawArgs,
      });
      if (outcome !== undefined && 'block' in outcome) {
        // Intentional block: surfaced to the model as a normal (non-error) result.
        return { ...base, result: outcome.block, isError: false };
      }
    }

    const def = toolsByName.get(call.toolName);
    if (def === undefined) {
      const available = [...toolsByName.keys()].join(', ');
      return {
        ...base,
        result: `Unknown tool "${call.toolName}". Available tools: ${available}`,
        isError: true,
      };
    }

    const validated = await validateToolArgs(def.schema, call.rawArgs);
    if (!validated.ok) {
      return { ...base, result: validated.message, isError: true };
    }

    try {
      const value = await def.execute(validated.value, {
        toolCallId: call.toolCallId,
        ...(signal !== undefined ? { signal } : {}),
      });
      return { ...base, result: stringifyToolResult(value), isError: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...base, result: `Tool "${call.toolName}" failed: ${message}`, isError: true };
    }
  };

  const loopResult = await agentLoop<TResponse, RunContext<TMessage>>({
    initialContext: {
      messages: [...initialMessages],
      turn: 0,
      toolErrors: 0,
      toolCallsMade: 0,
      capExceeded: false,
    },
    maxLoops: maxTurns,
    ...(signal !== undefined ? { signal } : {}),
    llmCaller: (ctx) => {
      if (ctx.capExceeded) {
        throw new MaxToolErrorsStop();
      }
      return callModel(ctx.messages);
    },
    stopCondition: (response) =>
      binding.isDone(response) || binding.extractToolCalls(response).length === 0,
    onError: (error, info) => {
      if (error instanceof MaxToolErrorsStop) {
        return 'stop';
      }
      return retry ? retry(error, { attempt: info.attempt }) : 'throw';
    },
    updateContext: async (response, ctx) => {
      const turn = ctx.turn + 1;
      const toolCalls = binding.extractToolCalls(response);
      const toolResults = await Promise.all(toolCalls.map(executeToolCall));
      const toolErrors = ctx.toolErrors + toolResults.filter((r) => r.isError).length;
      const capExceeded = toolErrors > maxToolErrors;

      const folded = binding.toToolResultMessage(toolResults);
      const messages = [
        ...ctx.messages,
        binding.toAssistantMessage(response),
        ...(Array.isArray(folded) ? folded : [folded]),
      ];

      if (onStep) {
        await onStep({
          turn,
          response,
          toolCalls,
          toolResults,
          willStop: capExceeded || turn >= maxTurns,
        });
      }

      return {
        messages,
        turn,
        toolErrors,
        toolCallsMade: ctx.toolCallsMade + toolCalls.length,
        capExceeded,
      };
    },
  });

  const ctx = loopResult.finalContext;
  let messages = ctx.messages;
  let reason: RunAgentReason;
  let turns = loopResult.iterations;

  switch (loopResult.reason) {
    case 'stop_condition': {
      reason = 'done';
      // The loop does not run updateContext for the terminal response; fold it
      // here so result.messages is always the complete transcript.
      const response = loopResult.lastResponse as TResponse;
      messages = [...ctx.messages, binding.toAssistantMessage(response)];
      if (onStep) {
        await onStep({
          turn: loopResult.iterations,
          response,
          // Reported for observability only — terminal turns never run
          // tools, so any calls extracted here (e.g. from an abnormal finish
          // that happens to carry a tool-call shape) are unexecuted.
          toolCalls: binding.extractToolCalls(response),
          toolResults: [],
          willStop: true,
        });
      }
      break;
    }
    case 'max_loops': {
      reason = 'max_turns';
      break;
    }
    case 'aborted': {
      reason = 'aborted';
      break;
    }
    case 'error': {
      // The iteration that stopped produced no response: don't count it as a turn.
      turns = loopResult.iterations - 1;
      reason = ctx.capExceeded ? 'max_tool_errors' : 'error';
      break;
    }
  }

  return {
    messages,
    lastResponse: loopResult.lastResponse,
    reason,
    turns,
    toolCallsMade: ctx.toolCallsMade,
    durationMs: loopResult.durationMs,
  };
}
