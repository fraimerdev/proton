import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Read, not imported: audit.ts reaches the token store, which loads the env CI does not have.
const AUDIT = readFileSync(join(import.meta.dir, '..', 'src', 'server', 'audit.ts'), 'utf8');

describe('the audit stamp every dashboard mutation carries', () => {
  test('the stamp is parsed where it is assembled, so a bad actor id fails here not downstream', () => {
    expect(AUDIT).toContain('auditStampSchema.parse(');
  });

  test('the stamp is not asserted into its type instead of being checked', () => {
    expect(AUDIT).not.toContain('as AuditStamp');
  });
});
