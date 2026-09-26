import {
  type CatalogueEntry,
  type CommandLabeler,
  type CommandWorkerView,
  effectiveCommandNames,
  formatCommandLabel,
  type Logger,
} from '@proton/core';
import type { CommandRegistrationRecord } from '@proton/db';

export interface CommandLabelSource {
  forGuild(guildId: string): Promise<CommandLabeler>;
}

export const internalLabel: CommandLabeler = (key, path) => formatCommandLabel(key, path);

export interface CommandLabelsDeps {
  catalogue: readonly CatalogueEntry[];
  records: { get(guildId: string): Promise<CommandRegistrationRecord | null> };
  settings: { get(guildId: string): Promise<CommandWorkerView> };
  inScope(guildId: string): boolean;
  logger: Logger;
}

type Names = ReadonlyMap<string, string>;

const NONE: Names = new Map();

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class CommandLabels implements CommandLabelSource {
  readonly #deps: CommandLabelsDeps;
  readonly #registered = new WeakMap<CommandRegistrationRecord, Names>();
  readonly #effective = new WeakMap<CommandWorkerView, Names>();
  #recordsFailing = false;
  #settingsFailing = false;

  constructor(deps: CommandLabelsDeps) {
    this.#deps = deps;
  }

  async forGuild(guildId: string): Promise<CommandLabeler> {
    const [registered, effective] = await Promise.all([
      this.#fromRecord(guildId),
      this.#fromSettings(guildId),
    ]);
    if (registered.size === 0 && effective.size === 0) return internalLabel;

    return (key, path) => formatCommandLabel(key, path, registered.get(key) ?? effective.get(key));
  }

  async #fromRecord(guildId: string): Promise<Names> {
    let record: CommandRegistrationRecord | null;
    try {
      record = await this.#deps.records.get(guildId);
    } catch (error) {
      if (!this.#recordsFailing) {
        this.#recordsFailing = true;
        this.#deps.logger.warn(
          'could not read which commands Proton registered, so its messages name commands by ' +
            `their saved settings or built-in names until it can be read again: ${detailOf(error)}`,
          { guildId },
        );
      }
      return NONE;
    }

    this.#recordsFailing = false;
    if (!record) return NONE;

    const known = this.#registered.get(record);
    if (known) return known;

    const names: Names = new Map(record.commands.map((command) => [command.key, command.name]));
    this.#registered.set(record, names);
    return names;
  }

  async #fromSettings(guildId: string): Promise<Names> {
    // Outside the registration scope nothing Proton saved ever reached Discord.
    if (!this.#deps.inScope(guildId)) return NONE;

    let view: CommandWorkerView;
    try {
      view = await this.#deps.settings.get(guildId);
    } catch (error) {
      if (!this.#settingsFailing) {
        this.#settingsFailing = true;
        this.#deps.logger.warn(
          "could not read the per-server command settings, so Proton's messages name commands " +
            'by what Discord was last given or their built-in names until they can be read ' +
            `again: ${detailOf(error)}`,
          { guildId },
        );
      }
      return NONE;
    }

    this.#settingsFailing = false;

    const known = this.#effective.get(view);
    if (known) return known;

    const renamed = new Map<string, string>();
    try {
      const names = effectiveCommandNames({
        catalogue: this.#deps.catalogue,
        settings: view.settings,
      });
      for (const entry of this.#deps.catalogue) {
        const name = names[entry.key];
        if (name !== undefined && name !== entry.data.name) renamed.set(entry.key, name);
      }
    } catch (error) {
      this.#deps.logger.error(
        `could not work out the command names of server ${guildId}, so Proton's messages name ` +
          `commands by what Discord was last given or their built-in names: ${detailOf(error)}`,
        { guildId },
      );
    }

    this.#effective.set(view, renamed);
    return renamed;
  }
}
