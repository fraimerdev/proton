import { type ModuleManifest, ModuleRegistry } from '@proton/core';
import { pingModule } from '@proton/module-ping';

/**
 * The one list of modules Proton ships.
 *
 * The second-module drill (PLAN.md §12) found that registration was duplicated
 * in `apps/api` and `apps/worker`. That is not merely repetitive — the two lists
 * can disagree, and the failure is nasty: the API would happily serve config for
 * a module the worker never runs, so a guild admin sees a module, toggles it on,
 * and nothing ever happens. Exactly the "the bot did nothing" outcome §7 exists
 * to eliminate.
 *
 * Adding a module is now one line here plus its own folder.
 */
export const MODULES: ModuleManifest[] = [pingModule as ModuleManifest];

/** Build a registry with every shipped module registered and validated. */
export function createModuleRegistry(): ModuleRegistry {
  const registry = new ModuleRegistry();
  for (const manifest of MODULES) registry.register(manifest);
  return registry;
}
