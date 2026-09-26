import { z } from 'zod';

export const COMMAND_SETTINGS_SCHEMA_VERSION = 1;
export const COMMAND_DESCRIPTION_MAX = 100;
export const COMMAND_SIZE_MAX = 8000;
export const COMMAND_NAME_MAX = 32;
export const COMMAND_NAME_PATTERN = /^[-_ʼ\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$/u;

export const commandSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  name: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  optionDescriptions: z.record(z.string(), z.string()).default({}),
  privateReply: z.boolean().nullable().default(null),
});

export type CommandSettings = z.infer<typeof commandSettingsSchema>;

export const commandInputSchema = z.object({
  name: z.string().nullable(),
  description: z.string().nullable(),
  optionDescriptions: z.record(z.string(), z.string()),
  privateReply: z.boolean().nullable(),
});

export type CommandInput = z.infer<typeof commandInputSchema>;

export const DEFAULT_COMMAND_SETTINGS: CommandSettings = commandSettingsSchema.parse({});

export function filled(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

export function resetCustomization(settings: CommandSettings): CommandSettings {
  return { ...commandSettingsSchema.parse({}), enabled: settings.enabled };
}

export function isCustomized(settings: CommandSettings): boolean {
  return (
    filled(settings.name) ||
    filled(settings.description) ||
    Object.values(settings.optionDescriptions).some(filled) ||
    settings.privateReply !== null
  );
}

export function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}
