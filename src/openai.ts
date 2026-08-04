// Reference binding for the openai package, Chat Completions API
// (type-only optional peer dependency). Copy it and own it if you prefer.
import type OpenAI from 'openai';
import type { ProviderBinding, ToolResultItem } from './types.js';
import type { AnyToolDefinition } from './tool.js';

/** JSON-parse tool arguments; on failure return the raw string so schema validation rejects it visibly. */
function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/**
 * openai@7's `ChatCompletionMessageToolCall` is a union of function-tool and
 * custom-tool calls (only function tools carry a JSON `arguments` string).
 * This harness only speaks the function-tool wire format, so custom-tool
 * calls are filtered out via this type guard.
 */
function isFunctionToolCall(
  call: OpenAI.ChatCompletionMessageToolCall,
): call is OpenAI.ChatCompletionMessageFunctionToolCall {
  return call.type === 'function';
}

export const openaiBinding: ProviderBinding<
  OpenAI.ChatCompletion,
  OpenAI.ChatCompletionMessageParam
> = {
  extractToolCalls(response) {
    const toolCalls = response.choices[0]?.message.tool_calls ?? [];
    return toolCalls.filter(isFunctionToolCall).map((call) => ({
      toolCallId: call.id,
      toolName: call.function.name,
      rawArgs: parseArguments(call.function.arguments),
    }));
  },

  isDone(response) {
    return response.choices[0]?.finish_reason === 'stop';
  },

  toAssistantMessage(response) {
    const message = response.choices[0]?.message;
    return {
      role: 'assistant',
      content: message?.content ?? null,
      ...(message?.tool_calls ? { tool_calls: message.tool_calls } : {}),
    };
  },

  toToolResultMessage(results: ToolResultItem[]) {
    // OpenAI has no is_error flag; the result text itself carries the error message.
    return results.map((r) => ({
      role: 'tool' as const,
      tool_call_id: r.toolCallId,
      content: r.result,
    }));
  },
};

/** Map harness tool definitions to OpenAI's wire format for your own chat.completions.create call. */
export function toOpenAITools(tools: readonly AnyToolDefinition[]): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.jsonSchema },
  }));
}
