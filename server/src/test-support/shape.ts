/** A runtime description of a JSON value's shape, for conformance tests of API responses. */
export type Shape =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | { nullable: Shape }
  | { array: Shape }
  | { record: Shape }
  | { oneOf: readonly string[] }
  /** An object with exactly these keys, or at least these when `open`. */
  | { object: Record<string, Shape>; open?: true };

/** Every way `value` departs from `shape` (empty when it conforms); keys must all be present. */
export function violations(value: unknown, shape: Shape, path = '$'): string[] {
  const bad = (why: string) => [`${path}: ${why}`];
  if (typeof shape === 'string') {
    const ok =
      shape === 'integer' ? Number.isInteger(value) : typeof value === shape && value === value;
    return ok ? [] : bad(`expected ${shape}, got ${JSON.stringify(value)}`);
  }
  if ('nullable' in shape) return value === null ? [] : violations(value, shape.nullable, path);
  if ('oneOf' in shape) {
    return shape.oneOf.includes(value as string) ? [] : bad(`${JSON.stringify(value)} not allowed`);
  }
  if ('array' in shape) {
    if (!Array.isArray(value)) return bad('expected an array');
    return value.flatMap((item, i) => violations(item, shape.array, `${path}[${i}]`));
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return bad('expected an object');
  }
  const record = value as Record<string, unknown>;
  if ('record' in shape) {
    return Object.entries(record).flatMap(([key, item]) =>
      violations(item, shape.record, `${path}.${key}`),
    );
  }
  const missing = Object.keys(shape.object).filter((key) => !(key in record));
  const extra = shape.open ? [] : Object.keys(record).filter((key) => !(key in shape.object));
  return [
    ...missing.map((key) => `${path}: missing ${key}`),
    ...extra.map((key) => `${path}: unexpected ${key}`),
    ...Object.entries(shape.object).flatMap(([key, item]) =>
      key in record ? violations(record[key], item, `${path}.${key}`) : [],
    ),
  ];
}

export const nullable = (shape: Shape): Shape => ({ nullable: shape });
export const array = (shape: Shape): Shape => ({ array: shape });
export const object = (fields: Record<string, Shape>, open?: true): Shape => ({
  object: fields,
  ...(open && { open }),
});
export const oneOf = (...values: readonly string[]): Shape => ({ oneOf: values });
