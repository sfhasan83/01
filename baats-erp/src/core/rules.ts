/**
 * Business rules engine (Phase 1 subset): declarative conditions over a flat
 * attribute map. Used by ABAC grant conditions and by workflow step conditions.
 *
 *   { "amount": { "gt": 10000, "lte": 50000 }, "currency": { "in": ["AED","USD"] }, "country": "AE" }
 *
 * A bare value means equality. All keys must match (AND). "any" holds a list of
 * condition objects of which at least one must match (OR). A missing attribute
 * fails every operator except { "exists": false }, so rules fail closed.
 */
export type Condition = Record<string, unknown>;

const OPS = new Set(['eq', 'ne', 'in', 'nin', 'lt', 'lte', 'gt', 'gte', 'exists']);

export function validateCondition(c: unknown, path = 'condition'): string[] {
  if (c === null || typeof c !== 'object' || Array.isArray(c)) return [`${path} must be an object`];
  const errors: string[] = [];
  for (const [key, spec] of Object.entries(c)) {
    if (key === 'any') {
      if (!Array.isArray(spec) || spec.length === 0) errors.push(`${path}.any must be a non-empty array`);
      else spec.forEach((s, i) => errors.push(...validateCondition(s, `${path}.any[${i}]`)));
      continue;
    }
    if (spec !== null && typeof spec === 'object' && !Array.isArray(spec)) {
      for (const [op, v] of Object.entries(spec)) {
        if (!OPS.has(op)) errors.push(`${path}.${key}: unknown operator "${op}"`);
        else if ((op === 'in' || op === 'nin') && !Array.isArray(v)) errors.push(`${path}.${key}.${op} must be an array`);
        else if (['lt', 'lte', 'gt', 'gte'].includes(op) && typeof v !== 'number') errors.push(`${path}.${key}.${op} must be a number`);
      }
    }
  }
  return errors;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}

function test(op: string, actual: unknown, expected: unknown): boolean {
  if (op === 'exists') return (actual !== undefined && actual !== null) === Boolean(expected);
  if (actual === undefined || actual === null) return false;
  switch (op) {
    case 'eq': return actual === expected;
    case 'ne': return actual !== expected;
    case 'in': return (expected as unknown[]).includes(actual);
    case 'nin': return !(expected as unknown[]).includes(actual);
  }
  const a = num(actual);
  const b = expected as number;
  if (a === undefined) return false;
  switch (op) {
    case 'lt': return a < b;
    case 'lte': return a <= b;
    case 'gt': return a > b;
    case 'gte': return a >= b;
  }
  return false;
}

export function matches(c: Condition | null | undefined, attrs: Record<string, unknown>): boolean {
  if (!c) return true;
  for (const [key, spec] of Object.entries(c)) {
    if (key === 'any') {
      if (!(spec as Condition[]).some((s) => matches(s, attrs))) return false;
      continue;
    }
    const actual = attrs[key];
    if (spec !== null && typeof spec === 'object' && !Array.isArray(spec)) {
      for (const [op, expected] of Object.entries(spec)) if (!test(op, actual, expected)) return false;
    } else if (!test('eq', actual, spec)) {
      return false;
    }
  }
  return true;
}
