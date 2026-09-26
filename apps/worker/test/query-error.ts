// The worker has no drizzle-orm of its own; this is the copy @proton/db checks errors against.
const { DrizzleQueryError } = (await import(
  Bun.resolveSync('drizzle-orm/errors', `${import.meta.dir}/../../../packages/db/src`)
)) as { DrizzleQueryError: new (query: string, params: unknown[], cause?: unknown) => Error };

export function queryError(params: unknown[]): Error {
  return new DrizzleQueryError(
    'insert into "reports" ("comment") values ($1)',
    params,
    Object.assign(new Error('connection reset'), { code: '08006' }),
  );
}
