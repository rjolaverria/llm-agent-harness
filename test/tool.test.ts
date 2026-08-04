import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { stringifyToolResult, tool, validateToolArgs } from '../src/tool.js';
import type { ToolContext } from '../src/types.js';

describe('validateToolArgs', () => {
  const schema = z.object({ location: z.string(), days: z.number().optional() });

  it('returns ok with the parsed value for valid args', async () => {
    const result = await validateToolArgs(schema, { location: 'SF' });
    expect(result).toEqual({ ok: true, value: { location: 'SF' } });
  });

  it('returns a readable message listing each issue with its path', async () => {
    const result = await validateToolArgs(schema, { location: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('Invalid arguments');
      expect(result.message).toContain('location');
    }
  });

  it('handles non-object input', async () => {
    const result = await validateToolArgs(schema, 'not an object');
    expect(result.ok).toBe(false);
  });
});

describe('stringifyToolResult', () => {
  it('passes strings through unchanged', () => {
    expect(stringifyToolResult('hello')).toBe('hello');
  });
  it('JSON-stringifies objects', () => {
    expect(stringifyToolResult({ a: 1 })).toBe('{"a":1}');
  });
  it('maps undefined to empty string', () => {
    expect(stringifyToolResult(undefined)).toBe('');
  });
  it('stringifies numbers and booleans', () => {
    expect(stringifyToolResult(3)).toBe('3');
    expect(stringifyToolResult(false)).toBe('false');
  });
});

describe('tool()', () => {
  it('returns the definition unchanged', () => {
    const def = tool({
      name: 'get_weather',
      description: 'Get weather',
      schema: z.object({ location: z.string() }),
      jsonSchema: { type: 'object', properties: { location: { type: 'string' } } },
      execute: ({ location }) => `Sunny in ${location}`,
    });
    expect(def.name).toBe('get_weather');
  });

  it('infers execute args from the schema (type-level)', () => {
    tool({
      name: 't',
      description: 'd',
      schema: z.object({ n: z.number() }),
      jsonSchema: {},
      execute: (args, ctx) => {
        expectTypeOf(args).toEqualTypeOf<{ n: number }>();
        expectTypeOf(ctx).toEqualTypeOf<ToolContext>();
        return '';
      },
    });
  });
});
