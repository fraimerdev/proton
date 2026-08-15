import { type ModuleManifest, ModuleRegistry } from '@proton/core';
import { type AntinukeDeps, createAntinukeModule } from '@proton/module-antinuke';
import { type AntiraidDeps, createAntiraidModule } from '@proton/module-antiraid';
import { type AutoroleDeps, createAutoroleModule } from '@proton/module-autorole';
import { type BackupDeps, createBackupModule } from '@proton/module-backup';
import { casesModule } from '@proton/module-cases';
import { createLevelingModule, type LevelingDeps } from '@proton/module-leveling';
import { createLoggingModule, type LoggingDeps } from '@proton/module-logging';
import { moderationModule } from '@proton/module-moderation';
import { permissionsModule } from '@proton/module-permissions';
import { createPhishingModule, type PhishingDeps } from '@proton/module-phishing';
import { pingModule } from '@proton/module-ping';
import { createRolemenuModule, type RolemenuDeps } from '@proton/module-rolemenu';
import { createStarboardModule, type StarboardDeps } from '@proton/module-starboard';
import { createVerificationModule, type VerificationDeps } from '@proton/module-verification';
import { createWelcomeModule, type WelcomeDeps } from '@proton/module-welcome';

/**
 * Runtime ports for the modules that declare any.
 *
 * Six of the ten modules are `createXModule(deps)` factories rather than
 * constants, because §7's `ModuleContext` hands a module a guild id, its config,
 * an executor and a logger and nothing else — no Redis, no database, no member
 * lookup. Each declares what it additionally needs as an optional port.
 *
 * Only **types** cross this boundary. This package is a list of manifests,
 * imported by `apps/api` and `apps/dashboard` as readily as by `apps/worker`;
 * holding a Redis connection or a database handle here would drag one into the
 * dashboard's server bundle. The objects themselves are constructed in
 * `apps/worker`, next to the executor it already builds, and passed in.
 *
 * Every field is optional so `createModuleRegistry()` with no argument still
 * produces the full, valid, renderable registry the API and dashboard need.
 */
export interface ModuleBindings {
  antinuke?: AntinukeDeps;
  antiraid?: AntiraidDeps;
  verification?: VerificationDeps;
  backup?: BackupDeps;
  phishing?: PhishingDeps;
  logging?: LoggingDeps;

  // Phase 3 (§8): engagement.
  leveling?: LevelingDeps;
  autorole?: AutoroleDeps;
  rolemenu?: RolemenuDeps;
  starboard?: StarboardDeps;
  welcome?: WelcomeDeps;
}

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
 * Order is load order, and `permissions` is deliberately last-listed among the
 * Phase 1 entries but first in effect: `ModuleRuntime` consults it before
 * dispatching any other module's command, so the gate is inert until it appears
 * here. Registration order itself carries no meaning — the registry keys by id.
 *
 * Six of the ten take runtime ports (`ModuleBindings` above). Built with none —
 * which is what `apps/api` and `apps/dashboard` do — they are still complete,
 * valid manifests: the config surface, the invite permission integer and the
 * intent bitfield are all computed from manifests (§10.3) and are the same
 * either way. They are also safely inert, because every one of them defaults to
 * `enabled: false` and each reports its own unwiring by name rather than going
 * quiet. `apps/worker` is the one process that binds them, because it is the one
 * process that owns the Redis connections, the database handle and the REST
 * client they need.
 */
export function buildModules(bindings: ModuleBindings = {}): ModuleManifest[] {
  return [
    pingModule as ModuleManifest,
    casesModule as ModuleManifest,
    moderationModule as ModuleManifest,
    createLoggingModule(bindings.logging ?? {}) as ModuleManifest,
    permissionsModule as ModuleManifest,

    // Phase 2 (§8): security. Ordering carries no meaning — the registry keys by
    // id — but keeping the phases apart makes the diff that added them readable.
    createAntinukeModule(bindings.antinuke ?? {}) as ModuleManifest,
    createAntiraidModule(bindings.antiraid ?? {}) as ModuleManifest,
    createVerificationModule(bindings.verification ?? {}) as ModuleManifest,
    createBackupModule(bindings.backup ?? {}) as ModuleManifest,
    createPhishingModule(bindings.phishing ?? {}) as ModuleManifest,

    // Phase 3 (§8): engagement. `leveling` is the only module so far that
    // publishes an event rather than only consuming them, which is what the
    // `emits` allowlist on its manifest declares.
    createLevelingModule(bindings.leveling ?? {}) as ModuleManifest,
    createAutoroleModule(bindings.autorole ?? {}) as ModuleManifest,
    createRolemenuModule(bindings.rolemenu ?? {}) as ModuleManifest,
    createStarboardModule(bindings.starboard ?? {}) as ModuleManifest,
    createWelcomeModule(bindings.welcome ?? {}) as ModuleManifest,
  ];
}

/**
 * The shipped modules with nothing bound.
 *
 * Kept as a constant because the properties most callers and tests care about —
 * ids, commands, dashboard sections, permissions, intents — do not depend on the
 * bindings at all.
 */
export const MODULES: ModuleManifest[] = buildModules();

/**
 * Build a registry with every shipped module registered and validated.
 *
 * Registration is the validation step: it checks each `defaultConfig` against its
 * own schema and that the dashboard's form generator can render it, so a broken
 * manifest fails here rather than on a guild admin's settings page.
 */
export function createModuleRegistry(bindings: ModuleBindings = {}): ModuleRegistry {
  const registry = new ModuleRegistry();
  for (const manifest of buildModules(bindings)) registry.register(manifest);
  return registry;
}
