import { describe, expect, test } from 'bun:test';
import {
  type ActionExecutor,
  type ActionRequest,
  type CaseInput,
  type CaseRecorder,
  type CommandContext,
  type CommandDefinition,
  createCommandOptions,
  type DedupeStore,
  DefaultActionExecutor,
  type Logger,
  MESSAGE_FLAG_EPHEMERAL,
  MESSAGE_FLAG_IS_COMPONENTS_V2,
  newId,
  Permissions,
  type PrecheckInput,
  type RestProxyClient,
  type RestRequestOptions,
  type RestResponse,
  replyControl,
  resolvePrivateReply,
  subcommandPath,
} from '@proton/core';
import { helpCommand } from '../src/command.ts';
import { type HelpConfig, helpDefaultConfig } from '../src/config.ts';
import { dashboardLink } from '../src/deps.ts';
import { OPEN_DASHBOARD } from '../src/overview.ts';

const GUILD = '900000000000000001';
const CHANNEL = '500000000000000001';
const USER = '100000000000000001';
const INTERACTION = '600000000000000001';
const LIVE_TOKEN = 'aGVscC1pbnRlcmFjdGlvbg.live.15-minutes';
const DASHBOARD = 'https://proton.example/';

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

  async request(options: RestRequestOptions): Promise<RestResponse> {
    this.calls.push(options);
    return { status: 200, body: {} };
  }
}

interface Body {
  data?: {
    flags?: number;
    content?: string;
    embeds?: unknown[];
    components?: Array<Record<string, unknown>>;
  };
}

interface RunOverrides {
  replyPreference: boolean | null;
  // Present, it replaces what the worker would resolve — undefined is a worker that set none.
  privateReply: boolean | undefined;
  idempotencyKey: string;
}

function privateReplyOf(
  command: CommandDefinition<HelpConfig>,
  config: HelpConfig,
  overrides: Partial<RunOverrides>,
): { privateReply?: boolean } {
  if ('privateReply' in overrides) {
    return overrides.privateReply === undefined ? {} : { privateReply: overrides.privateReply };
  }
  if (!command.reply) return {};

  const preference = overrides.replyPreference ?? null;
  return {
    privateReply: resolvePrivateReply(command.reply, config, subcommandPath([]), preference),
  };
}

function harness(
  config: Partial<HelpConfig> = {},
  dashboardUrl: string | null = DASHBOARD,
  overrides: Partial<RunOverrides> = {},
) {
  const rest = new FakeRest();
  const recorder = new MemoryRecorder();
  const requests: ActionRequest[] = [];
  const lines: string[] = [];
  const logger: Logger = {
    info: (message) => lines.push(message),
    warn: (message) => lines.push(message),
    error: (message) => lines.push(message),
  };

  const executor = new DefaultActionExecutor({
    dedupe: new MemoryDedupe(),
    rest,
    recorder,
    resolveContext: async (): Promise<PrecheckInput> => ({
      guildId: GUILD,
      guildOwnerId: '200000000000000001',
      botUserId: '300000000000000001',
      botHighestRolePosition: 10,
      botChannelPermissions: Permissions.ViewChannel,
      requiredPermissions: 0n,
      channelId: CHANNEL,
    }),
  });

  const recording: ActionExecutor = {
    execute: (request) => {
      requests.push(request);
      return executor.execute(request);
    },
  };

  const command = helpCommand(dashboardUrl === null ? {} : { dashboardUrl });
  const full = { ...helpDefaultConfig, ...config };

  const ctx: CommandContext<HelpConfig> = {
    guildId: GUILD,
    channelId: CHANNEL,
    userId: USER,
    config: full,
    executor: recording,
    logger,
    options: createCommandOptions([]),
    interaction: { id: INTERACTION, token: LIVE_TOKEN },
    idempotencyKey: overrides.idempotencyKey ?? newId(),
    ...privateReplyOf(command, full, overrides),
  };

  return { command, ctx, rest, recorder, requests, lines };
}

function sent(rest: FakeRest): Body['data'] {
  return (rest.calls[0]?.body as Body | undefined)?.data;
}

function container(rest: FakeRest): Record<string, unknown> | undefined {
  return sent(rest)?.components?.[0];
}

function children(rest: FakeRest): Array<Record<string, unknown>> {
  return (container(rest)?.components as Array<Record<string, unknown>> | undefined) ?? [];
}

function flatText(rest: FakeRest): string {
  return JSON.stringify(children(rest));
}

describe('/help', () => {
  test('answers with one Components V2 container and no embed or content', async () => {
    const { command, ctx, rest } = harness();

    await command.handler(ctx);

    expect(rest.calls).toHaveLength(1);
    expect(rest.calls[0]?.path).toBe(`/interactions/${INTERACTION}/${LIVE_TOKEN}/callback`);

    const data = sent(rest);
    expect((data?.flags ?? 0) & MESSAGE_FLAG_IS_COMPONENTS_V2).toBe(MESSAGE_FLAG_IS_COMPONENTS_V2);
    expect(data?.content).toBeUndefined();
    expect(data?.embeds).toBeUndefined();
    expect(data?.components).toHaveLength(1);
  });

  test('names every module category, so the overview covers the whole product', async () => {
    const { command, ctx, rest } = harness();

    await command.handler(ctx);

    const body = flatText(rest);
    for (const category of ['Moderation', 'Security', 'Engagement', 'Utility', 'Logging']) {
      expect(`${category}: ${body.includes(`**${category}**`)}`).toBe(`${category}: true`);
    }
  });

  test('points at this guild’s own dashboard page with a link button', async () => {
    const { command, ctx, rest } = harness();

    await command.handler(ctx);

    const section = children(rest).find((child) => 'accessory' in child);
    const accessory = section?.accessory as Record<string, unknown> | undefined;

    expect(accessory?.label).toBe(OPEN_DASHBOARD);
    expect(accessory?.url).toBe(`https://proton.example/dashboard/${GUILD}`);
  });

  test('is ephemeral by default, and public once a server turns that off', async () => {
    const quiet = harness();
    await quiet.command.handler(quiet.ctx);
    expect((sent(quiet.rest)?.flags ?? 0) & MESSAGE_FLAG_EPHEMERAL).toBe(MESSAGE_FLAG_EPHEMERAL);

    const loud = harness({ ephemeral: false });
    await loud.command.handler(loud.ctx);
    expect((sent(loud.rest)?.flags ?? 0) & MESSAGE_FLAG_EPHEMERAL).toBe(0);
  });

  test('still answers when no dashboard address was configured, and names what is missing', async () => {
    const { command, ctx, rest, lines } = harness({}, null);

    await command.handler(ctx);

    expect(rest.calls).toHaveLength(1);
    expect(children(rest).some((child) => 'accessory' in child)).toBe(false);
    expect(flatText(rest)).toContain('A server admin will know where it lives');
    expect(flatText(rest)).not.toContain('DASHBOARD_URL');
    expect(lines.join('\n')).toContain('DASHBOARD_URL');
  });

  test('an address that is not a complete http link is refused rather than sent to Discord', () => {
    expect(dashboardLink({ dashboardUrl: 'proton.example' }, GUILD)).toBeNull();
    expect(dashboardLink({ dashboardUrl: '   ' }, GUILD)).toBeNull();
    expect(dashboardLink({ dashboardUrl: 'http://localhost:3000//' }, GUILD)).toBe(
      `http://localhost:3000/dashboard/${GUILD}`,
    );
  });

  test('the overview is not a moderation case, and never carries the interaction token', async () => {
    const { command, ctx, recorder } = harness();

    await command.handler(ctx);

    expect(recorder.recorded).toEqual([]);
    expect(JSON.stringify(recorder.recorded)).not.toContain(LIVE_TOKEN);
  });

  test('a server that switched the module off gets no reply at all', async () => {
    const { command, ctx, rest } = harness({ enabled: false });

    await command.handler(ctx);

    expect(rest.calls).toEqual([]);
  });
});

function ephemeralFlag(rest: FakeRest): number {
  return (sent(rest)?.flags ?? 0) & MESSAGE_FLAG_EPHEMERAL;
}

describe('/help registration and reply visibility', () => {
  test('stays registered while Help is off, so a new server can still find the dashboard', () => {
    expect(helpCommand().alwaysRegistered).toBe(true);
  });

  test('defaults to Reply privately and lets the Commands page choose, with no module page to point at', () => {
    const command = helpCommand();

    expect(command.reply?.toggleable).toEqual(['']);
    expect(command.reply?.inheritsFrom).toBeUndefined();
    expect(replyControl(command.reply, command.data, helpDefaultConfig)).toEqual({
      supported: true,
      paths: [{ path: '', default: 'private', toggleable: true }],
    });
    expect(
      replyControl(command.reply, command.data, { ...helpDefaultConfig, ephemeral: false })?.paths,
    ).toEqual([{ path: '', default: 'public', toggleable: true }]);
  });

  test.each([
    ['private', true],
    ['public', false],
  ] as const)(
    'with no setting and Reply privately %s it answers exactly as before',
    async (_label, ephemeral) => {
      const before = harness({ ephemeral }, DASHBOARD, {
        privateReply: undefined,
        idempotencyKey: 'evt-help',
      });
      const after = harness({ ephemeral }, DASHBOARD, {
        replyPreference: null,
        idempotencyKey: 'evt-help',
      });

      await before.command.handler(before.ctx);
      await after.command.handler(after.ctx);

      expect(after.ctx.privateReply).toBe(ephemeral);
      expect(after.requests).toEqual(before.requests);
      expect(after.requests[0]?.payload).toMatchObject({
        ephemeral,
        flags: MESSAGE_FLAG_IS_COMPONENTS_V2,
      });
      expect(after.requests[0]?.payload).not.toHaveProperty('callbackType');
    },
  );

  test('set public, it answers in the channel although the stored config says privately', async () => {
    const { command, ctx, rest } = harness({ ephemeral: true }, DASHBOARD, {
      replyPreference: false,
    });

    await command.handler(ctx);

    expect(ephemeralFlag(rest)).toBe(0);
    expect((sent(rest)?.flags ?? 0) & MESSAGE_FLAG_IS_COMPONENTS_V2).toBe(
      MESSAGE_FLAG_IS_COMPONENTS_V2,
    );
  });

  test('set private, it answers privately although the stored config says publicly', async () => {
    const { command, ctx, rest } = harness({ ephemeral: false }, DASHBOARD, {
      replyPreference: true,
    });

    await command.handler(ctx);

    expect(ephemeralFlag(rest)).toBe(MESSAGE_FLAG_EPHEMERAL);
  });
});
