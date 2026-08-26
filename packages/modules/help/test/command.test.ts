import { describe, expect, test } from 'bun:test';
import {
  type CaseInput,
  type CaseRecorder,
  type CommandContext,
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

function harness(config: Partial<HelpConfig> = {}, dashboardUrl: string | null = DASHBOARD) {
  const rest = new FakeRest();
  const recorder = new MemoryRecorder();
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

  const ctx: CommandContext<HelpConfig> = {
    guildId: GUILD,
    channelId: CHANNEL,
    userId: USER,
    config: { ...helpDefaultConfig, ...config },
    executor,
    logger,
    options: createCommandOptions([]),
    interaction: { id: INTERACTION, token: LIVE_TOKEN },
    idempotencyKey: newId(),
  };

  const command = helpCommand(dashboardUrl === null ? {} : { dashboardUrl });

  return { command, ctx, rest, recorder, lines };
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
