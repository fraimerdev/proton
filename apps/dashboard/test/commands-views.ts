import {
  type CommandSettingsView,
  type CommandView,
  commandCatalogue,
  commandFields,
  commandViewSchema,
  fixedSize,
  type ReplyControl,
} from '@proton/core';
import { MODULES } from '@proton/modules';

export const CATALOGUE = commandCatalogue({ all: () => MODULES });

export const MODERATION_REPLY: ReplyControl = {
  supported: true,
  paths: [
    { path: 'add', default: 'private', toggleable: true },
    { path: 'remove', default: 'private', toggleable: true },
  ],
  inheritsFrom: { label: 'Moderation → Reply publicly', moduleId: 'moderation' },
};

export interface ViewPatch {
  settings?: Partial<CommandSettingsView>;
  effectiveName?: string;
  moduleOn?: boolean;
  alwaysRegistered?: boolean;
  ignored?: string | null;
  refused?: boolean;
  definitionHash?: string;
  reply?: ReplyControl | null;
}

export function viewOf(key: string, patch: ViewPatch = {}): CommandView {
  const entry = CATALOGUE.find((candidate) => candidate.key === key);
  if (!entry) throw new Error(`no shipped command ${key}`);

  const manifest = MODULES.find((module) => module.id === entry.moduleId);

  return commandViewSchema.parse({
    key: entry.key,
    kind: entry.kind,
    moduleId: entry.moduleId,
    moduleName: manifest?.name ?? entry.moduleId,
    moduleOn: patch.moduleOn ?? true,
    alwaysRegistered: patch.alwaysRegistered ?? entry.alwaysRegistered,
    name: entry.data.name,
    description: entry.kind === 'chat' ? entry.data.description : '',
    fields: entry.kind === 'chat' ? commandFields(entry.data) : [],
    fixedSize: fixedSize(entry.data),
    definitionHash: patch.definitionHash ?? `hash-${entry.key}`,
    settings: { updatedAt: null, ...patch.settings },
    effectiveName: patch.effectiveName ?? patch.settings?.name ?? entry.data.name,
    ignored: patch.ignored ?? null,
    refused: patch.refused ?? false,
    reply: patch.reply ?? null,
  });
}

export function shippedData(key: string) {
  const entry = CATALOGUE.find((candidate) => candidate.key === key);
  if (!entry) throw new Error(`no shipped command ${key}`);
  return entry.data;
}
