import type { z } from 'zod';

export class EnvValidationError extends Error {
  readonly issues: readonly string[];

  constructor(scope: string, issues: readonly string[]) {
    const detail = issues.map((issue) => `  - ${issue}`).join('\n');
    super(
      `Invalid environment for ${scope}:\n${detail}\n\n` +
        'Compare your .env against .env.example. Values are omitted from this ' +
        'message on purpose — never paste a token into a bug report.',
    );
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

export function createEnv<S extends z.ZodObject<z.ZodRawShape>>(
  scope: string,
  schema: S,
  source: Record<string, string | undefined> = process.env,
): z.infer<S> {
  const parsed = schema.safeParse(source);

  if (parsed.success) {
    return parsed.data as z.infer<S>;
  }

  const issues = parsed.error.issues.map((issue) => {
    const key = issue.path.map(String).join('.') || '(root)';
    return `${key}: ${issue.message}`;
  });

  throw new EnvValidationError(scope, issues);
}
