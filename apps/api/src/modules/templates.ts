import type { ModuleManifest } from '@proton/core';
import { formatTemplateIssues, validateConfigTemplates } from '@proton/core/placeholders';
import { ModuleConfigError } from './service.ts';

export function assertTemplatesValid(
  manifest: Pick<ModuleManifest, 'name' | 'templates'>,
  next: unknown,
  before: unknown,
): void {
  if (!manifest.templates) return;

  const report = validateConfigTemplates(manifest.templates, next, before);
  if (report.blocking.length === 0) return;

  throw new ModuleConfigError(
    'invalid_template',
    `Those ${manifest.name} settings were not saved: ${formatTemplateIssues(report)}`,
  );
}
