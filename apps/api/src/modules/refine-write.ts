import type { ModuleManifest } from '@proton/core';
import { ModuleConfigError } from './service.ts';

export function assertWriteRefinements(
  manifest: Pick<ModuleManifest, 'name' | 'refineWrite'>,
  next: Record<string, unknown>,
  before: Record<string, unknown>,
): void {
  if (!manifest.refineWrite) return;

  const issues = manifest.refineWrite(next, before);
  if (issues.length === 0) return;

  throw new ModuleConfigError(
    'invalid_config',
    `Those ${manifest.name} settings were not saved: ${issues
      .map((issue) => `${issue.path} ${issue.message}`)
      .join('; ')}`,
  );
}
