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
    return response.candidates?.[0]?.content ?? { role: 'model', parts: [] };
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
