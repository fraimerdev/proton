import { type ModuleManifest, ModuleRegistry } from '@proton/core';
import { type AntinukeDeps, createAntinukeModule } from '@proton/module-antinuke';
import { type AntiraidDeps, createAntiraidModule } from '@proton/module-antiraid';
import { type AutomodDeps, createAutomodModule } from '@proton/module-automod';
import { type BackupDeps, createBackupModule } from '@proton/module-backup';
import { casesModule } from '@proton/module-cases';
import { createJoinRolesModule, type JoinRolesDeps } from '@proton/module-joinroles';
import { createLevelingModule, type LevelingDeps } from '@proton/module-leveling';
import { createLoggingModule, type LoggingDeps } from '@proton/module-logging';
import { moderationModule } from '@proton/module-moderation';
import { permissionsModule } from '@proton/module-permissions';
import { createPhishingModule, type PhishingDeps } from '@proton/module-phishing';
import { pingModule } from '@proton/module-ping';
import { createRolemenuModule, type RolemenuDeps } from '@proton/module-rolemenu';
import { createServerlogModule, type ServerlogDeps } from '@proton/module-serverlog';
import { createStarboardModule, type StarboardDeps } from '@proton/module-starboard';
import { createVerificationModule, type VerificationDeps } from '@proton/module-verification';
import { createWelcomeModule, type WelcomeDeps } from '@proton/module-welcome';

export interface ModuleBindings {
  antinuke?: AntinukeDeps;
  antiraid?: AntiraidDeps;
  automod?: AutomodDeps;
  verification?: VerificationDeps;
  backup?: BackupDeps;
  phishing?: PhishingDeps;
  logging?: LoggingDeps;
  serverlog?: ServerlogDeps;

  leveling?: LevelingDeps;
  joinroles?: JoinRolesDeps;
  rolemenu?: RolemenuDeps;
  starboard?: StarboardDeps;
  welcome?: WelcomeDeps;
}

export function buildModules(bindings: ModuleBindings = {}): ModuleManifest[] {
  return [
    pingModule as ModuleManifest,
    casesModule as ModuleManifest,
    moderationModule as ModuleManifest,
    createLoggingModule(bindings.logging ?? {}) as ModuleManifest,
    createServerlogModule(bindings.serverlog ?? {}) as ModuleManifest,
    permissionsModule as ModuleManifest,

    createAntinukeModule(bindings.antinuke ?? {}) as ModuleManifest,
    createAntiraidModule(bindings.antiraid ?? {}) as ModuleManifest,
    createVerificationModule(bindings.verification ?? {}) as ModuleManifest,
    createBackupModule(bindings.backup ?? {}) as ModuleManifest,
    createPhishingModule(bindings.phishing ?? {}) as ModuleManifest,
    createAutomodModule(bindings.automod ?? {}) as ModuleManifest,

    createLevelingModule(bindings.leveling ?? {}) as ModuleManifest,
    createJoinRolesModule(bindings.joinroles ?? {}) as ModuleManifest,
    createRolemenuModule(bindings.rolemenu ?? {}) as ModuleManifest,
    createStarboardModule(bindings.starboard ?? {}) as ModuleManifest,
    createWelcomeModule(bindings.welcome ?? {}) as ModuleManifest,
  ];
}

export const MODULES: ModuleManifest[] = buildModules();

export function createModuleRegistry(bindings: ModuleBindings = {}): ModuleRegistry {
  const registry = new ModuleRegistry();
  for (const manifest of buildModules(bindings)) registry.register(manifest);
  return registry;
}
