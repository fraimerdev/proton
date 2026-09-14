import type { ModuleConfigView } from '@proton/core';
import {
  type ModuleTemplates,
  type SurfaceDiagnostic,
  type TemplateReport,
  validateConfigTemplates,
} from '@proton/core/placeholders';
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { z } from 'zod';
import { getAtPath, setAtPath } from '../../lib/config-paths.ts';
import { saveFailure } from '../../lib/errors.ts';
import { moduleConfigQuery } from '../../lib/queries.ts';
import { queryKeys } from '../../lib/query-keys.ts';
import { updateModuleConfig } from '../../server/modules.ts';

export type FieldErrors = ReadonlyMap<string, string>;

export interface ModuleForm<T> {
  view: ModuleConfigView;
  value: T;
  setValue: (next: T | ((current: T) => T)) => void;
  rebase: (patch: (current: T) => T) => void;

  get: (path: string) => unknown;
  set: (path: string, value: unknown) => void;

  dirty: boolean;
  errors: FieldErrors;
  errorAt: (path: string) => string | undefined;
  templateDiagnosticsAt: (path: string) => readonly SurfaceDiagnostic[];

  save: () => void;
  reset: () => void;
  saving: boolean;
  saveError: string | null;
  failures: number;

  changedElsewhere: boolean;
}

const NO_DIAGNOSTICS: readonly SurfaceDiagnostic[] = [];

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => sameJson(item, b[index]));
  }

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);

  for (const key of keys) {
    if (!sameJson(left[key], right[key])) return false;
  }

  return true;
}

function issuesToErrors(error: z.ZodError): Map<string, string> {
  const errors = new Map<string, string>();

  for (const issue of error.issues) {
    const path = issue.path.map(String).join('.');
    // First issue per path wins: Zod reports every union branch, not only the one chosen.
    if (!errors.has(path)) errors.set(path, issue.message);
  }

  return errors;
}

// "Those Tickets settings were not saved: types.0.name Too small; panels.1.channelId Required"
const SERVER_ISSUES = /settings were not saved:\s*(.+)$/s;

function serverErrors(message: string): Map<string, string> {
  const errors = new Map<string, string>();
  const body = SERVER_ISSUES.exec(message)?.[1];
  if (body === undefined) return errors;

  for (const part of body.split(';')) {
    const match = /^\s*([A-Za-z0-9_.[\]]+)\s+(.+?)\s*$/.exec(part);
    const path = match?.[1];
    const detail = match?.[2];
    if (path === undefined || detail === undefined || !path.includes('.')) continue;

    if (!errors.has(path)) errors.set(path, detail);
  }

  return errors;
}

interface Options<S extends z.ZodType> {
  guildId: string;
  moduleId: string;
  schema: S;
  templates?: ModuleTemplates | undefined;
}

export function useModuleForm<S extends z.ZodType>(options: Options<S>): ModuleForm<z.infer<S>>;
export function useModuleForm<S extends z.ZodType>({
  guildId,
  moduleId,
  schema,
  templates,
}: Options<S>): ModuleForm<Record<string, unknown>> {
  type T = Record<string, unknown>;

  const queryClient = useQueryClient();
  const { data: view } = useSuspenseQuery(moduleConfigQuery(guildId, moduleId));

  const server = view.config as T;

  // A draft never adopts a refetch: LIVE refetches on focus, and that would discard what was typed.
  const [draft, setDraft] = useState<T | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [failures, setFailures] = useState(0);
  const [serverIssues, setServerIssues] = useState<Map<string, string>>(new Map());

  const baseline = useRef<T>(server);
  if (draft === null && !sameJson(baseline.current, server)) baseline.current = server;
  const submittedDraft = useRef<T | null>(null);

  const value = draft ?? server;
  const dirty = draft !== null && !sameJson(draft, baseline.current);
  const changedElsewhere = draft !== null && !sameJson(baseline.current, server);

  const setValue = useCallback((next: T | ((current: T) => T)) => {
    setDraft((current) => {
      const from = current ?? baseline.current;
      const resolved = typeof next === 'function' ? (next as (c: T) => T)(from) : next;
      // Edited back to the baseline, the draft goes: a clean form has to adopt the server's copy.
      return sameJson(resolved, baseline.current) ? null : resolved;
    });
    setSaveError(null);
  }, []);

  const rebase = useCallback(
    (patch: (current: T) => T) => {
      baseline.current = patch(baseline.current);
      queryClient.setQueryData<ModuleConfigView>(
        queryKeys.moduleConfig(guildId, moduleId),
        (current) =>
          current && {
            ...current,
            config: patch(current.config as T) as ModuleConfigView['config'],
          },
      );
      setDraft((current) => {
        if (current === null) return null;
        const next = patch(current);
        return sameJson(next, baseline.current) ? null : next;
      });
    },
    [queryClient, guildId, moduleId],
  );

  const set = useCallback(
    (path: string, fieldValue: unknown) => {
      setValue((current) => {
        const copy = structuredClone(current) as Record<string, unknown>;
        setAtPath(copy, path, fieldValue);
        return copy as T;
      });

      setServerIssues((issues) => {
        if (!issues.has(path)) return issues;
        const next = new Map(issues);
        next.delete(path);
        return next;
      });
    },
    [setValue],
  );

  const get = useCallback(
    (path: string) => getAtPath(value as Record<string, unknown>, path),
    [value],
  );

  // Validated here too, so a bad value is named beside its field rather than after a round trip.
  const validation = useMemo(() => schema.safeParse(value), [schema, value]);

  const templateReport = useMemo<TemplateReport | null>(
    () =>
      templates === undefined ? null : validateConfigTemplates(templates, value, baseline.current),
    [templates, value],
  );

  const errors = useMemo<FieldErrors>(() => {
    const merged = new Map(serverIssues);
    if (!validation.success && submitted) {
      for (const [path, message] of issuesToErrors(validation.error)) merged.set(path, message);
    }
    for (const { path, diagnostic } of templateReport?.blocking ?? []) {
      if (!merged.has(path)) merged.set(path, diagnostic.message);
    }
    return merged;
  }, [serverIssues, validation, submitted, templateReport]);

  const mutation = useMutation({
    mutationFn: (config: T) =>
      updateModuleConfig({
        data: { guildId, moduleId, config: config as Record<string, unknown> },
      }),

    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.moduleConfig(guildId, moduleId), result.after);
      const saved = result.after.config as T;
      baseline.current = saved;
      // Edits made while the save was in flight are not in `saved`; clearing them would revert them.
      setDraft((current) =>
        current === submittedDraft.current || (current !== null && sameJson(current, saved))
          ? null
          : current,
      );
      setSubmitted(false);
      setServerIssues(new Map());
      setSaveError(null);

      // A save can change whether a module can run, and the overview and banners read the index.
      void queryClient.invalidateQueries({ queryKey: queryKeys.modules(guildId) });
    },

    onError: (error: Error) => {
      setServerIssues(serverErrors(error.message));
      setSaveError(saveFailure(error, 'Your changes were not saved'));
      setFailures((count) => count + 1);
    },
  });

  const save = useCallback(() => {
    setSubmitted(true);

    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      setSaveError('Fix the marked settings before saving.');
      setFailures((count) => count + 1);
      return;
    }

    if (templateReport !== null && templateReport.blocking.length > 0) {
      setSaveError('Fix the marked placeholders before saving.');
      setFailures((count) => count + 1);
      return;
    }

    setSaveError(null);
    submittedDraft.current = draft;
    mutation.mutate(parsed.data as T);
  }, [schema, value, templateReport, draft, mutation.mutate]);

  const reset = useCallback(() => {
    setDraft(null);
    setSubmitted(false);
    setServerIssues(new Map());
    setSaveError(null);
  }, []);

  const errorAt = useCallback((path: string) => errors.get(path), [errors]);

  const templateDiagnosticsAt = useCallback(
    (path: string) => templateReport?.byPath.get(path) ?? NO_DIAGNOSTICS,
    [templateReport],
  );

  return {
    view,
    value,
    setValue,
    rebase,
    get,
    set,
    dirty,
    errors,
    errorAt,
    templateDiagnosticsAt,
    save,
    reset,
    saving: mutation.isPending,
    saveError,
    failures,
    changedElsewhere,
  };
}
