import { type ModuleManifest, ModuleRegistry, type ModuleRegistryOptions } from '@proton/core';
import { type AntinukeDeps, createAntinukeModule } from '@proton/module-antinuke';
import { type AntiraidDeps, createAntiraidModule } from '@proton/module-antiraid';
import { type AutomodDeps, createAutomodModule } from '@proton/module-automod';
import { type BackupDeps, createBackupModule } from '@proton/module-backup';
import { type CasesDeps, createCasesModule } from '@proton/module-cases';
import { type CountersDeps, createCountersModule } from '@proton/module-counters';
import { createGiveawaysModule, type GiveawaysDeps } from '@proton/module-giveaways';
import { createJoinRolesModule, type JoinRolesDeps } from '@proton/module-joinroles';
import { createLevelingModule, type LevelingDeps } from '@proton/module-leveling';
import { createLoggingModule, type LoggingDeps } from '@proton/module-logging';
import { createMessagesModule, type MessagesDeps } from '@proton/module-messages';
import { moderationModule } from '@proton/module-moderation';
import { permissionsModule } from '@proton/module-permissions';
import { createPhishingModule, type PhishingDeps } from '@proton/module-phishing';
import { pingModule } from '@proton/module-ping';
import { createPollsModule, type PollsDeps } from '@proton/module-polls';
import { createRemindersModule, type RemindersDeps } from '@proton/module-reminders';
import { createRolemenuModule, type RolemenuDeps } from '@proton/module-rolemenu';
import { createServerlogModule, type ServerlogDeps } from '@proton/module-serverlog';
import { createStarboardModule, type StarboardDeps } from '@proton/module-starboard';
import { createSuggestionsModule, type SuggestionsDeps } from '@proton/module-suggestions';
import { createTagsModule, type TagsDeps } from '@proton/module-tags';
import { createTempVcModule, type TempVcDeps } from '@proton/module-tempvc';
import { createTicketsModule, type TicketsDeps } from '@proton/module-tickets';
import { createVerificationModule, type VerificationDeps } from '@proton/module-verification';
import { createWelcomeModule, type WelcomeDeps } from '@proton/module-welcome';

export interface ModuleBindings {
  cases?: CasesDeps;

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

  tags?: TagsDeps;
  tickets?: TicketsDeps;
  tempvc?: TempVcDeps;
  reminders?: RemindersDeps;
  messages?: MessagesDeps;
  polls?: PollsDeps;
  giveaways?: GiveawaysDeps;
  counters?: CountersDeps;
  suggestions?: SuggestionsDeps;
}

export function buildModules(bindings: ModuleBindings = {}): ModuleManifest[] {
  return [
    pingModule as ModuleManifest,
    createCasesModule(bindings.cases ?? {}) as ModuleManifest,
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

    createTagsModule(bindings.tags ?? {}) as ModuleManifest,
    createTicketsModule(bindings.tickets ?? {}) as ModuleManifest,
    createTempVcModule(bindings.tempvc ?? {}) as ModuleManifest,
    createRemindersModule(bindings.reminders ?? {}) as ModuleManifest,
    createMessagesModule(bindings.messages ?? {}) as ModuleManifest,
    createPollsModule(bindings.polls ?? {}) as ModuleManifest,
    createGiveawaysModule(bindings.giveaways ?? {}) as ModuleManifest,
    createCountersModule(bindings.counters ?? {}) as ModuleManifest,
    createSuggestionsModule(bindings.suggestions ?? {}) as ModuleManifest,
  ];
}

export const MODULES: ModuleManifest[] = buildModules();

export function createModuleRegistry(
  bindings: ModuleBindings = {},
  options: ModuleRegistryOptions = {},
): ModuleRegistry {
  const registry = new ModuleRegistry(options);
  for (const manifest of buildModules(bindings)) registry.register(manifest);
  return registry;
}
