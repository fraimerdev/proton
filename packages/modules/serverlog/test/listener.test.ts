import { describe, expect, test } from 'bun:test';
import { AuditLogEvent } from 'discord-api-types/v10';
import { serverlogDefaultConfig } from '../src/config.ts';
import { createServerlogListener, type FlushRequest, flushPending } from '../src/listeners.ts';
import {
  ACTOR,
  auditEvent,
  BOT_USER,
  collectingLogger,
  config,
  context,
  EMOJIS,
  event,
  GUILD,
  LOG_CHANNEL,
  MemoryCorrelationStore,
  RecordingExecutor,
  resolver,
} from './harness.ts';

const CHANNEL_ID = '500000000000000021';

function build(overrides: Partial<Parameters<typeof createServerlogListener>[0]> = {}) {
  const correlation = new MemoryCorrelationStore();
  const flushes: FlushRequest[] = [];

  const deps = {
    correlation,
    users: resolver,
    emojis: EMOJIS,
    botUserId: BOT_USER,
    scheduleFlush: async (request: FlushRequest) => {
      flushes.push(request);
    },
    ...overrides,
  };

  return { deps, correlation, flushes, listener: createServerlogListener(deps) };
}

describe('the module switch', () => {
  test('a disabled guild posts nothing', async () => {
    const { listener } = build();
    const executor = new RecordingExecutor();

    await listener.handler(event('guildMemberAdd'), context(executor, config({ enabled: false })));

    expect(executor.requests).toEqual([]);
  });

  test('no configured channel posts nothing', async () => {
    const { listener } = build();
    const executor = new RecordingExecutor();

    await listener.handler(
      event('guildMemberAdd'),
      context(executor, config({ defaultChannelId: '' })),
    );

    expect(executor.requests).toEqual([]);
  });
});

describe('immediate logs', () => {
  test('a member join posts one embed with no executor', async () => {
    const { listener } = build();
    const executor = new RecordingExecutor();

    await listener.handler(event('guildMemberAdd'), context(executor));

    expect(executor.requests).toHaveLength(1);
    expect(executor.titles()).toEqual(['Member joined']);
    expect(executor.footers()).toEqual(['Unknown']);
  });

  test('a joining bot is labelled as a bot', async () => {
    const { listener } = build();
    const executor = new RecordingExecutor();

    await listener.handler(event('guildMemberAddBot'), context(executor));

    expect(executor.titles()).toEqual(['Bot joined']);
  });

  test('the send suppresses pings and leaves no case behind', async () => {
    const { listener } = build();
    const executor = new RecordingExecutor();

    await listener.handler(event('guildMemberAdd'), context(executor));

    expect(executor.requests[0]?.record).toBe(false);
    expect(executor.payloads()[0]?.allowedMentions).toEqual({ parse: [] });
  });

  test('a redelivered event reuses the same idempotency key', async () => {
    const { listener } = build();
    const executor = new RecordingExecutor();
    const ctx = context(executor);

    await listener.handler(event('guildMemberAdd'), ctx);
    await listener.handler(event('guildMemberAdd'), ctx);

    expect(executor.requests[0]?.idempotencyKey).toBe(executor.requests[1]?.idempotencyKey ?? '');
  });
});

describe('audit-primary logs', () => {
  test('a kick renders straight from the audit entry, with its executor', async () => {
    const { listener } = build();
    const executor = new RecordingExecutor();

    await listener.handler(auditEvent(AuditLogEvent.MemberKick), context(executor));

    expect(executor.titles()).toEqual(['Member kicked']);
    expect(executor.footers()).toEqual(['admin']);
  });

  test('an audit action nothing subscribes to is silent', async () => {
    const { listener } = build();
    const executor = new RecordingExecutor();

    await listener.handler(auditEvent(9999), context(executor));

    expect(executor.requests).toEqual([]);
  });

  test('one MEMBER_UPDATE entry only renders the log its changes describe', async () => {
    const { listener } = build();
    const executor = new RecordingExecutor();

    await listener.handler(
      auditEvent(AuditLogEvent.MemberUpdate, {
        target_id: '100000000000000002',
        changes: [{ key: 'nick', old_value: 'old', new_value: 'new' }],
      }),
      context(executor),
    );

    expect(executor.titles()).toEqual(['Nickname changed']);
  });

  test('a timeout and its removal are told apart by the direction of the change', async () => {
    const { listener } = build();
    const timedOut = new RecordingExecutor();
    const lifted = new RecordingExecutor();

    await listener.handler(
      auditEvent(AuditLogEvent.MemberUpdate, {
        target_id: '100000000000000002',
        changes: [{ key: 'communication_disabled_until', new_value: '2026-08-16T13:00:00.000Z' }],
      }),
      context(timedOut),
    );

    await listener.handler(
      auditEvent(AuditLogEvent.MemberUpdate, {
        target_id: '100000000000000002',
        changes: [{ key: 'communication_disabled_until', old_value: '2026-08-16T13:00:00.000Z' }],
      }),
      context(lifted),
    );

    expect(timedOut.titles()).toEqual(['Member timed out']);
    expect(lifted.titles()).toEqual(['Timeout removed']);
  });

  test('roles given and roles taken are separate logs from one entry', async () => {
    const { listener } = build();
    const executor = new RecordingExecutor();

    await listener.handler(
      auditEvent(AuditLogEvent.MemberRoleUpdate, {
        target_id: '100000000000000002',
        changes: [
          { key: '$add', new_value: [{ id: '700000000000000001', name: 'Member' }] },
          { key: '$remove', new_value: [{ id: '700000000000000002', name: 'Muted' }] },
        ],
      }),
      context(executor),
    );

    expect(executor.titles().sort()).toEqual(['Role added', 'Role removed']);
  });
});

describe('entity/audit correlation', () => {
  test('the audit entry arriving first produces one log with the executor', async () => {
    const { listener } = build();
    const executor = new RecordingExecutor();
    const ctx = context(executor);

    await listener.handler(auditEvent(AuditLogEvent.ChannelCreate, { target_id: CHANNEL_ID }), ctx);
    expect(executor.requests).toEqual([]);

    await listener.handler(event('channelCreate'), ctx);

    expect(executor.titles()).toEqual(['Text channel created']);
    expect(executor.footers()).toEqual(['admin']);
  });

  test('the entity arriving first waits, then produces the same log', async () => {
    const { listener, flushes } = build();
    const executor = new RecordingExecutor();
    const ctx = context(executor);

    await listener.handler(event('channelCreate'), ctx);
    expect(executor.requests).toEqual([]);
    expect(flushes).toHaveLength(1);

    await listener.handler(auditEvent(AuditLogEvent.ChannelCreate, { target_id: CHANNEL_ID }), ctx);

    expect(executor.titles()).toEqual(['Text channel created']);
    expect(executor.footers()).toEqual(['admin']);
  });

  test('both orders produce the same idempotency key, so only one survives dedupe', async () => {
    const first = build();
    const second = build();
    const a = new RecordingExecutor();
    const b = new RecordingExecutor();

    await first.listener.handler(
      auditEvent(AuditLogEvent.ChannelCreate, { target_id: CHANNEL_ID }),
      context(a),
    );
    await first.listener.handler(event('channelCreate'), context(a));

    await second.listener.handler(event('channelCreate'), context(b));
    await second.listener.handler(
      auditEvent(AuditLogEvent.ChannelCreate, { target_id: CHANNEL_ID }),
      context(b),
    );

    expect(a.requests[0]?.idempotencyKey).toBe(b.requests[0]?.idempotencyKey ?? '');
  });

  test('no audit entry ever arriving still logs, with an unknown executor', async () => {
    const { deps, listener, flushes } = build();
    const executor = new RecordingExecutor();
    const ctx = context(executor);

    await listener.handler(event('channelCreate'), ctx);
    expect(executor.requests).toEqual([]);

    const pending = flushes[0];
    if (!pending) throw new Error('no flush was scheduled');
    await flushPending(deps, ctx, pending);

    expect(executor.titles()).toEqual(['Text channel created']);
    expect(executor.footers()).toEqual(['Unknown']);
  });

  test('a flush after the audit entry already won does nothing', async () => {
    const { deps, listener, flushes } = build();
    const executor = new RecordingExecutor();
    const ctx = context(executor);

    await listener.handler(event('channelCreate'), ctx);
    await listener.handler(auditEvent(AuditLogEvent.ChannelCreate, { target_id: CHANNEL_ID }), ctx);

    const pending = flushes[0];
    if (!pending) throw new Error('no flush was scheduled');
    await flushPending(deps, ctx, pending);

    expect(executor.requests).toHaveLength(1);
  });

  test('a kick logs once as a kick, not also as a leave', async () => {
    const { listener } = build();
    const executor = new RecordingExecutor();
    const ctx = context(executor);

    await listener.handler(event('guildMemberAdd'), ctx);
    executor.requests.length = 0;

    const leave = event('guildMemberAdd');
    leave.type = 'member.left';

    await listener.handler(leave, ctx);
    await listener.handler(
      auditEvent(AuditLogEvent.MemberKick, { target_id: '100000000000000002' }),
      ctx,
    );

    expect(executor.titles()).toEqual(['Member kicked']);
  });

  test('a voluntary leave still logs once the window passes', async () => {
    const { deps, listener, flushes } = build();
    const executor = new RecordingExecutor();
    const ctx = context(executor);

    const leave = event('guildMemberAdd');
    leave.type = 'member.left';
    await listener.handler(leave, ctx);

    const pending = flushes[0];
    if (!pending) throw new Error('no flush was scheduled');
    await flushPending(deps, ctx, pending);

    expect(executor.titles()).toEqual(['Member left']);
  });
});

describe('feedback loops and filters', () => {
  test('Proton never logs its own actions back to itself', async () => {
    const { listener } = build();
    const executor = new RecordingExecutor();

    const own = event('guildMemberAdd');
    (own.payload as { user: { id: string } }).user.id = BOT_USER;

    await listener.handler(own, context(executor));

    expect(executor.requests).toEqual([]);
  });

  test('an ignored actor is skipped even when the category is on', async () => {
    const { listener } = build();
    const executor = new RecordingExecutor();

    await listener.handler(
      auditEvent(AuditLogEvent.MemberKick),
      context(executor, config({ ignoredUserIds: [ACTOR] })),
    );

    expect(executor.requests).toEqual([]);
  });

  test('a category that is off silences its logs entirely', async () => {
    const { listener } = build();
    const executor = new RecordingExecutor();

    await listener.handler(
      event('guildMemberAdd'),
      context(
        executor,
        config({ categories: { ...serverlogDefaultConfig.categories, members: false } }),
      ),
    );

    expect(executor.requests).toEqual([]);
  });

  test('a per-category channel is used instead of the default', async () => {
    const { listener } = build();
    const executor = new RecordingExecutor();

    await listener.handler(
      event('guildMemberAdd'),
      context(
        executor,
        config({
          categoryChannels: {
            ...serverlogDefaultConfig.categoryChannels,
            members: '500000000000000077',
          },
        }),
      ),
    );

    expect(executor.channels()).toEqual(['500000000000000077']);
  });
});

describe('failures are named, not swallowed', () => {
  test('a refused send says which log and which channel', async () => {
    const { listener } = build();
    const executor = new RecordingExecutor();
    executor.result = {
      status: 'failed_precheck',
      failure: {
        code: 'missing_permission',
        humanReason: "I'm missing the Embed Links permission in that channel",
      },
    };
    const { logger, lines } = collectingLogger();

    await listener.handler(event('guildMemberAdd'), context(executor, config(), logger));

    expect(lines.join(' ')).toContain('Member joined');
    expect(lines.join(' ')).toContain(LOG_CHANNEL);
    expect(lines.join(' ')).toContain('Embed Links');
  });
});

describe('without a correlation store wired', () => {
  test('entity logs still go out immediately rather than disappearing', async () => {
    const listener = createServerlogListener({ users: resolver, emojis: EMOJIS });
    const executor = new RecordingExecutor();

    await listener.handler(event('channelCreate'), context(executor));

    expect(executor.titles()).toEqual(['Text channel created']);
  });
});

describe('guild scoping', () => {
  test('the log is posted in the guild the event belongs to', async () => {
    const { listener } = build();
    const executor = new RecordingExecutor();

    await listener.handler(event('guildMemberAdd'), context(executor));

    expect(executor.requests[0]?.guildId).toBe(GUILD);
  });
});
