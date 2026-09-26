import {
  type CatalogueEntry,
  type ChatCommandData,
  type CommandKind,
  contextMenuKey,
  type Logger,
  leafPaths,
  OptionType,
  type RawOption,
  subcommandPath,
} from '@proton/core';
import type { CommandRegistrationRecord } from '@proton/db';

export const UPDATING_REFUSAL = "This server's commands are updating. Try again in a few seconds.";

export function outdatedRefusal(invoked: string, current: string | null, commandsPage: string) {
  const stale = `That copy of /${invoked} is out of date`;
  if (current === null) {
    return (
      `${stale}, and this server has no current /${invoked} to use instead. A server admin can ` +
      `manage commands at ${commandsPage}.`
    );
  }
  return current === invoked
    ? `${stale}. Pick the other /${invoked} in the command list.`
    : `${stale}. Use /${current} instead.`;
}

export type CommandResolution =
  | { key: string; displayName: string }
  | { unresolved: 'updating' }
  | { unresolved: 'outdated'; current: string | null };

export interface CommandResolverPort {
  resolve(guildId: string, d: Record<string, unknown>): Promise<CommandResolution>;
}

interface CodeOption {
  name: string;
  type?: number;
  options?: CodeOption[];
}

function nested(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function kindOf(type: unknown): CommandKind {
  if (type === 2) return 'user';
  if (type === 3) return 'message';
  return 'chat';
}

function recordedKey(record: CommandRegistrationRecord | null, id: string | null): string | null {
  if (!record || !id || !Object.hasOwn(record.idHistory, id)) return null;
  return record.idHistory[id] ?? null;
}

function holdsCodeNames(record: CommandRegistrationRecord | null): boolean {
  if (record === null) return true;
  const status = record.failure?.status ?? null;
  return !record.syncedAt && status !== null && status >= 400 && status < 500;
}

export function invokedKey(kind: CommandKind, name: string): string {
  return kind === 'chat' ? name : contextMenuKey(kind, name);
}

function unwrap(raw: readonly RawOption[]): readonly RawOption[] {
  let current = raw;
  if (current.length === 1 && current[0]?.type === OptionType.SubcommandGroup) {
    current = current[0].options ?? [];
  }
  if (current.length === 1 && current[0]?.type === OptionType.Subcommand) {
    current = current[0].options ?? [];
  }
  return current;
}

function leafOptions(data: ChatCommandData, path: string): readonly CodeOption[] {
  let current = (data.options ?? []) as readonly CodeOption[];
  for (const name of path === '' ? [] : path.split('.')) {
    current = current.find((option) => option.name === name)?.options ?? [];
  }
  return current;
}

export function fitsDefinition(data: ChatCommandData, raw: readonly RawOption[] | undefined) {
  const options = raw ?? [];
  const path = subcommandPath(options);
  if (!leafPaths(data).includes(path)) return false;

  const code = leafOptions(data, path);
  return unwrap(options).every((option) => {
    const declared = code.find((candidate) => candidate.name === option.name);
    return declared !== undefined && declared.type === option.type;
  });
}

export interface CommandResolverDeps {
  catalogue: readonly CatalogueEntry[];
  records: {
    get(guildId: string): Promise<CommandRegistrationRecord | null>;
    refresh(guildId: string): Promise<CommandRegistrationRecord | null>;
  };
  reconcile?(guildId: string): void;
  logger: Logger;
}

export class CommandResolver implements CommandResolverPort {
  readonly #deps: CommandResolverDeps;
  readonly #entries: ReadonlyMap<string, CatalogueEntry>;

  constructor(deps: CommandResolverDeps) {
    this.#deps = deps;
    this.#entries = new Map(deps.catalogue.map((entry) => [entry.key, entry]));
  }

  async resolve(guildId: string, d: Record<string, unknown>): Promise<CommandResolution> {
    const data = d.data;
    const name = str(nested(data, 'name')) ?? '';
    const id = str(nested(data, 'id'));
    const kind = kindOf(nested(data, 'type'));

    const global = !str(nested(data, 'guild_id'));
    let key: string | null;
    if (global) {
      key = invokedKey(kind, name);
    } else {
      let record: CommandRegistrationRecord | null;
      try {
        record = await this.#deps.records.get(guildId);
        key = recordedKey(record, id);

        if (key === null && id && record) {
          record = await this.#deps.records.refresh(guildId);
          key = recordedKey(record, id);
        }
      } catch (error) {
        this.#deps.logger.error(
          `could not read which commands Proton registered in server ${guildId}, so ` +
            `${kind === 'chat' ? `/${name}` : name} was refused rather than guessed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          { guildId },
        );
        return { unresolved: 'updating' };
      }

      if (key === null && !holdsCodeNames(record)) {
        return this.#drifted(guildId, `command id ${id ?? '(none)'} is not one Proton registered`);
      }
      // A server whose first PUT Discord refused still holds code names; refusing locks it out.
      key ??= invokedKey(kind, name);
    }

    const entry = this.#entries.get(key);
    let drift: string | null = null;
    if (entry && entry.kind !== kind) {
      drift = `${key} was invoked as a ${kind} command`;
    } else if (entry?.kind === 'chat') {
      const options = nested(data, 'options');
      if (!fitsDefinition(entry.data, Array.isArray(options) ? (options as RawOption[]) : [])) {
        drift = `/${name} arrived with options /${key} no longer has`;
      }
    }

    if (drift !== null) {
      return global ? this.#staleGlobal(guildId, key, name, drift) : this.#drifted(guildId, drift);
    }
    return { key, displayName: name };
  }

  async displayName(guildId: string, key: string): Promise<string> {
    try {
      const record = await this.#deps.records.get(guildId);
      return record?.commands.find((command) => command.key === key)?.name ?? key;
    } catch {
      return key;
    }
  }

  async #staleGlobal(
    guildId: string,
    key: string,
    name: string,
    why: string,
  ): Promise<CommandResolution> {
    let record: CommandRegistrationRecord | null = null;
    try {
      record = await this.#deps.records.get(guildId);
    } catch {
      record = null;
    }
    if (!record?.syncedAt) return this.#drifted(guildId, why);

    const current = record.commands.find((command) => command.key === key)?.name ?? null;
    const pointedAt =
      current === null
        ? 'the Commands page, as the server has no copy'
        : `the server's /${current}`;
    this.#deps.logger.info(
      `a member in server ${guildId} used Proton's old global /${name} (${why}); it was refused ` +
        `and pointed at ${pointedAt}, since registering the server again cannot change a global copy`,
      { guildId },
    );
    return { unresolved: 'outdated', current };
  }

  #drifted(guildId: string, why: string): CommandResolution {
    this.#deps.logger.warn(
      `server ${guildId}'s commands differ from what Proton registered (${why}), so the ` +
        'command was refused and the server is being registered again',
      { guildId },
    );
    this.#deps.reconcile?.(guildId);
    return { unresolved: 'updating' };
  }
}
