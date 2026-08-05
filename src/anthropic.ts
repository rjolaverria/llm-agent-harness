// Reference binding for @anthropic-ai/sdk (type-only optional peer dependency).
// ~60 lines — copy it and own it if you'd rather not depend on this subpath.
import type Anthropic from '@anthropic-ai/sdk';
import type { ProviderBinding, ToolResultItem } from './types.js';
import type { AnyToolDefinition } from './tool.js';

export const anthropicBinding: ProviderBinding<Anthropic.Message, Anthropic.MessageParam> = {
  extractToolCalls(response) {
    // Only a stop_reason of 'tool_use' guarantees a well-formed, complete set
    // of tool_use blocks. Other stop reasons (e.g. 'max_tokens', 'refusal')
    // can still carry a tool_use block that is incomplete or unsafe to run.
    if (response.stop_reason !== 'tool_use') {
      return [];
    }
    return response.content
      .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
      .map((block) => ({ toolCallId: block.id, toolName: block.name, rawArgs: block.input }));
  },

  isDone(response) {
    return response.stop_reason === 'end_turn';
  },

  toAssistantMessage(response) {
    // Only a stop_reason of 'tool_use' means every tool_use block in this
    // response was actually extracted and executed (see extractToolCalls
    // above). On any other stop reason, folding a tool_use block into history
    // would leave an unanswered tool call behind — Anthropic rejects that on
    // the next request — so it's filtered out here too, keeping text/other
    // blocks.
    const content =
      response.stop_reason === 'tool_use'
        ? response.content
        : response.content.filter((block) => block.type !== 'tool_use');
    // If an abnormal turn's content was only tool_use blocks, the filter
    // above leaves an empty array — Anthropic rejects empty content on
    // replay. Fall back to a minimal, non-empty text block (Anthropic also
    // rejects empty/whitespace-only text blocks). Never reachable on a
    // normal tool_use turn, since it always has at least one tool_use block.
    const safeContent =
      content.length > 0 ? content : [{ type: 'text' as const, text: '[response truncated]' }];
    return { role: 'assistant', content: safeContent };
  },

  toToolResultMessage(results: ToolResultItem[]) {
    return {
      role: 'user',
      content: results.map((r) => ({
        type: 'tool_result' as const,
        tool_use_id: r.toolCallId,
        content: r.result,
        ...(r.isError ? { is_error: true } : {}),
      })),
    };
  },
};

/** Map harness tool definitions to Anthropic's wire format for your own messages.create call. */
export function toAnthropicTools(tools: readonly AnyToolDefinition[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.jsonSchema as Anthropic.Tool.InputSchema,
  }));
}
