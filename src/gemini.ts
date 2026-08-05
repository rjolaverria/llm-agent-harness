// Reference binding for @google/genai (type-only optional peer dependency).
// Copy it and own it if you prefer. Note: functionResponse.response must be an
// object; we wrap results as { result } and errors as { error }.
import type { Content, GenerateContentResponse, Tool } from '@google/genai';
import type { ProviderBinding, ToolResultItem } from './types.js';
import type { AnyToolDefinition } from './tool.js';

function functionCallParts(response: GenerateContentResponse) {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  return parts.filter((part) => part.functionCall !== undefined);
}

export const geminiBinding: ProviderBinding<GenerateContentResponse, Content> = {
  extractToolCalls(response) {
    // Only a finishReason of 'STOP' guarantees a well-formed, complete set of
    // functionCall parts. Other finish reasons (e.g. 'MAX_TOKENS',
    // 'MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL') can still carry a
    // functionCall part that is incomplete or unsafe to run. finishReason is
    // typed as the FinishReason enum, but this binding only imports
    // @google/genai's types (never its runtime value exports), so compare
    // against the string value rather than importing the enum itself.
    const finishReason: string | undefined = response.candidates?.[0]?.finishReason;
    if (finishReason !== 'STOP') {
      return [];
    }
    return functionCallParts(response).map((part, index) => {
      const call = part.functionCall!;
      const name = call.name ?? '';
      return {
        // Gemini ids are optional; synthesize a stable per-response id when absent.
        toolCallId: call.id ?? `${name}-${index}`,
        toolName: name,
        rawArgs: call.args,
      };
    });
  },

  isDone(response) {
    // Gemini reports finishReason STOP even for tool-call turns; the reliable
    // signal is the absence of functionCall parts.
    return functionCallParts(response).length === 0;
  },

  toAssistantMessage(response) {
    const content = response.candidates?.[0]?.content;
    if (content === undefined) {
      // No candidate content at all. Gemini rejects a model turn with zero
      // parts on replay, so fall back to a single non-empty text part
      // instead of an empty parts array.
      return { role: 'model', parts: [{ text: '[response truncated]' }] };
    }

    // Only a finishReason of 'STOP' means every functionCall part in this
    // response was actually extracted and executed (see extractToolCalls
    // above). On any other finish reason, folding a functionCall part into
    // history would leave it dangling/unanswered, so it's filtered out here,
    // keeping text/other parts. If nothing survives the filter (the turn's
    // only content was functionCall parts), fall back to the same
    // non-empty-parts placeholder as the missing-candidate case above.
    const finishReason: string | undefined = response.candidates?.[0]?.finishReason;
    if (finishReason === 'STOP') {
      return content;
    }
    const parts = (content.parts ?? []).filter((part) => part.functionCall === undefined);
    return { ...content, parts: parts.length > 0 ? parts : [{ text: '[response truncated]' }] };
  },

  toToolResultMessage(results: ToolResultItem[]) {
    return {
      role: 'user',
      parts: results.map((r) => ({
        functionResponse: {
          id: r.toolCallId,
          name: r.toolName,
          response: r.isError ? { error: r.result } : { result: r.result },
        },
      })),
    };
  },
};

/** Map harness tool definitions to Gemini's Tool format for your own generateContent call. */
export function toGeminiTools(tools: readonly AnyToolDefinition[]): Tool[] {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parametersJsonSchema: t.jsonSchema,
      })),
    },
  ];
}
