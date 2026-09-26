import {
  type ModerationConfig,
  moderationConfigSchema,
  type PunishConfig,
  refineModerationWrite,
} from '@proton/module-moderation/config';
import { useMemo } from 'react';
import type { ModuleForm } from '../../components/module/form.ts';

export type ModerationForm = ModuleForm<ModerationConfig>;

export interface Problems {
  at: (path: string) => string | undefined;
  paths: readonly string[];
}

export function useSavedConfig(form: ModerationForm): ModerationConfig | null {
  return useMemo(() => {
    const parsed = moderationConfigSchema.safeParse(form.view.config);
    return parsed.success ? parsed.data : null;
  }, [form.view.config]);
}

export function useProblems(form: ModerationForm): Problems {
  const saved = useSavedConfig(form);
  const { value, errors, errorAt } = form;

  const pending = useMemo(() => {
    const issues = new Map<string, string>();
    if (saved === null) return issues;

    try {
      for (const issue of refineModerationWrite(value, saved)) {
        if (!issues.has(issue.path)) issues.set(issue.path, issue.message);
      }
    } catch {
      return issues;
    }

    return issues;
  }, [value, saved]);

  return useMemo(
    () => ({
      at: (path: string) => errorAt(path) ?? pending.get(path),
      paths: [...new Set([...errors.keys(), ...pending.keys()])],
    }),
    [errorAt, errors, pending],
  );
}

export function setPunish(
  form: ModerationForm,
  change: (current: PunishConfig) => PunishConfig,
): void {
  form.setValue((current) => ({ ...current, punish: change(current.punish) }));
}
