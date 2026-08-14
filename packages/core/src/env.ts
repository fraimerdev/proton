import type { z } from 'zod';

/**
 * Thrown when a package's environment fails validation at boot.
 *
 * The message names every offending variable and why it failed, but **never**
 * includes the received value. Environments carry the bot token, the OAuth
 * client secret and the auth signing secret; PLAN.md I10 requires that those
 * never reach code, fixtures, tests or logs, and an error message is a log.
 */
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

/**
 * Validate and parse an environment against a Zod schema, failing fast at boot.
 *
 * `scope` names the package or app in the error so a misconfigured deploy says
 * *which* service is unhappy. Unknown keys are stripped, so a process only ever
 * sees the variables it declared.
 */
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
