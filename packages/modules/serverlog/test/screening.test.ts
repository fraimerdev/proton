import { describe, expect, test } from 'bun:test';
import type { ProtonEvent } from '@proton/core';
import { dispatch } from '@proton/fixtures';
import { normalise } from '@proton/gateway/normaliser';
import { serverlogDefaultConfig } from '../src/config.ts';
import { createServerlogListener, logIdempotencyKey } from '../src/listeners.ts';
import {
  collectingLogger,
  config,
  context,
  EMOJIS,
  event,
  GUILD,
  MemoryScreeningStore,
  RecordingExecutor,
} from './harness.ts';

const SCREENEE = '100000000000000004';
const JOINED_AT = '2026-08-14T09:10:00.000000+00:00';
const PASS_KEY = logIdempotencyKey(GUILD, 'members.screening_passed', `${SCREENEE}:${JOINED_AT}`);

function build() {
  const screening = new MemoryScreeningStore();
  return { screening, listener: createServerlogListener({ emojis: EMOJIS, screening }) };
}

function update(
  name: 'guildMemberUpdate' | 'guildMemberUpdateScreened',
  patch: Record<string, unknown> = {},
): ProtonEvent {
  const raw = dispatch(name);
  Object.assign(raw.d, patch);

  const [produced] = normalise(raw);
  if (!produced) throw new Error(`${name} produced no event`);
  return produced;
}

function passes(executor: RecordingExecutor) {
  return executor.requests.filter(
    (request) => request.reason === 'Server log: members.screening_passed',
  );
}

describe('passing Membership Screening', () => {
  test('a pending member who passes is logged once', async () => {
    const { listener } = build();
    const executor = new RecordingExecutor();
    const ctx = context(executor);

    await listener.handler(event('guildMemberAddPending'), ctx);
    await listener.handler(update('guildMemberUpdateScreened'), ctx);

    expect(executor.titles()).toEqual(['Member joined', 'Member accepted the rules']);
    expect(passes(executor)[0]?.idempotencyKey).toBe(PASS_KEY);
  });

  test('updates while the member is still pending log nothing', async () => {
    const { listener } = build();
    const executor = new RecordingExecutor();
    const ctx = context(executor);

    await listener.handler(event('guildMemberAddPending'), ctx);
    await listener.handler(
      update('guildMemberUpdateScreened', { pending: true, nick: 'waiting' }),
      ctx,
    );

    expect(passes(executor)).toEqual([]);

    await listener.handler(update('guildMemberUpdateScreened'), ctx);

    expect(passes(executor)).toHaveLength(1);
  });

  test('a redelivered pass posts nothing new', async () => {
    const { listener } = build();
    const executor = new RecordingExecutor();
    const ctx = context(executor);
    const passed = update('guildMemberUpdateScreened');

    await listener.handler(event('guildMemberAddPending'), ctx);
    await listener.handler(passed, ctx);
    await listener.handler(passed, ctx);

    expect(passes(executor)).toHaveLength(1);
  });

  test('a different update that read the mark before the pass cleared it posts under the same key', async () => {
    const { listener, screening } = build();
    const executor = new RecordingExecutor();
    const ctx = context(executor);

    const passed = update('guildMemberUpdateScreened');
    const granted = update('guildMemberUpdateScreened', { roles: ['700000000000000001'] });
    expect(granted.id).not.toBe(passed.id);

    await listener.handler(event('guildMemberAddPending'), ctx);
    await listener.handler(passed, ctx);
    await screening.mark(GUILD, SCREENEE, JOINED_AT);
    await listener.handler(granted, ctx);

    expect(passes(executor).map((request) => request.idempotencyKey)).toEqual([PASS_KEY, PASS_KEY]);
  });

  test('a mark left by an earlier membership does not turn an update into a pass', async () => {
    const { listener, screening } = build();
    const executor = new RecordingExecutor();

    await screening.mark(GUILD, SCREENEE, '2026-07-01T00:00:00.000000+00:00');
    await listener.handler(update('guildMemberUpdateScreened'), context(executor));

    expect(executor.requests).toEqual([]);
    expect(await screening.read(GUILD, SCREENEE)).toBeNull();
  });

  test('a pass while the log is off is forgotten, not posted on a later update', async () => {
    const { listener } = build();
    const executor = new RecordingExecutor();
    const off = context(
      executor,
      config({ categories: { ...serverlogDefaultConfig.categories, members: false } }),
    );

    await listener.handler(event('guildMemberAddPending'), off);
    await listener.handler(update('guildMemberUpdateScreened'), off);
    await listener.handler(
      update('guildMemberUpdateScreened', { premium_since: '2026-08-20T12:00:00.000000+00:00' }),
      context(executor),
    );

    expect(executor.requests).toEqual([]);
  });
});

describe('updates that are not a pass', () => {
  test.each([
    ['a boost', { premium_since: '2026-08-20T12:00:00.000000+00:00' }],
    ['a nickname change', { nick: 'renamed' }],
    ['a role change', { roles: ['700000000000000003'] }],
    ['a timeout', { communication_disabled_until: '2026-08-20T13:00:00.000000+00:00' }],
  ])('%s on a member never seen pending logs nothing', async (_name, patch) => {
    const { listener } = build();
    const executor = new RecordingExecutor();

    await listener.handler(update('guildMemberUpdate', patch), context(executor));

    expect(executor.requests).toEqual([]);
  });

  test('updates after the pass log nothing more', async () => {
    const { listener } = build();
    const executor = new RecordingExecutor();
    const ctx = context(executor);

    await listener.handler(event('guildMemberAddPending'), ctx);
    await listener.handler(update('guildMemberUpdateScreened'), ctx);
    await listener.handler(
      update('guildMemberUpdateScreened', { premium_since: '2026-08-20T12:00:00.000000+00:00' }),
      ctx,
    );
    await listener.handler(update('guildMemberUpdateScreened', { nick: 'renamed' }), ctx);

    expect(passes(executor)).toHaveLength(1);
  });

  test('an update with no pending flag is not read as a pass', async () => {
    const { listener } = build();
    const executor = new RecordingExecutor();
    const ctx = context(executor);

    await listener.handler(event('guildMemberAddPending'), ctx);
    await listener.handler(update('guildMemberUpdateScreened', { pending: undefined }), ctx);

    expect(passes(executor)).toEqual([]);
  });
});

describe('without a screening store wired', () => {
  test('a pending member names the missing store instead of passing silently', async () => {
    const listener = createServerlogListener({ emojis: EMOJIS });
    const executor = new RecordingExecutor();
    const { logger, lines } = collectingLogger();
    const ctx = context(executor, config(), logger);

    await listener.handler(event('guildMemberAddPending'), ctx);
    await listener.handler(update('guildMemberUpdateScreened'), ctx);

    expect(lines.join(' ')).toContain('no screening store is wired into the worker');
    expect(passes(executor)).toEqual([]);
  });
});
