import type { ModuleConfigView } from '@proton/core';
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
  /** The draft. Never the server's copy while there are unsaved edits. */
  value: T;
  setValue: (next: T | ((current: T) => T)) => void;

  /** Path-addressed access, for controls generated from a field descriptor. */
  get: (path: string) => unknown;
  set: (path: string, value: unknown) => void;

  dirty: boolean;
  errors: FieldErrors;
  errorAt: (path: string) => string | undefined;

  save: () => void;
  reset: () => void;
  saving: boolean;
  saveError: string | null;

  /** Another admin (or another tab) saved this module while this draft was open. */
  changedElsewhere: boolean;
}

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
    // First issue per path wins: Zod reports a union's every branch, and the later ones describe
    // a shape the admin did not choose.
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
  /**
   * The module's own config schema, imported from its browser-safe `./config` subpath. Optional:
   * the descriptor-driven page renders modules that expose no such subpath, and those fall back to
   * the api's own validation, which returns the same Zod issues a beat later.
   */
  schema?: S | undefined;
}

/**
 * One module's settings, from load to save.
 *
 * The draft is forked from the server copy and only re-forked while it is clean: `LIVE` refetches
 * every query on window focus, and adopting a refetch under an open draft would throw away
 * whatever the admin had typed while they were reading Discord in the other tab.
 */
export function useModuleForm(options: {
  guildId: string;
  moduleId: string;
}): ModuleForm<Record<string, unknown>>;
export function useModuleForm<S extends z.ZodType>(options: {
  guildId: string;
  moduleId: string;
  schema: S;
}): ModuleForm<z.infer<S>>;
export function useModuleForm<S extends z.ZodType>({
  guildId,
  moduleId,
  schema,
}: Options<S>): ModuleForm<Record<string, unknown>> {
  type T = Record<string, unknown>;

  const queryClient = useQueryClient();
  const { data: view } = useSuspenseQuery(moduleConfigQuery(guildId, moduleId));

  const server = view.config as T;

  const [draft, setDraft] = useState<T | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<Map<string, string>>(new Map());

  // What the draft was forked from, to tell "the admin changed this" from "somebody else did".
  const baseline = useRef<T>(server);
  if (draft === null && !sameJson(baseline.current, server)) baseline.current = server;
  const submittedDraft = useRef<T | null>(null);

  const value = draft ?? server;
  const dirty = draft !== null && !sameJson(draft, baseline.current);
  const changedElsewhere = draft !== null && !sameJson(baseline.current, server);

  const setValue = useCallback((next: T | ((current: T) => T)) => {
    setDraft((current) => {
      const from = current ?? baseline.current;
      return typeof next === 'function' ? (next as (c: T) => T)(from) : next;
    });
    setSaveError(null);
  }, []);

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

  // Validated against the module's own schema, so a bad value is named beside the field it is in
  // rather than after a round trip that returns one sentence about the whole form.
  const validation = useMemo(() => schema?.safeParse(value), [schema, value]);

  const errors = useMemo<FieldErrors>(() => {
    const merged = new Map(serverIssues);
    if (validation && !validation.success && submitted) {
      for (const [path, message] of issuesToErrors(validation.error)) merged.set(path, message);
    }
    return merged;
  }, [serverIssues, validation, submitted]);

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

      // The overview and the module banners read the index, and a save can change
      // whether a module is able to run.
      void queryClient.invalidateQueries({ queryKey: queryKeys.modules(guildId) });
    },

    onError: (error: Error) => {
      setServerIssues(serverErrors(error.message));
      setSaveError(saveFailure(error, 'Your changes were not saved'));
    },
  });

  const save = useCallback(() => {
    setSubmitted(true);

    if (schema === undefined) {
      setSaveError(null);
      submittedDraft.current = draft;
      mutation.mutate(value);
      return;
    }

    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      setSaveError('Fix the marked settings before saving.');
      return;
    }

    setSaveError(null);
    submittedDraft.current = draft;
    mutation.mutate(parsed.data as T);
  }, [schema, value, draft, mutation.mutate]);

  const reset = useCallback(() => {
    setDraft(null);
    setSubmitted(false);
    setServerIssues(new Map());
    setSaveError(null);
  }, []);

  const errorAt = useCallback((path: string) => errors.get(path), [errors]);

  return {
    view,
    value,
    setValue,
    get,
    set,
    dirty,
    errors,
    errorAt,
    save,
    reset,
    saving: mutation.isPending,
    saveError,
    changedElsewhere,
  };
}
