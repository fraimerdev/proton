export async function rows<T>(query: Promise<unknown>): Promise<T[]> {
  return (await query) as T[];
}

export async function firstRow<T>(query: Promise<unknown>): Promise<T> {
  const result = (await query) as T[];
  const first = result[0];
  if (first === undefined) throw new Error('expected at least one row');
  return first;
}
