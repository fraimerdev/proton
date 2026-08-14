/**
 * postgres.js types raw query results as a generic `Row[]`, which under
 * `noUncheckedIndexedAccess` makes every assertion in a test read as possibly
 * undefined. This narrows once, at the call site, so the tests stay about
 * behaviour rather than about type gymnastics.
 */
export async function rows<T>(query: Promise<unknown>): Promise<T[]> {
  return (await query) as T[];
}

/** First row of a query that the test has already established returns one. */
export async function firstRow<T>(query: Promise<unknown>): Promise<T> {
  const result = (await query) as T[];
  const first = result[0];
  if (first === undefined) throw new Error('expected at least one row');
  return first;
}
