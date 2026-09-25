/**
 * JSON Schema subset validator (engine-spec §2): type, const, enum, required, properties,
 * additionalProperties:false, items, minItems, pattern, minimum, maximum.
 * That is every keyword the shipped schemas use.
 */
export function validate(schema: any, value: unknown, at = "$"): string[] {
  const errs: string[] = [];
  if (schema.const !== undefined && value !== schema.const) errs.push(`${at}: must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at}: must be one of ${schema.enum.map((v: unknown) => JSON.stringify(v)).join(", ")}`);
  if (schema.type) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => isType(value, t))) {
      errs.push(`${at}: expected ${types.join(" or ")}, got ${typeName(value)}`);
      return errs;
    }
  }
  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${at}: must match /${schema.pattern}/`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${at}: must be ≥ ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${at}: must be ≤ ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${at}: needs at least ${schema.minItems} item(s)`);
    if (schema.items) value.forEach((v, i) => errs.push(...validate(schema.items, v, `${at}[${i}]`)));
  } else if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const r of schema.required ?? []) if (!(r in obj)) errs.push(`${at}: missing required "${r}"`);
    for (const [k, v] of Object.entries(obj)) {
      const sub = schema.properties?.[k];
      if (sub) errs.push(...validate(sub, v, `${at}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${at}: unknown property "${k}"`);
    }
  }
  return errs;
}

function isType(v: unknown, t: string): boolean {
  switch (t) {
    case "null":
      return v === null;
    case "array":
      return Array.isArray(v);
    case "object":
      return v !== null && typeof v === "object" && !Array.isArray(v);
    case "integer":
      return Number.isInteger(v);
    case "number":
      return typeof v === "number";
    default:
      return typeof v === t;
  }
}

function typeName(v: unknown): string {
  return v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
}
