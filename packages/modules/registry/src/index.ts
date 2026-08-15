import { type ModuleManifest, ModuleRegistry } from '@proton/core';
import { casesModule } from '@proton/module-cases';
import { loggingModule } from '@proton/module-logging';
import { moderationModule } from '@proton/module-moderation';
import { permissionsModule } from '@proton/module-permissions';
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
 *
 * Order is load order, and `permissions` is deliberately last-listed but first
 * in effect: `ModuleRuntime` consults it before dispatching any other module's
 * command, so the gate is inert until it appears here. Registration order
 * itself carries no meaning — the registry keys by id.
 *
 * `logging` is registered with no message-log store bound. Nothing reads
 * `manifest.listeners` yet, so binding one would be plumbing for a code path
 * that cannot run; and the module defaults to `enabled: false`, so a guild that
 * has not opted in produces nothing either way. What it does give a guild today
 * is the config surface, and an opted-in guild gets an error naming
 * `PostgresMessageLogStore` rather than silence. When the worker learns to
 * dispatch listeners, this becomes `createLoggingModule({ store })`.
 */
export const MODULES: ModuleManifest[] = [
  pingModule as ModuleManifest,
  casesModule as ModuleManifest,
  moderationModule as ModuleManifest,
  loggingModule as ModuleManifest,
  permissionsModule as ModuleManifest,
];

/** Build a registry with every shipped module registered and validated. */
export function createModuleRegistry(): ModuleRegistry {
  const registry = new ModuleRegistry();
  for (const manifest of MODULES) registry.register(manifest);
  return registry;
}
