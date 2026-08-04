import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ToolContext } from './types.js';

export interface ToolDefinition<TSchema extends StandardSchemaV1 = StandardSchemaV1> {
  name: string;
  description: string;
  /** Any Standard Schema validator (Zod >=3.24, Valibot >=1.0, ArkType >=2.0, ...). */
  schema: TSchema;
  /**
   * JSON Schema sent to the provider. Standard Schema does not carry one, so it
   * is explicit; for Zod v4 use `jsonSchema: z.toJSONSchema(schema)`.
   */
  jsonSchema: Record<string, unknown>;
  // Method syntax (not arrow-property) is deliberate: it gets bivariant parameter
  // checking, which lets ToolDefinition<ConcreteSchema> flow into AnyToolDefinition.
  execute(args: StandardSchemaV1.InferOutput<TSchema>, ctx: ToolContext): unknown;
}

/** Any tool, regardless of schema — the element type of `runAgent`'s `tools` array. */
export type AnyToolDefinition = ToolDefinition<StandardSchemaV1>;

/** Identity helper that pins TSchema so `execute` args infer from `schema`. */
export function tool<TSchema extends StandardSchemaV1>(
  def: ToolDefinition<TSchema>,
): ToolDefinition<TSchema> {
  return def;
}

export type ValidateResult = { ok: true; value: unknown } | { ok: false; message: string };

/** Validate model-supplied args. Failures come back as a model-readable message, never a throw. */
export async function validateToolArgs(
  schema: StandardSchemaV1,
  rawArgs: unknown,
): Promise<ValidateResult> {
  const result = await schema['~standard'].validate(rawArgs);
  if (result.issues) {
    const lines = result.issues.map((issue) => {
      const path = (issue.path ?? [])
        .map((seg) =>
          typeof seg === 'object' && seg !== null && 'key' in seg ? String(seg.key) : String(seg),
        )
        .join('.');
      return path === '' ? `- ${issue.message}` : `- ${path}: ${issue.message}`;
    });
    return { ok: false, message: `Invalid arguments:\n${lines.join('\n')}` };
  }
  return { ok: true, value: result.value };
}

/** Strings pass through; undefined becomes ''; everything else is JSON.stringify'd. */
export function stringifyToolResult(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined) {
    return '';
  }
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return JSON.stringify(value) ?? String(value);
}
