import type { ModuleIndex, ModuleSummary } from '@proton/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { saveFailure } from '../../lib/errors.ts';
import { queryKeys } from '../../lib/query-keys.ts';
import { updateModuleConfig } from '../../server/modules.ts';

function flip(
  index: ModuleIndex | undefined,
  moduleId: string,
  enabled: boolean,
): ModuleIndex | undefined {
  return (
    index && {
      ...index,
      modules: index.modules.map((module) =>
        module.id === moduleId ? { ...module, enabled } : module,
      ),
    }
  );
}

export interface ModuleToggle {
  toggle: (enabled: boolean) => void;
  busy: boolean;
  failure: string | null;
  dismiss: () => void;
}

/**
 * The module's own on/off switch. Optimistic, because the switch is the feedback: a spinner on a
 * 200ms round trip reads as the switch not having worked.
 */
export function useModuleToggle(guildId: string, summary: ModuleSummary | undefined): ModuleToggle {
  const queryClient = useQueryClient();
  const modulesKey = queryKeys.modules(guildId);
  const [failure, setFailure] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: ({ enabled }: { enabled: boolean }) =>
      updateModuleConfig({ data: { guildId, moduleId: summary?.id ?? '', enabled } }),

    onMutate: async ({ enabled }) => {
      setFailure(null);
      await queryClient.cancelQueries({ queryKey: modulesKey });
      queryClient.setQueryData<ModuleIndex>(modulesKey, (current) =>
        flip(current, summary?.id ?? '', enabled),
      );
    },

    // Flipped back one module at a time rather than restored from a snapshot: another switch
    // thrown while this one was in flight has already written its own optimistic value here.
    onError: (error: Error, { enabled }) => {
      queryClient.setQueryData<ModuleIndex>(modulesKey, (current) =>
        flip(current, summary?.id ?? '', !enabled),
      );
      setFailure(
        saveFailure(
          error,
          `${summary?.name ?? 'That module'} was not switched ${enabled ? 'on' : 'off'}`,
        ),
      );
    },

    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: modulesKey });
      if (summary) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.moduleConfig(guildId, summary.id),
        });
      }
    },
  });

  const toggle = useCallback(
    (enabled: boolean) => {
      if (!summary) return;
      mutation.mutate({ enabled });
    },
    [mutation.mutate, summary],
  );

  return {
    toggle,
    busy: mutation.isPending,
    failure,
    dismiss: useCallback(() => setFailure(null), []),
  };
}
