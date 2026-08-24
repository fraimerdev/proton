import type { ModuleSummary } from '@proton/core';
import { createContext, useContext } from 'react';

export type ToggleModule = (module: ModuleSummary, enabled: boolean) => void;

const ModuleToggleContext = createContext<ToggleModule | null>(null);

export const ModuleToggleProvider = ModuleToggleContext.Provider;

// One mutation for the whole guild, shared by the sidebar row and the module page's own switch:
// two useMutation calls would each hold their own optimistic write of the same cache entry, and
// the one that settled second would restore the value the first had already replaced.
export function useToggleModule(): ToggleModule {
  const toggle = useContext(ModuleToggleContext);

  if (!toggle) throw new Error('useToggleModule was called outside the guild shell');

  return toggle;
}
