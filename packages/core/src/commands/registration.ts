import { z } from 'zod';
import type {
  CommandDefinition,
  ContextMenuDefinition,
  ContextMenuType,
} from '../modules/manifest.ts';
import type { ModuleRegistry } from '../modules/registry.ts';
import { applyCommandSettings, type CommandIssue, validateCommand } from './effective.ts';
import type { ChatCommandData, CommandData, ContextMenuData } from './fields.ts';
import { type CommandKind, commandLabel, resolveCommandNames } from './names.ts';
import { type CommandSettings, commandSettingsSchema, isCustomized } from './settings.ts';

export type CatalogueEntry =
  | {
      key: string;
      kind: 'chat';
      moduleId: string;
      command: CommandDefinition;
      menu?: undefined;
      data: ChatCommandData;
      alwaysRegistered: boolean;
    }
  | {
      key: string;
      kind: ContextMenuType;
      moduleId: string;
      command?: undefined;
      menu: ContextMenuDefinition;
      data: ContextMenuData;
      alwaysRegistered: boolean;
    };

export type StoredCommandSettings = CommandSettings & { updatedAt?: string | null | undefined };

export const recordedCommandSchema = z.object({
  key: z.string(),
  id: z.string(),
  name: z.string(),
});

export type RecordedCommand = z.infer<typeof recordedCommandSchema>;

export type EffectiveCommandBody = CommandData & { id?: string };

export interface EffectiveCommand {
  key: string;
  kind: CommandKind;
  body: EffectiveCommandBody;
}

export interface EffectiveCommandSetInput {
  catalogue: readonly CatalogueEntry[];
  modulesOn: Readonly<Record<string, boolean>>;
  settings: Readonly<Record<string, StoredCommandSettings>>;
  recorded?: readonly RecordedCommand[] | undefined;
}

export interface EffectiveCommandSet {
  commands: EffectiveCommand[];
  ignored: Record<string, string>;
  refused: string[];
}

export function contextMenuKey(type: ContextMenuType, name: string): string {
  return `${type}:${name}`;
}

export function commandCatalogue(registry: Pick<ModuleRegistry, 'all'>): CatalogueEntry[] {
  const entries: CatalogueEntry[] = [];

  for (const manifest of registry.all()) {
    for (const command of manifest.commands ?? []) {
      entries.push({
        key: command.name,
        kind: 'chat',
        moduleId: manifest.id,
        command,
        data: command.data,
        alwaysRegistered: command.alwaysRegistered === true,
      });
    }

    for (const menu of manifest.contextMenus ?? []) {
      entries.push({
        key: contextMenuKey(menu.type, menu.name),
        kind: menu.type,
        moduleId: manifest.id,
        menu,
        data: menu.data,
        alwaysRegistered: false,
      });
    }
  }

  return entries;
}

function refused(entry: CatalogueEntry, issues: readonly CommandIssue[]): string {
  return (
    `Discord would refuse the saved changes to ${commandLabel(entry.kind, entry.data.name)}, so ` +
    `it is registered with Proton's defaults until they are fixed: ${issues[0]?.message ?? ''}`
  );
}

type SettingsOf = (key: string) => StoredCommandSettings;

function settingsReader(settings: EffectiveCommandSetInput['settings']): SettingsOf {
  return (key) =>
    (Object.hasOwn(settings, key) ? settings[key] : undefined) ?? commandSettingsSchema.parse({});
}

interface NamePlan {
  names: Record<string, string>;
  customized: ReadonlySet<string>;
  ignored: Record<string, string>;
  refused: Set<string>;
}

function planNames(catalogue: readonly CatalogueEntry[], settingsOf: SettingsOf): NamePlan {
  const ignored: Record<string, string> = {};
  const customized = new Set<string>();
  const refusedKeys = new Set<string>();

  const entries = catalogue.map((entry) => {
    const settings = settingsOf(entry.key);
    let customName: string | null = null;

    if (entry.kind === 'chat' && isCustomized(settings)) {
      const issues = validateCommand(applyCommandSettings(entry.data, settings));
      if (issues.length > 0) {
        ignored[entry.key] = refused(entry, issues);
        refusedKeys.add(entry.key);
      } else {
        customized.add(entry.key);
        customName = settings.name;
      }
    }

    return {
      key: entry.key,
      kind: entry.kind,
      defaultName: entry.data.name,
      customName,
      updatedAt: settings.updatedAt ?? null,
    };
  });

  const resolved = resolveCommandNames(entries);
  Object.assign(ignored, resolved.ignored);

  return { names: resolved.names, customized, ignored, refused: refusedKeys };
}

function customizedBody(
  entry: Extract<CatalogueEntry, { kind: 'chat' }>,
  settings: StoredCommandSettings,
  plan: NamePlan,
): { data: ChatCommandData; issues: CommandIssue[] } {
  const name = plan.names[entry.key] ?? entry.data.name;
  const data = applyCommandSettings(entry.data, {
    ...settings,
    name: name === entry.data.name ? null : name,
  });
  return { data, issues: validateCommand(data) };
}

export function effectiveCommandNames(
  input: Pick<EffectiveCommandSetInput, 'catalogue' | 'settings'>,
): Record<string, string> {
  const settingsOf = settingsReader(input.settings);
  const plan = planNames(input.catalogue, settingsOf);

  return Object.fromEntries(
    input.catalogue.map((entry) => {
      if (entry.kind !== 'chat' || !plan.customized.has(entry.key)) {
        return [entry.key, entry.data.name];
      }
      const { data, issues } = customizedBody(entry, settingsOf(entry.key), plan);
      return [entry.key, issues.length === 0 ? data.name : entry.data.name];
    }),
  );
}

export function effectiveCommandSet(input: EffectiveCommandSetInput): EffectiveCommandSet {
  const settingsOf = settingsReader(input.settings);
  const plan = planNames(input.catalogue, settingsOf);
  const ignored = plan.ignored;

  const recorded = new Map((input.recorded ?? []).map((record) => [record.key, record]));
  const commands: EffectiveCommand[] = [];

  for (const entry of input.catalogue) {
    const settings = settingsOf(entry.key);
    const on = input.modulesOn[entry.moduleId] === true || entry.alwaysRegistered;
    if (!on || !settings.enabled) continue;

    let body: EffectiveCommandBody = structuredClone(entry.data);

    if (entry.kind === 'chat' && plan.customized.has(entry.key)) {
      const { data, issues } = customizedBody(entry, settings, plan);

      if (issues.length === 0) {
        body = data;
      } else {
        ignored[entry.key] = refused(entry, issues);
        plan.refused.add(entry.key);
      }
    }

    const record = recorded.get(entry.key);
    if (record && record.name !== body.name) body.id = record.id;

    commands.push({ key: entry.key, kind: entry.kind, body });
  }

  return {
    commands,
    ignored,
    refused: input.catalogue.map(({ key }) => key).filter((key) => plan.refused.has(key)),
  };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, stable(record[key])]),
  );
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stable(value));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function commandSetFingerprint(commands: readonly EffectiveCommand[]): string {
  return stableJson(
    [...commands]
      .sort((a, b) => compare(a.kind, b.kind) || compare(a.key, b.key))
      .map(({ key, kind, body }) => {
        const { id: _id, ...rest } = body;
        return { key, kind, body: rest };
      }),
  );
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function commandSetHash(commands: readonly EffectiveCommand[]): Promise<string> {
  return sha256Hex(commandSetFingerprint(commands));
}

export function definitionHash(data: CommandData): Promise<string> {
  return sha256Hex(stableJson(data));
}
