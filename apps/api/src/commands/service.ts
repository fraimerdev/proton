import {
  applyCommandSettings,
  type CatalogueEntry,
  type CommandCatalogueView,
  type CommandChange,
  type CommandEnabledBody,
  type CommandInput,
  type CommandIssue,
  type CommandNameEntry,
  type CommandSettings,
  type CommandSettingsView,
  type CommandSyncView,
  type CommandUpdateBody,
  type CommandUpdateResult,
  type CommandView,
  type CommandWorkerView,
  commandCatalogue,
  commandFields,
  commandLabel,
  commandSetHash,
  commandSettingsSchema,
  commandSettingsViewSchema,
  definitionHash,
  type EffectiveCommandSet,
  type EventBus,
  effectiveCommandSet,
  fixedSize,
  isCustomized,
  type Logger,
  type ModuleRegistry,
  nameClash,
  newId,
  normalizeCommandInput,
  normalizeCommandName,
  type ReplyControl,
  replyControl,
  resetCustomization,
  stableJson,
  validateCommand,
} from '@proton/core';
import type {
  CommandRegistrationRecord,
  CommandRegistrationScope,
  DrizzleCommandRegistrationStore,
  DrizzleCommandSettingsStore,
  GuildCommandSettings,
} from '@proton/db';
import type { ModuleConfigService, ModuleState } from '../modules/service.ts';

export type CommandSettingsErrorCode = 'unknown_command' | 'command_changed';

export class CommandSettingsError extends Error {
  readonly code: CommandSettingsErrorCode;

  constructor(code: CommandSettingsErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'CommandSettingsError';
  }
}

export type CommandScope = {
  scope: CommandRegistrationScope;
  testGuildId: string | null;
};

export type CommandAuditStamp = Omit<CommandEnabledBody, 'enabled'>;

export interface CommandSettingsServiceOptions {
  registry: Pick<ModuleRegistry, 'all' | 'get'>;
  settings: Pick<DrizzleCommandSettingsStore, 'list' | 'write'>;
  registrations: Pick<DrizzleCommandRegistrationStore, 'get' | 'ackLostPermissions'>;
  modules: Pick<ModuleConfigService, 'moduleStates'>;
  scope: CommandScope;
  bus?: EventBus;
  logger?: Pick<Logger, 'error'>;
  now?(): number;
}

interface GuildCommands {
  catalogue: CatalogueEntry[];
  settings: GuildCommandSettings;
  states: Record<string, ModuleState>;
  standing: EffectiveCommandSet;
}

interface CommandChangeEvent {
  guildId: string;
  auditId: string;
  stamp: CommandAuditStamp;
  catalogue: CatalogueEntry[];
  entry: CatalogueEntry;
  before: GuildCommandSettings;
  after: GuildCommandSettings;
  changed: CommandChange[];
}

function defaultView(): CommandSettingsView {
  return commandSettingsViewSchema.parse({});
}

function settingsOf(settings: GuildCommandSettings, key: string): CommandSettingsView {
  return (Object.hasOwn(settings, key) ? settings[key] : undefined) ?? defaultView();
}

function modulesOnOf(states: Record<string, ModuleState>): Record<string, boolean> {
  return Object.fromEntries(Object.entries(states).map(([id, state]) => [id, state.on]));
}

function standingOf(catalogue: CatalogueEntry[], settings: GuildCommandSettings) {
  return effectiveCommandSet({
    catalogue,
    modulesOn: Object.fromEntries(catalogue.map((entry) => [entry.moduleId, true])),
    settings: Object.fromEntries(
      catalogue.map((entry) => [entry.key, { ...settingsOf(settings, entry.key), enabled: true }]),
    ),
  });
}

function nameOf(standing: EffectiveCommandSet, entry: CatalogueEntry): string {
  return (
    standing.commands.find((command) => command.key === entry.key)?.body.name ?? entry.data.name
  );
}

function nameEntries(guild: GuildCommands): CommandNameEntry[] {
  return guild.catalogue.map((entry) => {
    const held = nameOf(guild.standing, entry);

    return {
      key: entry.key,
      kind: entry.kind,
      defaultName: entry.data.name,
      customName: held === entry.data.name ? null : held,
      updatedAt: settingsOf(guild.settings, entry.key).updatedAt,
    };
  });
}

function sameTime(stored: string | null, expected: string | null): boolean {
  if (stored === null || expected === null) return stored === expected;

  const a = Date.parse(stored);
  const b = Date.parse(expected);
  return Number.isNaN(a) || Number.isNaN(b) ? stored === expected : a === b;
}

function withStoredName(
  next: CommandSettings,
  stored: CommandSettings,
  submitted: string | null,
  inEffect: string,
): CommandSettings {
  if (stored.name === null || !isCustomized(next)) return next;
  // The name in effect sent back unedited is no request to drop a saved name Proton is not using.
  return normalizeCommandName(submitted) === inEffect ? { ...next, name: stored.name } : next;
}

function changesBetween(before: CommandSettings, after: CommandSettings): CommandChange[] {
  const changed: CommandChange[] = [];

  if (before.name !== after.name) changed.push('name');
  if (before.description !== after.description) changed.push('description');
  if (stableJson(before.optionDescriptions) !== stableJson(after.optionDescriptions)) {
    changed.push('options');
  }
  if (before.privateReply !== after.privateReply) changed.push('privateReply');
  if (before.enabled !== after.enabled) changed.push('enabled');

  return changed;
}

function labelOf(entry: CatalogueEntry): string {
  return commandLabel(entry.kind, entry.data.name);
}

function menuIssues(entry: CatalogueEntry, input: CommandInput): CommandIssue[] {
  const message =
    `${labelOf(entry)} is an Apps menu entry, so you can only turn it on or off. Discord shows ` +
    'it by name only, with no description, options or reply setting to change.';

  return [
    ...(input.name?.trim() ? [{ path: 'name', message }] : []),
    ...(input.description?.trim() ? [{ path: 'description', message }] : []),
    ...Object.entries(input.optionDescriptions)
      .filter(([, value]) => value.trim() !== '')
      .map(([path]) => ({ path: `options.${path}`, message })),
    ...(input.privateReply === null ? [] : [{ path: 'privateReply', message }]),
  ];
}

export function invalidCommandMessage(issues: readonly CommandIssue[]): string {
  const messages = new Set(issues.map((issue) => issue.message));
  return `Those changes were not saved: ${[...messages].join(' ')}`;
}

export class CommandSettingsService {
  readonly #registry: Pick<ModuleRegistry, 'all' | 'get'>;
  readonly #settings: Pick<DrizzleCommandSettingsStore, 'list' | 'write'>;
  readonly #registrations: Pick<DrizzleCommandRegistrationStore, 'get' | 'ackLostPermissions'>;
  readonly #modules: Pick<ModuleConfigService, 'moduleStates'>;
  readonly #scope: CommandScope;
  readonly #bus: EventBus | undefined;
  readonly #logger: Pick<Logger, 'error'>;
  readonly #now: () => number;
  readonly #definitionHashes = new Map<string, Promise<string>>();

  constructor(options: CommandSettingsServiceOptions) {
    this.#registry = options.registry;
    this.#settings = options.settings;
    this.#registrations = options.registrations;
    this.#modules = options.modules;
    this.#scope = options.scope;
    this.#bus = options.bus;
    this.#logger = options.logger ?? console;
    this.#now = options.now ?? Date.now;
  }

  async catalogue(guildId: string): Promise<CommandCatalogueView> {
    const catalogue = commandCatalogue(this.#registry);
    const [settings, states, record] = await Promise.all([
      this.#settings.list(guildId),
      this.#modules.moduleStates(guildId),
      this.#registrations.get(guildId),
    ]);

    const guild: GuildCommands = {
      catalogue,
      settings,
      states,
      standing: standingOf(catalogue, settings),
    };

    return {
      commands: await Promise.all(catalogue.map((entry) => this.#view(entry, guild))),
      sync: await this.#sync(guildId, guild, record),
      lostPermissions: record?.lostPermissions ?? null,
    };
  }

  async workerView(guildId: string): Promise<CommandWorkerView> {
    const [settings, states] = await Promise.all([
      this.#settings.list(guildId),
      this.#modules.moduleStates(guildId),
    ]);

    return { settings, modulesOn: modulesOnOf(states) };
  }

  async update(
    guildId: string,
    key: string,
    body: CommandUpdateBody,
  ): Promise<CommandUpdateResult> {
    const catalogue = commandCatalogue(this.#registry);
    const entry = this.#entry(catalogue, key);

    if ((await this.#definitionHash(entry)) !== body.definitionHash) {
      throw new CommandSettingsError(
        'command_changed',
        `Proton's own definition of ${labelOf(entry)} changed since this page was opened, so ` +
          'nothing was saved. Reload the page and make the change again.',
      );
    }

    const input: CommandInput = {
      name: body.name,
      description: body.description,
      optionDescriptions: body.optionDescriptions,
      privateReply: body.privateReply,
    };

    if (entry.kind !== 'chat' && isCustomized({ ...defaultView(), ...input })) {
      return { ok: false, issues: menuIssues(entry, input) };
    }

    const states = await this.#modules.moduleStates(guildId);
    const reply = this.#reply(entry, states);
    const auditId = newId();
    const stamp = { actorId: body.actorId, source: body.source, ipHash: body.ipHash };

    let before: GuildCommandSettings = {};
    let issues: CommandIssue[] = [];

    const written = await this.#settings.write(guildId, key, (current) => {
      before = current;
      const stored = settingsOf(current, key);

      if (!sameTime(stored.updatedAt, body.expectedUpdatedAt)) {
        throw new CommandSettingsError(
          'command_changed',
          `${labelOf(entry)} was changed somewhere else while you were editing it, so nothing ` +
            'was saved. Reload it to see the current settings, then make your change again.',
        );
      }

      const standing = standingOf(catalogue, current);
      const next =
        entry.kind === 'chat'
          ? withStoredName(
              normalizeCommandInput(entry.data, stored, input),
              stored,
              input.name,
              nameOf(standing, entry),
            )
          : resetCustomization(stored);

      issues =
        entry.kind === 'chat'
          ? this.#issues(entry, stored, next, reply, {
              catalogue,
              settings: current,
              states,
              standing,
            })
          : [];
      if (issues.length > 0) return null;

      return {
        next,
        audit: {
          id: auditId,
          actorId: stamp.actorId,
          source: stamp.source,
          action: 'command.update',
          before: { key, settings: commandSettingsSchema.parse(stored) },
          after: { key, settings: next },
          ipHash: stamp.ipHash ?? null,
        },
      };
    });

    if (written === null) return { ok: false, issues };

    await this.#publish({
      guildId,
      auditId,
      stamp,
      catalogue,
      entry,
      before,
      after: written.guild,
      changed: changesBetween(settingsOf(before, key), written.settings),
    });

    return { ok: true, command: await this.#viewAfter(entry, catalogue, written.guild, states) };
  }

  async setEnabled(
    guildId: string,
    key: string,
    body: CommandEnabledBody,
  ): Promise<{ command: CommandView }> {
    const catalogue = commandCatalogue(this.#registry);
    const entry = this.#entry(catalogue, key);
    const states = await this.#modules.moduleStates(guildId);
    const auditId = newId();
    const stamp = { actorId: body.actorId, source: body.source, ipHash: body.ipHash };

    let before: GuildCommandSettings = {};

    const written = await this.#settings.write(guildId, key, (current) => {
      before = current;
      const stored = settingsOf(current, key);

      return {
        next: { ...commandSettingsSchema.parse(stored), enabled: body.enabled },
        audit: {
          id: auditId,
          actorId: stamp.actorId,
          source: stamp.source,
          action: 'command.enabled',
          before: { key, enabled: stored.enabled },
          after: { key, enabled: body.enabled },
          ipHash: stamp.ipHash ?? null,
        },
      };
    });

    if (written === null) {
      throw new Error('the command switch was not written, which should not be possible');
    }

    await this.#publish({
      guildId,
      auditId,
      stamp,
      catalogue,
      entry,
      before,
      after: written.guild,
      changed: changesBetween(settingsOf(before, key), written.settings),
    });

    return { command: await this.#viewAfter(entry, catalogue, written.guild, states) };
  }

  async ackLostPermissions(guildId: string, stamp: CommandAuditStamp): Promise<{ ok: true }> {
    await this.#registrations.ackLostPermissions(guildId, (acked) => ({
      id: newId(),
      actorId: stamp.actorId,
      source: stamp.source,
      action: 'command.permissions_ack',
      before: { lostPermissions: acked },
      after: { lostPermissions: null },
      ipHash: stamp.ipHash ?? null,
    }));

    return { ok: true };
  }

  #entry(catalogue: readonly CatalogueEntry[], key: string): CatalogueEntry {
    const entry = catalogue.find((candidate) => candidate.key === key);
    if (!entry) {
      throw new CommandSettingsError('unknown_command', `Proton has no command called '${key}'.`);
    }
    return entry;
  }

  #definitionHash(entry: CatalogueEntry): Promise<string> {
    const held = this.#definitionHashes.get(entry.key);
    if (held) return held;

    const hash = definitionHash(entry.data);
    this.#definitionHashes.set(entry.key, hash);
    return hash;
  }

  #reply(entry: CatalogueEntry, states: Record<string, ModuleState>): ReplyControl | null {
    const policy = entry.kind === 'chat' ? entry.command.reply : undefined;
    if (!policy) return null;

    const configs = [
      states[entry.moduleId]?.config,
      this.#registry.get(entry.moduleId)?.defaultConfig,
    ];

    for (const config of configs) {
      try {
        return replyControl(policy, entry.data, config);
      } catch (error) {
        this.#logger.error(
          `${labelOf(entry)}'s reply default could not be read from its module config: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return null;
  }

  #issues(
    entry: Extract<CatalogueEntry, { kind: 'chat' }>,
    stored: CommandSettings,
    next: CommandSettings,
    reply: ReplyControl | null,
    guild: GuildCommands,
  ): CommandIssue[] {
    const issues = validateCommand(applyCommandSettings(entry.data, next));

    if (next.name !== stored.name && !issues.some((issue) => issue.path === 'name')) {
      const clash = nameClash(nameEntries(guild), entry.key, next.name);
      if (clash) issues.push({ path: 'name', message: clash });
    }

    // A hidden control resends the stored value, and a deploy can make a supported reply fixed.
    if (
      next.privateReply !== null &&
      next.privateReply !== stored.privateReply &&
      !reply?.supported
    ) {
      issues.push({
        path: 'privateReply',
        message:
          `${labelOf(entry)} always responds the same way, so whether it responds privately ` +
          "can't be changed.",
      });
    }

    return issues;
  }

  async #view(entry: CatalogueEntry, guild: GuildCommands): Promise<CommandView> {
    return {
      key: entry.key,
      kind: entry.kind,
      moduleId: entry.moduleId,
      moduleName: this.#registry.get(entry.moduleId)?.name ?? entry.moduleId,
      moduleOn: guild.states[entry.moduleId]?.on === true,
      alwaysRegistered: entry.alwaysRegistered,
      name: entry.data.name,
      description: entry.kind === 'chat' ? entry.data.description : '',
      fields: commandFields(entry.data),
      fixedSize: fixedSize(entry.data),
      definitionHash: await this.#definitionHash(entry),
      settings: settingsOf(guild.settings, entry.key),
      effectiveName: nameOf(guild.standing, entry),
      ignored: guild.standing.ignored[entry.key] ?? null,
      refused: guild.standing.refused.includes(entry.key),
      reply: this.#reply(entry, guild.states),
    };
  }

  #viewAfter(
    entry: CatalogueEntry,
    catalogue: CatalogueEntry[],
    settings: GuildCommandSettings,
    states: Record<string, ModuleState>,
  ): Promise<CommandView> {
    return this.#view(entry, {
      catalogue,
      settings,
      states,
      standing: standingOf(catalogue, settings),
    });
  }

  #elsewhere(guildId: string, record: CommandRegistrationRecord | null): boolean {
    const { scope, testGuildId } = this.#scope;

    if (record) return record.scope === 'guild' && testGuildId !== null && guildId !== testGuildId;
    return scope === 'guild' && guildId !== testGuildId;
  }

  async #sync(
    guildId: string,
    guild: GuildCommands,
    record: CommandRegistrationRecord | null,
  ): Promise<CommandSyncView> {
    const times = { checkedAt: record?.checkedAt ?? null, syncedAt: record?.syncedAt ?? null };

    if (this.#elsewhere(guildId, record)) {
      return { state: 'not-this-environment', ...times, failure: null };
    }
    if (!record) return { state: 'unsynced', ...times, failure: null };

    const expected = await commandSetHash(
      effectiveCommandSet({
        catalogue: guild.catalogue,
        modulesOn: modulesOnOf(guild.states),
        settings: guild.settings,
        recorded: record.commands,
      }).commands,
    );

    const failure = record.failure;
    if (failure && (failure.hash === null || failure.hash === expected)) {
      const { hash: _hash, ...shown } = failure;
      return { state: 'failed', ...times, failure: shown };
    }

    return {
      state: record.definitionHash === expected ? 'synced' : 'pending',
      ...times,
      failure: null,
    };
  }

  // Swallowed on purpose: the worker's sweep registers a change nobody announced.
  async #publish(change: CommandChangeEvent): Promise<void> {
    const bus = this.#bus;
    if (!bus || change.changed.length === 0) return;

    const { entry, guildId } = change;
    const beforeName = nameOf(standingOf(change.catalogue, change.before), entry);
    const afterName = nameOf(standingOf(change.catalogue, change.after), entry);
    const beforeSettings = settingsOf(change.before, entry.key);
    const afterSettings = settingsOf(change.after, entry.key);

    try {
      await bus.publish({
        id: `proton.commands_changed:${guildId}:${change.auditId}`,
        type: 'proton.commands_changed',
        guildId,
        occurredAt: this.#now(),
        payload: {
          auditId: change.auditId,
          guildId,
          actorId: change.stamp.actorId,
          source: change.stamp.source,
          key: entry.key,
          displayName: beforeName,
          newName: afterName === beforeName ? null : afterName,
          changed: change.changed,
          enabledBefore: beforeSettings.enabled,
          enabledAfter: afterSettings.enabled,
          registration: change.changed.some((kind) => kind !== 'privateReply'),
        },
      });
    } catch (error) {
      this.#logger.error(
        `${labelOf(entry)}'s settings were saved for guild ${guildId} but the change could not ` +
          'be published, so Discord is updated by the next command sync sweep instead: ' +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
