import type { ModuleConfigView, ModuleSummary } from '@proton/core';
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getAtPath, setAtPath } from '../../lib/config-paths.ts';
import {
  channelsQuery,
  moduleConfigQuery,
  modulesQuery,
  rolesQuery,
  sessionQuery,
} from '../../lib/queries.ts';
import { queryKeys } from '../../lib/query-keys.ts';
import { updateModuleConfig } from '../../server/modules.ts';
import type { DiscordChannel, DiscordRole } from '../form/picker.tsx';
import { settingsSurvives } from './navigation.ts';

export interface ModuleForm {
  guildId: string;
  moduleId: string;
  summary: ModuleSummary;
  guildName: string;

  channels: readonly DiscordChannel[];
  roles: readonly DiscordRole[];
  tier: ModuleConfigView['tier'];

  config: Record<string, unknown>;
  live: Record<string, unknown>;

  value: (path: string, fallback?: unknown) => unknown;
  set: (path: string, value: unknown) => void;
  report: (key: string, problem: string | null) => void;

  dirty: boolean;
  problem: string | null;
  settled: boolean;
  saving: boolean;
  error: Error | null;

  save: () => void;
  reset: () => void;
  blocked: boolean;
  stay: () => void;
  leave: () => void;
}

function blank(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;

  return typeof value === 'object' && Object.keys(value).length === 0;
}

// JSON.stringify(undefined) is undefined rather than a string, so any value at all compares unequal
// to a key the stored config does not have — including the empty list a token field is left holding
// once its last chip is removed. Permissions, whose overrides start absent and whose save prunes the
// empty ones anyway, then sat on "You have unsaved changes" with nothing on screen changed and the
// leave-confirmation firing on every navigation.
function differs(held: unknown, stored: unknown): boolean {
  if (stored === undefined && blank(held)) return false;

  return JSON.stringify(held) !== JSON.stringify(stored);
}

function moduleOf(modules: readonly ModuleSummary[], moduleId: string): ModuleSummary {
  const found = modules.find((candidate) => candidate.id === moduleId);
  if (!found)
    throw new Error(
      `This server has no '${moduleId}' module — the link may be out of date. Pick a module ` +
        `from the list on the left.`,
    );

  return found;
}

export function useModuleForm(
  guildId: string,
  moduleId: string,
  hasAreas = false,

  // Last shaping before the write, for a module whose stored shape is narrower than what the page
  // edits — permissions drops the commands whose override list was emptied rather than storing a
  // key per command the reader ever opened.
  normalise?: (config: Record<string, unknown>) => Record<string, unknown>,
): ModuleForm {
  const queryClient = useQueryClient();

  const { modules } = useSuspenseQuery(modulesQuery(guildId)).data;
  const summary = moduleOf(modules, moduleId);

  const settings = useSuspenseQuery(moduleConfigQuery(guildId, moduleId)).data;
  const channels = useSuspenseQuery(channelsQuery(guildId)).data;
  const roles = useSuspenseQuery(rolesQuery(guildId)).data;
  const { guilds } = useSuspenseQuery(sessionQuery()).data;

  // Edits only, never a copy of the whole config. Save writes these paths over the stored config,
  // so a field this page does not render is a field this page cannot erase.
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [settled, setSettled] = useState(false);

  const value = useCallback(
    (path: string, fallback?: unknown): unknown => {
      if (Object.hasOwn(edits, path)) return edits[path];

      const stored = getAtPath(settings.config, path);
      return stored === undefined ? fallback : stored;
    },
    [edits, settings.config],
  );

  const set = useCallback((path: string, next: unknown): void => {
    setEdits((prev) => ({ ...prev, [path]: next }));
  }, []);

  const report = useCallback((key: string, problem: string | null): void => {
    setProblems((prev) => {
      if (problem === null) {
        if (!Object.hasOwn(prev, key)) return prev;

        const { [key]: _dropped, ...rest } = prev;
        return rest;
      }

      return prev[key] === problem ? prev : { ...prev, [key]: problem };
    });
  }, []);

  const dirty = useMemo(
    () =>
      Object.entries(edits).some(([path, held]) => differs(held, getAtPath(settings.config, path))),
    [edits, settings.config],
  );

  const live = useMemo(() => {
    const next = structuredClone(settings.config);
    for (const [path, held] of Object.entries(edits)) setAtPath(next, path, held);
    return next;
  }, [edits, settings.config]);

  const save = useMutation({
    mutationFn: (config: Record<string, unknown>) =>
      updateModuleConfig({ data: { guildId, moduleId, config } }),

    // Re-seeded from result.after, not from what was submitted: the API normalises some configs on
    // the way in, so trusting the submission leaves the form showing values the server did not keep.
    onSuccess: (result) => {
      queryClient.setQueryData(moduleConfigQuery(guildId, moduleId).queryKey, result.after);
      void queryClient.invalidateQueries({ queryKey: queryKeys.modules(guildId) });
      setEdits({});
      setProblems({});
      setSettled(true);
    },
  });

  useEffect(() => {
    if (!settled) return;

    const timer = setTimeout(() => setSettled(false), 4000);
    return () => clearTimeout(timer);
  }, [settled]);

  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => dirty && !settingsSurvives(current, next, hasAreas),
    enableBeforeUnload: () => dirty,
    withResolver: true,
  });

  const seededFrom = useRef(settings);

  useEffect(() => {
    if (seededFrom.current === settings) return;
    seededFrom.current = settings;

    if (!dirty) setEdits({});
  });

  const problem = Object.values(problems)[0] ?? null;

  function discard(): void {
    setEdits({});
    setProblems({});
    setSettled(false);
    save.reset();
  }

  return {
    guildId,
    moduleId,
    summary,
    guildName: guilds.find((guild) => guild.id === guildId)?.name ?? 'this server',

    channels,
    roles,
    tier: settings.tier,

    config: settings.config,
    live,

    value,
    set,
    report,

    dirty,
    problem,
    settled,
    saving: save.isPending,
    error: save.error,

    save: () => save.mutate(normalise ? normalise(live) : live),
    reset: discard,

    blocked: blocker.status === 'blocked',
    stay: () => blocker.reset?.(),

    // Discards before proceeding. proceed() alone only released the navigation: the edits stayed in
    // state, so the form was still dirty on the far side — and a module's hub and its areas are one
    // route, so the page never unmounts to lose them. The blocker then refused every later move
    // into an area, while the hub renders no dialog to answer it. The module read as having stopped
    // responding, and only a reload cleared it.
    leave: () => {
      discard();
      blocker.proceed?.();
    },
  };
}
