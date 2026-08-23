import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { createRemindersAutocompleteListener } from './autocomplete.ts';
import { remindersCommands } from './commands.ts';
import {
  REMINDERS_SCHEMA_VERSION,
  remindersConfigSchema,
  remindersDefaultConfig,
} from './config.ts';
import { DELIVER_JOB, deliverReminder } from './deliver.ts';
import type { RemindersDeps } from './deps.ts';

export {
  type AutocompleteOutcome,
  createRemindersAutocompleteListener,
  handleAutocomplete,
  REMINDERS_EVENT_TYPES,
} from './autocomplete.ts';
export { remindCommand, remindersCommand, remindersCommands } from './commands.ts';
export {
  type DelayResult,
  MODULE_ID,
  REMINDER_CONTENT_MAX,
  REMINDER_LIST_LIMIT,
  REMINDERS_SCHEMA_VERSION,
  type RemindersConfig,
  remindersConfigSchema,
  remindersDefaultConfig,
  resolveDelay,
} from './config.ts';
export { DELIVER_JOB, deliverDataSchema, deliverReminder } from './deliver.ts';
export { bindStore, describeUnbound, type RemindersDeps, type StoreBinding } from './deps.ts';
export { MENTIONS_OFF, mentionOnly, type ReplyOptions, reply } from './perform.ts';
export { DrizzleReminderStore } from './postgres-store.ts';
export {
  relativeLabel,
  reminderLabel,
  renderDelivery,
  renderPending,
  unixSeconds,
} from './render.ts';
export type { CreateReminderInput, PendingQuery, Reminder, ReminderStore } from './store.ts';
export { type NewReminderRow, type ReminderRow, reminders } from './table.ts';

export function createRemindersModule(
  deps: RemindersDeps = {},
): ModuleManifest<typeof remindersConfigSchema> {
  return {
    id: 'reminders',
    name: 'Reminders',
    category: 'utility',
    configSchema: remindersConfigSchema,
    defaultConfig: remindersDefaultConfig,
    schemaVersion: REMINDERS_SCHEMA_VERSION,

    requiredIntents: [GatewayIntentBits.Guilds],

    requiredPermissions: [Permissions.ViewChannel, Permissions.SendMessages],
    actionKinds: ['interaction_reply', 'send'],

    commands: remindersCommands(deps),
    listeners: [createRemindersAutocompleteListener(deps)],

    schedules: [DELIVER_JOB],
    scheduledHandlers: {
      [DELIVER_JOB]: (data, ctx) => deliverReminder(data, ctx, deps),
    },

    dashboard: {
      icon: 'alarm-clock',
      sections: [
        { id: 'general', title: 'General', fields: ['enabled'] },
        { id: 'bounds', title: 'How far ahead', fields: ['minDuration', 'maxDuration'] },
      ],
    },
  };
}

export const remindersModule: ModuleManifest<typeof remindersConfigSchema> =
  createRemindersModule();

export default remindersModule;
