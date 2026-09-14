import { describe, expect, test } from 'bun:test';
import type { CaseInput, CaseRecorder } from '../../src/actions/case-recorder.ts';
import type { DedupeStore } from '../../src/actions/dedupe.ts';
import { DefaultActionExecutor } from '../../src/actions/executor.ts';
import {
  ACTION_KINDS,
  exposesUpstreamOnFailure,
  isChannelScoped,
  isLedgerOnly,
  isNeverRecorded,
  requiredPermissionsFor,
  reversalOf,
  targetsMember,
} from '../../src/actions/kinds.ts';
import type { PrecheckInput } from '../../src/actions/prechecks.ts';
import type {
  RestProxyClient,
  RestRequestOptions,
  RestResponse,
} from '../../src/actions/rest-client.ts';
import { type PayloadResult, type RestCall, toRestCall } from '../../src/actions/rest-mapping.ts';
import type { ActionRequest } from '../../src/actions/types.ts';
import { newId } from '../../src/ids.ts';
import { Permissions, permissionLabels } from '../../src/permissions/bits.ts';

const GUILD = '1450209710199279760';
const BOT = '1349495395822211134';
const OWNER = '200000000000000000';
const CHANNEL = '500000000000000000';

const MODERN_GRADIENT = { fontId: 6, effectId: 2, colours: [0x5865f2, 0xeb459e] };
const MISSING_PERMISSIONS = { message: 'Missing Permissions', code: 50013 };
const STYLE_FIELDS = ['display_name_colors', 'display_name_effect_id', 'display_name_font_id'];

function styleRequest(style: unknown, overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    guildId: GUILD,
    moduleId: 'branding',
    kind: 'set_bot_name_style',
    actorId: 'proton:branding',
    dryRun: false,
    idempotencyKey: newId(),
    payload: { style },
    ...overrides,
  };
}

function callOf(result: PayloadResult): RestCall {
  if ('error' in result) throw new Error(result.error);
  if ('ledgerOnly' in result) throw new Error('expected a REST call, got a ledger-only kind');
  return result.call;
}

function keysOf(body: unknown): string[] {
  return Object.keys(body as Record<string, unknown>).sort();
}

describe('set_bot_name_style maps to Modify Current Member', () => {
  test('patches Proton’s own member with exactly the three style fields', () => {
    const call = callOf(toRestCall(styleRequest(MODERN_GRADIENT)));

    expect(call.method).toBe('PATCH');
    expect(call.path).toBe(`/guilds/${GUILD}/members/@me`);
    expect(call.body).toEqual({
      display_name_font_id: 6,
      display_name_effect_id: 2,
      display_name_colors: [0x5865f2, 0xeb459e],
    });
    expect(keysOf(call.body)).toEqual(STYLE_FIELDS);
  });

  test('sends the reset as three nulls, never as an empty body', () => {
    const call = callOf(toRestCall(styleRequest(null)));

    expect(call.body).toEqual({
      display_name_font_id: null,
      display_name_effect_id: null,
      display_name_colors: null,
    });
    expect(keysOf(call.body)).toEqual(STYLE_FIELDS);
  });

  test('keeps the colours in the order they were given', () => {
    const call = callOf(
      toRestCall(styleRequest({ ...MODERN_GRADIENT, colours: [0xeb459e, 0x5865f2] })),
    );

    expect((call.body as { display_name_colors: number[] }).display_name_colors).toEqual([
      0xeb459e, 0x5865f2,
    ]);
  });

  test('drops anything else a caller puts in the style', () => {
    const call = callOf(
      toRestCall(styleRequest({ ...MODERN_GRADIENT, font: 'modern', nick: 'Proton' })),
    );

    expect(keysOf(call.body)).toEqual(STYLE_FIELDS);
  });

  test('carries no audit-log header, even when the request has a reason', () => {
    const call = callOf(toRestCall(styleRequest(MODERN_GRADIENT, { reason: 'dashboard save' })));

    expect(call.headers).toBeUndefined();
  });

  test('accepts colour 0 and 0xffffff, the two ends of the range', () => {
    const call = callOf(toRestCall(styleRequest({ ...MODERN_GRADIENT, colours: [0, 0xffffff] })));

    expect((call.body as { display_name_colors: number[] }).display_name_colors).toEqual([
      0, 16777215,
    ]);
  });

  test.each([
    ['colour 0x1000000', { ...MODERN_GRADIENT, colours: [16777216] }],
    ['a negative colour', { ...MODERN_GRADIENT, colours: [-1] }],
    ['a colour written as hex', { ...MODERN_GRADIENT, colours: ['#5865f2'] }],
    ['no colours', { ...MODERN_GRADIENT, colours: [] }],
    ['six colours', { ...MODERN_GRADIENT, colours: [1, 2, 3, 4, 5, 6] }],
    ['font id 0', { ...MODERN_GRADIENT, fontId: 0 }],
    ['a fractional effect id', { ...MODERN_GRADIENT, effectId: 1.5 }],
    ['no style at all', undefined],
  ])('refuses %s before Discord sees it', (_, style) => {
    expect('error' in toRestCall(styleRequest(style))).toBe(true);
  });
});

describe('set_bot_name_style in the kind tables', () => {
  test('requires Change Nickname and nothing else, inside a thread or out', () => {
    expect(requiredPermissionsFor('set_bot_name_style')).toBe(Permissions.ChangeNickname);
    expect(requiredPermissionsFor('set_bot_name_style', { style: null }, true)).toBe(
      Permissions.ChangeNickname,
    );
  });

  test('names no member, is judged guild-wide, has no reversal and is never a case', () => {
    expect(targetsMember('set_bot_name_style')).toBe(false);
    expect(isChannelScoped('set_bot_name_style')).toBe(false);
    expect(reversalOf('set_bot_name_style')).toBeUndefined();
    expect(isNeverRecorded('set_bot_name_style')).toBe(true);
    expect(isLedgerOnly('set_bot_name_style')).toBe(false);
  });

  test('is the only kind whose failed result carries Discord’s answer', () => {
    expect(ACTION_KINDS.filter(exposesUpstreamOnFailure)).toEqual(['set_bot_name_style']);
  });
});

class MemoryDedupe implements DedupeStore {
  readonly claimed = new Set<string>();

  async claim(key: string): Promise<boolean> {
    if (this.claimed.has(key)) return false;
    this.claimed.add(key);
    return true;
  }

  async release(key: string): Promise<void> {
    this.claimed.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return this.claimed.has(key);
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
  answer: () => Promise<RestResponse> = async () => ({ status: 200, body: {} });

  async request(options: RestRequestOptions): Promise<RestResponse> {
    this.calls.push(options);
    return this.answer();
  }
}

function build(
  granted = Permissions.ChangeNickname | Permissions.ViewChannel | Permissions.SendMessages,
) {
  const rest = new FakeRest();
  const recorder = new MemoryRecorder();

  const executor = new DefaultActionExecutor({
    dedupe: new MemoryDedupe(),
    rest,
    recorder,
    resolveContext: async (request): Promise<PrecheckInput> => ({
      guildId: GUILD,
      guildOwnerId: OWNER,
      botUserId: BOT,
      botHighestRolePosition: 10,
      botChannelPermissions: granted,
      requiredPermissions: requiredPermissionsFor(request.kind, request.payload),
      ...(request.kind === 'send' ? { channelId: CHANNEL } : {}),
    }),
  });

  return { executor, rest, recorder };
}

describe('the executor running set_bot_name_style', () => {
  test('returns Discord’s member object as the body, and records no case', async () => {
    const { executor, rest, recorder } = build();
    const member = {
      nick: null,
      display_name_styles: { font_id: 6, effect_id: 2, colors: [0x5865f2, 0xeb459e] },
    };
    rest.answer = async () => ({ status: 200, body: member });

    const result = await executor.execute(styleRequest(MODERN_GRADIENT));

    expect(result.status).toBe('executed');
    expect(result.body).toEqual(member);
    expect(result.upstream).toBeUndefined();
    expect(recorder.recorded).toHaveLength(0);
    expect(rest.calls).toHaveLength(1);
    expect(keysOf(rest.calls[0]?.body)).toEqual(STYLE_FIELDS);
  });

  test('hands back Discord’s status and body on a 403, keeping the failure code', async () => {
    const { executor, rest } = build();
    rest.answer = async () => ({ status: 403, body: MISSING_PERMISSIONS });

    const result = await executor.execute(styleRequest(MODERN_GRADIENT));

    expect(result.status).toBe('failed_api');
    expect(result.failure?.code).toBe('discord_403');
    expect(result.upstream).toEqual({ status: 403, body: MISSING_PERMISSIONS });
  });

  test('hands back the proxy’s own 502 body as well', async () => {
    const { executor, rest } = build();
    const proxy = { error: 'rest_proxy_upstream_failure', message: 'Missing Permissions' };
    rest.answer = async () => ({ status: 502, body: proxy });

    const result = await executor.execute(styleRequest(null));

    expect(result.failure?.code).toBe('discord_502');
    expect(result.upstream).toEqual({ status: 502, body: proxy });
  });

  test('releases the key after a refusal, so the same request may be tried again', async () => {
    const { executor, rest } = build();
    rest.answer = async () => ({ status: 403, body: MISSING_PERMISSIONS });
    const request = styleRequest(MODERN_GRADIENT);

    await executor.execute(request);
    const again = await executor.execute(request);

    expect(again.status).toBe('failed_api');
    expect(rest.calls).toHaveLength(2);
  });

  test('skips a redelivered request once it has gone through', async () => {
    const { executor, rest } = build();
    const request = styleRequest(MODERN_GRADIENT);

    await executor.execute(request);
    const again = await executor.execute(request);

    expect(again.status).toBe('skipped_duplicate');
    expect(rest.calls).toHaveLength(1);
  });

  test('refuses before Discord is asked when Proton lacks Change Nickname', async () => {
    const { executor, rest } = build(Permissions.ViewChannel | Permissions.SendMessages);

    const result = await executor.execute(styleRequest(MODERN_GRADIENT));

    expect(result.status).toBe('failed_precheck');
    expect(result.failure?.code).toBe('missing_permission');
    expect(result.failure?.humanReason).toContain(
      permissionLabels(Permissions.ChangeNickname).join(', '),
    );
    expect(rest.calls).toHaveLength(0);
  });

  test('gives no upstream for a transport failure, where nothing answered', async () => {
    const { executor, rest } = build();
    rest.answer = async () => {
      throw new Error('socket hang up');
    };

    const result = await executor.execute(styleRequest(MODERN_GRADIENT));

    expect(result.failure?.code).toBe('transport_failure');
    expect('upstream' in result).toBe(false);
  });
});

describe('every other kind keeps its old failure shape', () => {
  test('a send refused with a 403 carries no upstream', async () => {
    const { executor, rest } = build();
    rest.answer = async () => ({ status: 403, body: MISSING_PERMISSIONS });

    const result = await executor.execute(
      styleRequest(undefined, {
        kind: 'send',
        moduleId: 'ping',
        payload: { channelId: CHANNEL, content: 'hi' },
      }),
    );

    expect(result.status).toBe('failed_api');
    expect(result.failure?.code).toBe('discord_403');
    expect('upstream' in result).toBe(false);
  });
});
