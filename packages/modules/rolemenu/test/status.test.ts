import { describe, expect, test } from 'bun:test';
import {
  type CaseInput,
  type CaseRecorder,
  type CommandContext,
  type CommandOptions,
  type DedupeStore,
  DefaultActionExecutor,
  encodeCustomId,
  type ModuleContext,
  newId,
  type PrecheckInput,
  type ProtonEvent,
  type RestProxyClient,
  type RestRequestOptions,
  type RestResponse,
  STATUS_ERROR_COLOUR,
  STATUS_ERROR_EMOJI,
  STATUS_SUCCESS_COLOUR,
  STATUS_SUCCESS_EMOJI,
} from '@proton/core';
import { rolemenuCommand } from '../src/commands.ts';
import { MODULE_ID, type RolemenuConfig } from '../src/config.ts';
import { handleComponent } from '../src/interactions.ts';

const GUILD = '900000000000000001';
const OWNER = '200000000000000001';
const BOT = '300000000000000001';
const APPLICATION = '400000000000000001';
const CHANNEL = '500000000000000001';
const MESSAGE = '1400000000000000001';
const MEMBER = '100000000000000002';
const ROLE = '800000000000000001';

const COMPONENT_INTERACTION = 3;
const BUTTON = 2;
const EPHEMERAL = 64;

const ROLE_PATH = `/guilds/${GUILD}/members/${MEMBER}/roles/${ROLE}`;

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
  async record(_input: CaseInput): Promise<{ caseId: string }> {
    return { caseId: newId() };
  }
}

class FakeRest implements RestProxyClient {
  readonly calls: RestRequestOptions[] = [];

  constructor(private readonly refuse: (options: RestRequestOptions) => boolean = () => false) {}

  async request(options: RestRequestOptions): Promise<RestResponse> {
    this.calls.push(options);

    return this.refuse(options)
      ? { status: 403, body: { message: 'Missing Permissions', code: 50013 } }
      : { status: 200, body: {} };
  }
}

interface Body {
  content?: string;
  embeds?: { description?: string; color?: number }[];
  flags?: number;
}

function replyBody(call: RestRequestOptions | undefined): Body | undefined {
  return (call?.body as { data?: Body } | undefined)?.data;
}

function followUpBody(call: RestRequestOptions | undefined): Body | undefined {
  return call?.body as Body | undefined;
}

function textOf(body: Body | undefined): string | null {
  return body?.content || body?.embeds?.[0]?.description || null;
}

function colourOf(body: Body | undefined): number | undefined {
  return body?.embeds?.[0]?.color;
}

function menus(overrides: Partial<RolemenuConfig> = {}): RolemenuConfig {
  return {
    enabled: true,
    menus: [
      {
        id: 'colours',
        channelId: CHANNEL,
        messageId: MESSAGE,
        kind: 'button',
        mode: 'toggle',
        bindings: [{ key: 'red', roleId: ROLE, label: 'Red' }],
      },
    ],
    ...overrides,
  };
}

function harness(config: RolemenuConfig, refuse?: (options: RestRequestOptions) => boolean) {
  const rest = new FakeRest(refuse);

  const executor = new DefaultActionExecutor({
    dedupe: new MemoryDedupe(),
    rest,
    recorder: new MemoryRecorder(),
    resolveContext: async (): Promise<PrecheckInput> => ({
      guildId: GUILD,
      guildOwnerId: OWNER,
      botUserId: BOT,
      botHighestRolePosition: 10,
      botChannelPermissions: 0n,
      requiredPermissions: 0n,
    }),
  });

  const ctx: ModuleContext<RolemenuConfig> = {
    guildId: GUILD,
    config,
    executor,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };

  const callsTo = (fragment: string) => rest.calls.filter((call) => call.path.includes(fragment));

  return { ctx, rest, callsTo };
}

function press(customId: string, roleIds: string[] = []): ProtonEvent {
  return {
    id: `interaction.component:${customId}:${roleIds.join('+')}`,
    type: 'interaction.component',
    guildId: GUILD,
    occurredAt: 0,
    payload: {
      id: '111111111111111111',
      token: 'tok',
      type: COMPONENT_INTERACTION,
      application_id: APPLICATION,
      guild_id: GUILD,
      channel_id: CHANNEL,
      member: { user: { id: MEMBER }, roles: roleIds },
      data: { custom_id: customId, component_type: BUTTON },
    },
  } as unknown as ProtonEvent;
}

function buttonId(menuId: string, key: string): string {
  const encoded = encodeCustomId(MODULE_ID, menuId, key);
  if (!encoded.ok) throw new Error(encoded.humanReason);

  return encoded.customId;
}

function options(values: Record<string, string>): CommandOptions {
  return {
    getString: (name) => values[name] ?? null,
    getInteger: () => null,
    getNumber: () => null,
    getBoolean: () => null,
    getUserId: () => null,
    getChannelId: () => null,
    getRoleId: () => null,
    getSubcommand: () => null,
    getSubcommandGroup: () => null,
    has: (name) => name in values,
  };
}

function commandCtx(
  ctx: ModuleContext<RolemenuConfig>,
  values: Record<string, string>,
): CommandContext<RolemenuConfig> {
  return {
    ...ctx,
    channelId: CHANNEL,
    userId: OWNER,
    options: options(values),
    interaction: { id: '111111111111111111', token: 'tok' },
    idempotencyKey: `${MODULE_ID}:cmd:${values.menu ?? ''}`,
  };
}

describe('a press on a role menu answers with a status embed', () => {
  test('a role the member actually got comes back green, and ephemerally', async () => {
    const { ctx, callsTo } = harness(menus());

    const outcome = await handleComponent(press(buttonId('colours', 'red')), ctx, {
      applicationId: APPLICATION,
      botUserId: BOT,
    });

    expect(outcome).toEqual({ action: 'applied', menuId: 'colours', added: [ROLE], removed: [] });
    expect(callsTo(ROLE_PATH).map((call) => call.method)).toEqual(['PUT']);

    const body = followUpBody(callsTo(`/webhooks/${APPLICATION}`)[0]);

    expect(textOf(body)).toBe(`${STATUS_SUCCESS_EMOJI} Gave you <@&${ROLE}>.`);
    expect(colourOf(body)).toBe(STATUS_SUCCESS_COLOUR);
    expect(body?.content).toBe('');
    expect(body?.flags).toBe(EPHEMERAL);
  });

  test('a role Discord refuses to hand over comes back red, naming the role', async () => {
    const { ctx, callsTo } = harness(menus(), (call) => call.path === ROLE_PATH);

    const outcome = await handleComponent(press(buttonId('colours', 'red')), ctx, {
      applicationId: APPLICATION,
      botUserId: BOT,
    });

    expect(outcome.action).toBe('refused');

    const body = followUpBody(callsTo(`/webhooks/${APPLICATION}`)[0]);

    expect(textOf(body)).toStartWith(`${STATUS_ERROR_EMOJI} `);
    expect(textOf(body)).toContain(`<@&${ROLE}>`);
    expect(colourOf(body)).toBe(STATUS_ERROR_COLOUR);
  });

  test('a menu that has been deleted since the message was posted comes back red', async () => {
    const { ctx, callsTo } = harness(menus({ menus: [] }));

    const outcome = await handleComponent(press(buttonId('colours', 'red')), ctx, {
      applicationId: APPLICATION,
      botUserId: BOT,
    });

    expect(outcome.action).toBe('refused');

    const body = replyBody(callsTo('/callback')[0]);

    expect(textOf(body)).toBe(
      `${STATUS_ERROR_EMOJI} This menu (colours) is no longer set up in this server, so I can't ` +
        'give you anything from it. Ask an admin to re-post it or to delete the message.',
    );
    expect(colourOf(body)).toBe(STATUS_ERROR_COLOUR);
  });

  test('a press while the module is disabled comes back red', async () => {
    const { ctx, callsTo } = harness(menus({ enabled: false }));

    const outcome = await handleComponent(press(buttonId('colours', 'red')), ctx, {
      applicationId: APPLICATION,
      botUserId: BOT,
    });

    expect(outcome.action).toBe('ignored');
    expect(colourOf(replyBody(callsTo('/callback')[0]))).toBe(STATUS_ERROR_COLOUR);
  });
});

describe('/rolemenu answers with a status embed', () => {
  test('a menu it managed to refresh comes back green, naming the menu and channel', async () => {
    const { ctx, callsTo } = harness(menus());

    await rolemenuCommand().handler(commandCtx(ctx, { menu: 'colours' }));

    const body = replyBody(callsTo('/callback')[0]);

    expect(textOf(body)).toBe(
      `${STATUS_SUCCESS_EMOJI} Refreshed 'colours' in <#${CHANNEL}>. It now offers 1 role.`,
    );
    expect(colourOf(body)).toBe(STATUS_SUCCESS_COLOUR);
  });

  test('a menu id nobody configured comes back red, listing the ones that exist', async () => {
    const { ctx, callsTo } = harness(menus());

    await rolemenuCommand().handler(commandCtx(ctx, { menu: 'greys' }));

    const body = replyBody(callsTo('/callback')[0]);

    expect(textOf(body)).toBe(
      `${STATUS_ERROR_EMOJI} There is no menu called 'greys'. This server has: colours.`,
    );
    expect(colourOf(body)).toBe(STATUS_ERROR_COLOUR);
  });

  test('a refresh Discord refuses comes back red, naming the menu and channel', async () => {
    const { ctx, callsTo } = harness(menus(), (call) => call.method === 'PATCH');

    await rolemenuCommand().handler(commandCtx(ctx, { menu: 'colours' }));

    const body = replyBody(callsTo('/callback')[0]);

    expect(textOf(body)).toStartWith(
      `${STATUS_ERROR_EMOJI} I couldn't refresh 'colours' in <#${CHANNEL}>: `,
    );
    expect(colourOf(body)).toBe(STATUS_ERROR_COLOUR);
  });
});
