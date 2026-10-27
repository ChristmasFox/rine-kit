/*
 * A comparable shape of a JSON Schema: what a model can send and what is refused (property names, required, types,
 * enums, bounds, strictness), without descriptions or the dialect's spelling. Lab describes its tools with TypeBox,
 * the shared catalogue with zod; both reduce to this form so a drift in either shows as a diff.
 */
type Json = Record<string, unknown>;

const KEEP = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern'];

export function schemaShape(schema: unknown): unknown {
  if (typeof schema !== 'object' || schema === null) return schema;
  const s = schema as Json;
  const out: Json = {};
  const enumValues = Array.isArray(s.enum) ? s.enum : 'const' in s ? [s.const] : undefined;
  if (enumValues) out.enum = [...enumValues].sort();
  else if (typeof s.type === 'string') out.type = s.type === 'number' && s.multipleOf === 1 ? 'integer' : s.type;
  for (const key of KEEP) if (key in s) out[key] = s[key];
  if (s.properties && typeof s.properties === 'object') {
    out.properties = Object.fromEntries(
      Object.entries(s.properties as Json)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, schemaShape(v)]),
    );
    out.required = Array.isArray(s.required) ? [...(s.required as string[])].sort() : [];
    out.additionalProperties = s.additionalProperties === false ? false : true;
  }
  if (s.items) out.items = schemaShape(s.items);
  const union = (s.anyOf ?? s.oneOf) as unknown[] | undefined;
  if (union) {
    const shapes = union.map(schemaShape) as Json[];
    // TypeBox spells an enum as a union of one-value literals, zod as one enum: both mean the same thing.
    if (shapes.every((shape) => Array.isArray(shape.enum) && Object.keys(shape).length === 1)) {
      out.enum = shapes.flatMap((shape) => shape.enum as unknown[]).sort();
    } else {
      out.anyOf = shapes.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
  }
  return out;
}
