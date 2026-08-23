import { describe, expect, test } from 'bun:test';
import {
  type CaseInput,
  type CaseRecorder,
  type DedupeStore,
  DefaultActionExecutor,
  type GuildRole,
  type GuildState,
  type GuildStateStore,
  type Logger,
  type ModuleContext,
  newId,
  Permissions,
  type PrecheckInput,
  type ProtonEvent,
  type ResolveContextHints,
  type RestProxyClient,
  type RestRequestOptions,
  type RestResponse,
  resolvePrecheckContext,
} from '@proton/core';
import { ComponentType } from 'discord-api-types/v10';
import { customIdFor } from '../src/component-id.ts';
import { type MessagesConfig, messagesDefaultConfig, templatesSchema } from '../src/config.ts';
import type { MessagesDeps } from '../src/deps.ts';
import { handleComponentPress } from '../src/interactions-component.ts';

const GUILD = '900000000000000001';
const OWNER = '200000000000000001';
const BOT = '300000000000000001';
const APPLICATION = '800000000000000001';
const MEMBER = '100000000000000001';
const CHANNEL = '500000000000000001';
const INTERACTION = '600000000000000001';
const MESSAGE = '700000000000000009';

const BLUE_ROLE = '410000000000000001';
const RED_ROLE = '410000000000000002';

const EVERYONE_ROLE = GUILD;
const BOT_ROLE = '410000000000000005';

const EPHEMERAL = 64;

const FULL_PERMISSIONS =
  Permissions.ViewChannel |
  Permissions.SendMessages |
  Permissions.EmbedLinks |
  Permissions.ManageRoles;

function guildState(botPermissions: bigint): GuildState {
  return {
    guildId: GUILD,
    ownerId: OWNER,
    everyoneRoleId: EVERYONE_ROLE,
    roles: new Map<string, GuildRole>([
      [EVERYONE_ROLE, { id: EVERYONE_ROLE, permissions: Permissions.ViewChannel, position: 0 }],
      [BOT_ROLE, { id: BOT_ROLE, permissions: botPermissions, position: 5 }],
    ]),
    botRoleIds: [BOT_ROLE],
    channels: new Map([[CHANNEL, { id: CHANNEL, parentId: null, overwrites: [] }]]),
    updatedAt: Date.now(),
  };
}

class MemoryDedupe implements DedupeStore {
  readonly #claimed = new Set<string>();

  async claim(key: string): Promise<boolean> {
    if (this.#claimed.has(key)) return false;
    this.#claimed.add(key);
    return true;
  }

  async release(key: string): Promise<void> {
    this.#claimed.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return this.#claimed.has(key);
  }
}

class MemoryRecorder implements CaseRecorder {
  readonly recorded: CaseInput[] = [];

  async record(input: CaseInput): Promise<{ caseId: string }> {
    this.recorded.push(input);
    return { caseId: newId() };
  }
}

class FakeRest implements RestProxyClient {
  readonly calls: RestRequestOptions[] = [];
  response: RestResponse = { status: 200, body: {} };

  async request(options: RestRequestOptions): Promise<RestResponse> {
    this.calls.push(options);
    return this.response;
  }
}

interface CallBody {
  type?: number;
  data?: { content?: string; flags?: number };
  content?: string;
  flags?: number;
}

interface PressOptions {
  customId: string;
  roles?: string[];
  values?: string[];
  componentType?: number;
}

function pressEvent(options: PressOptions): ProtonEvent {
  return {
    id: newId(),
    type: 'interaction.component',
    guildId: GUILD,
    occurredAt: Date.now(),
    payload: {
      id: INTERACTION,
      application_id: APPLICATION,
      type: 3,
      token: 'component-token',
      guild_id: GUILD,
      channel_id: CHANNEL,
      member: { user: { id: MEMBER }, roles: options.roles ?? [] },
      message: { id: MESSAGE },
      data: {
        custom_id: options.customId,
        component_type: options.componentType ?? ComponentType.Button,
        ...(options.values ? { values: options.values } : {}),
      },
    },
  };
}

function templates(...messages: unknown[]): MessagesConfig['templates'] {
  return templatesSchema.parse(messages);
}

interface Overrides {
  config: Partial<MessagesConfig>;
  deps: MessagesDeps;
  botPermissions: bigint;
}

function harness(seed: MessagesDeps = { applicationId: APPLICATION }) {
  const rest = new FakeRest();
  const recorder = new MemoryRecorder();
  const dedupe = new MemoryDedupe();
  const logs: Array<{ level: string; message: string }> = [];

  let botPermissions = FULL_PERMISSIONS;

  const logger: Logger = {
    info: (message) => logs.push({ level: 'info', message }),
    warn: (message) => logs.push({ level: 'warn', message }),
    error: (message) => logs.push({ level: 'error', message }),
  };

  const store: GuildStateStore = {
    get: async () => guildState(botPermissions),
    put: async () => undefined,
    patch: async () => undefined,
    delete: async () => undefined,
  };

  const executor = new DefaultActionExecutor({
    dedupe,
    rest,
    recorder,
    resolveContext: async (
      request,
      hints,
    ): Promise<PrecheckInput | { failure: { code: string; humanReason: string } }> => {
      const resolved = await resolvePrecheckContext(
        { store, botUserId: BOT, fetchMemberRoles: async () => [] },
        request,
        (hints ?? {}) as ResolveContextHints,
      );
      return 'context' in resolved ? resolved.context : resolved;
    },
  });

  const bodies = (): CallBody[] => rest.calls.map((call) => (call.body ?? {}) as CallBody);

  const said = (): string[] => {
    const lines: string[] = [];
    for (const body of bodies()) {
      const content = body.data?.content ?? body.content;
      if (typeof content === 'string') lines.push(content);
    }
    return lines;
  };

  return {
    rest,
    recorder,
    logs,

    bodies,
    said,
    lastSaid: (): string | null => said().at(-1) ?? null,

    roleCalls: (): RestRequestOptions[] =>
      rest.calls.filter((call) => call.path.includes('/roles/')),

    followUps: (): CallBody[] =>
      rest.calls
        .filter((call) => call.path.startsWith('/webhooks/'))
        .map((call) => call.body as CallBody),

    async press(event: ProtonEvent, overrides: Partial<Overrides> = {}) {
      botPermissions = overrides.botPermissions ?? FULL_PERMISSIONS;

      const ctx: ModuleContext<MessagesConfig> = {
        guildId: GUILD,
        config: { ...messagesDefaultConfig, enabled: true, ...overrides.config },
        tier: 'free',
        executor: executor.scoped({ channelId: CHANNEL, appPermissions: botPermissions }),
        logger,
      };

      return handleComponentPress(event, ctx, overrides.deps ?? seed);
    },
  };
}

const ROLE_MESSAGE = {
  name: 'roles',
  content: 'Pick a colour',
  components: [
    {
      kind: 'buttons',
      buttons: [
        {
          key: 'blue',
          style: 'primary',
          label: 'Blue',
          action: { kind: 'role', mode: 'toggle', roleId: BLUE_ROLE },
        },
        {
          key: 'help',
          style: 'secondary',
          label: 'Help',
          action: { kind: 'reply', content: 'Press a colour to get it.', ephemeral: true },
        },
      ],
    },
  ],
};

const SELECT_MESSAGE = {
  name: 'picker',
  content: 'Pick colours',
  components: [
    {
      kind: 'select',
      select: {
        key: 'colours',
        minValues: 1,
        maxValues: 2,
        options: [
          {
            key: 'blue',
            label: 'Blue',
            action: { kind: 'role', mode: 'add', roleId: BLUE_ROLE },
          },
          {
            key: 'red',
            label: 'Red',
            action: { kind: 'role', mode: 'add', roleId: RED_ROLE },
          },
        ],
      },
    },
  ],
};

const blueButton = customIdFor('roles')('blue');
const helpButton = customIdFor('roles')('help');

describe('embeds component presses', () => {
  test('a toggle button gives the role, and a second press takes it back', async () => {
    const h = harness();
    const config = { templates: templates(ROLE_MESSAGE) };

    const first = await h.press(pressEvent({ customId: blueButton, roles: [] }), { config });

    expect(first).toEqual({
      action: 'applied',
      messageName: 'roles',
      added: [BLUE_ROLE],
      removed: [],
      replies: 0,
    });
    expect(h.roleCalls()).toHaveLength(1);
    expect(h.roleCalls()[0]?.method).toBe('PUT');
    expect(h.roleCalls()[0]?.path).toBe(`/guilds/${GUILD}/members/${MEMBER}/roles/${BLUE_ROLE}`);
    expect(h.lastSaid()).toContain(`Gave you <@&${BLUE_ROLE}>`);

    const second = await h.press(pressEvent({ customId: blueButton, roles: [BLUE_ROLE] }), {
      config,
    });

    expect(second).toEqual({
      action: 'applied',
      messageName: 'roles',
      added: [],
      removed: [BLUE_ROLE],
      replies: 0,
    });
    expect(h.roleCalls()).toHaveLength(2);
    expect(h.roleCalls()[1]?.method).toBe('DELETE');
    expect(h.lastSaid()).toContain(`Took away <@&${BLUE_ROLE}>`);
  });

  test('a reply button answers with the stored text and changes no roles', async () => {
    const h = harness();

    const outcome = await h.press(pressEvent({ customId: helpButton }), {
      config: { templates: templates(ROLE_MESSAGE) },
    });

    expect(outcome).toEqual({
      action: 'applied',
      messageName: 'roles',
      added: [],
      removed: [],
      replies: 1,
    });
    expect(h.roleCalls()).toHaveLength(0);

    const followUps = h.followUps();
    expect(followUps).toHaveLength(1);
    expect(followUps[0]?.content).toBe('Press a colour to get it.');
    expect(followUps[0]?.flags).toBe(EPHEMERAL);
  });

  test('a dropdown applies every option that was picked', async () => {
    const h = harness();

    const outcome = await h.press(
      pressEvent({
        customId: customIdFor('picker')('colours'),
        componentType: ComponentType.StringSelect,
        values: ['blue', 'red'],
      }),
      { config: { templates: templates(SELECT_MESSAGE) } },
    );

    expect(outcome).toMatchObject({ action: 'applied', added: [BLUE_ROLE, RED_ROLE] });
    expect(h.roleCalls().map((call) => call.method)).toEqual(['PUT', 'PUT']);
  });

  test('a press on a message that no longer exists says which name is gone', async () => {
    const h = harness();

    const outcome = await h.press(pressEvent({ customId: customIdFor('gone')('blue') }), {
      config: { templates: templates(ROLE_MESSAGE) },
    });

    expect(outcome).toEqual({ action: 'refused', reason: "no saved message 'gone'" });
    expect(h.roleCalls()).toHaveLength(0);
    expect(h.lastSaid()).toContain("'gone'");
    expect(h.lastSaid()).toContain('Modules → Embeds');
  });

  test('a press on a key the message no longer carries says which key is gone', async () => {
    const h = harness();

    const outcome = await h.press(pressEvent({ customId: customIdFor('roles')('green') }), {
      config: { templates: templates(ROLE_MESSAGE) },
    });

    expect(outcome).toEqual({ action: 'refused', reason: "no component 'green' on 'roles'" });
    expect(h.roleCalls()).toHaveLength(0);
    expect(h.lastSaid()).toContain("'green'");
    expect(h.lastSaid()).toContain('Modules → Embeds');
  });

  test('a press while the module is switched off says so instead of failing silently', async () => {
    const h = harness();

    const outcome = await h.press(pressEvent({ customId: blueButton, roles: [] }), {
      config: { enabled: false, templates: templates(ROLE_MESSAGE) },
    });

    expect(outcome).toEqual({
      action: 'refused',
      reason: 'embeds is switched off in this server',
    });
    expect(h.roleCalls()).toHaveLength(0);
    expect(h.lastSaid()).toContain('switched off in this server');
  });

  test('a press on another module’s component is left alone', async () => {
    const h = harness();

    const outcome = await h.press(pressEvent({ customId: 'proton:rolemenu:colours:blue' }), {
      config: { templates: templates(ROLE_MESSAGE) },
    });

    expect(outcome).toEqual({ action: 'ignored', reason: 'another module owns that component' });
    expect(h.rest.calls).toHaveLength(0);
  });

  test('a role press with no application id refuses instead of leaving a dead interaction', async () => {
    const h = harness({});

    const outcome = await h.press(pressEvent({ customId: blueButton, roles: [] }), {
      config: { templates: templates(ROLE_MESSAGE) },
    });

    expect(outcome).toEqual({ action: 'refused', reason: 'the follow-up port is unbound' });
    expect(h.roleCalls()).toHaveLength(0);
    expect(h.logs.some((entry) => entry.message.includes('createMessagesModule'))).toBe(true);
  });

  test('a role press without Manage Roles names the permission it is missing', async () => {
    const h = harness();

    const outcome = await h.press(pressEvent({ customId: blueButton, roles: [] }), {
      config: { templates: templates(ROLE_MESSAGE) },
      botPermissions: Permissions.ViewChannel | Permissions.SendMessages,
    });

    expect(outcome).toMatchObject({ action: 'refused' });
    expect(h.lastSaid()).toContain('ManageRoles');
  });
});
