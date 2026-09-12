import { describe, expect, test } from 'bun:test';
import { moderationModule } from '../src/index.ts';
import type { StandingWarning } from '../src/store.ts';
import {
  ABOVE_BOT,
  GUILD,
  harness,
  MEMBER,
  MODERATOR,
  OWNER,
  stringOption,
  subcommand,
  userOption,
} from './harness.ts';

const CASE_ID = 'K7f3M2q';

function standing(overrides: Partial<StandingWarning> = {}): StandingWarning {
  return {
    caseId: CASE_ID,
    caseNumber: 12,
    targetId: MEMBER,
    reason: 'spamming',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    revertedAt: null,
    revertedBy: null,
    ...overrides,
  };
}

describe('/warn add', () => {
  test('is registered by the module', () => {
    expect(moderationModule.commands?.some((c) => c.name === 'warn')).toBe(true);
  });

  test('records a case without calling Discord at all', async () => {
    const h = harness();

    await h.run(
      'warn',
      subcommand('add', [userOption('user', MEMBER), stringOption('reason', 'spamming')]),
    );

    expect(h.discordCalls()).toEqual([]);
    expect(h.cases()).toHaveLength(1);
    expect(h.cases()[0]?.kind).toBe('warn');
    expect(h.cases()[0]?.targetId).toBe(MEMBER);
    expect(h.cases()[0]?.reason).toBe('spamming');
  });

  test('tells the moderator it happened', async () => {
    const h = harness();

    await h.run('warn', subcommand('add', [userOption('user', MEMBER)]));

    expect(h.replyContent()).toContain('Warned');
  });

  test('publishes moderation.warned so the escalation ladder can fire', async () => {
    const h = harness();

    await h.run('warn', subcommand('add', [userOption('user', MEMBER)]));

    expect(h.published).toHaveLength(1);
    expect(h.published[0]?.type).toBe('moderation.warned');
  });

  test('the published event names the warned member, not the moderator', async () => {
    const h = harness();

    await h.run('warn', subcommand('add', [userOption('user', MEMBER)]));

    expect(h.published[0]?.payload).toMatchObject({ userId: MEMBER });
  });

  test('refuses to warn the guild owner, and says why', async () => {
    const h = harness();

    await h.run('warn', subcommand('add', [userOption('user', OWNER)]));

    expect(h.cases()).toEqual([]);
    expect(h.published).toEqual([]);
    expect(h.replyContent()).toBeTruthy();
  });

  test('refuses to warn a member above the bot', async () => {
    const h = harness();

    await h.run('warn', subcommand('add', [userOption('user', ABOVE_BOT)]));

    expect(h.cases()).toEqual([]);
    expect(h.published).toEqual([]);
  });

  test('a refused warn publishes nothing', async () => {
    const h = harness();

    await h.run('warn', subcommand('add', [userOption('user', OWNER)]));

    expect(h.published).toEqual([]);
  });

  test('a redelivered interaction warns once and publishes once', async () => {
    const h = harness();
    const idempotencyKey = 'fixed-interaction-key';

    await h.run('warn', subcommand('add', [userOption('user', MEMBER)]), { idempotencyKey });
    await h.run('warn', subcommand('add', [userOption('user', MEMBER)]), { idempotencyKey });

    expect(h.cases()).toHaveLength(1);
    expect(h.published).toHaveLength(1);
  });

  test('honours the server’s require-reason policy', async () => {
    const h = harness();

    await h.run('warn', subcommand('add', [userOption('user', MEMBER)]), {
      config: { requireReason: true },
    });

    expect(h.cases()).toEqual([]);
    expect(h.published).toEqual([]);
    expect(h.replyContent()).toContain('requires a reason');
  });
});

describe('/warn remove', () => {
  test('withdraws the warning and records the withdrawal as its own case', async () => {
    const h = harness();
    h.warnings.seed(GUILD, standing());

    await h.run(
      'warn',
      subcommand('remove', [stringOption('case', CASE_ID), stringOption('reason', 'appealed')]),
    );

    expect(h.discordCalls()).toEqual([]);
    expect(await h.warnings.find(GUILD, CASE_ID)).toMatchObject({ revertedBy: MODERATOR });
    expect(h.cases()).toHaveLength(1);
    expect(h.cases()[0]?.kind).toBe('unwarn');
    expect(h.cases()[0]?.targetId).toBe(MEMBER);
    expect(h.cases()[0]?.payload).toMatchObject({ userId: MEMBER, caseId: CASE_ID });
    expect(h.replyContent()).toContain(CASE_ID);
  });

  test('publishes nothing — a withdrawal must not feed the escalation ladder', async () => {
    const h = harness();
    h.warnings.seed(GUILD, standing());

    await h.run('warn', subcommand('remove', [stringOption('case', CASE_ID)]));

    expect(h.published).toEqual([]);
  });

  test('names the case id back when nothing in this server carries it', async () => {
    const h = harness();

    await h.run('warn', subcommand('remove', [stringOption('case', CASE_ID)]));

    expect(h.cases()).toEqual([]);
    expect(h.replyContent()).toContain(CASE_ID);
    expect(h.replyContent()).toContain('Cases');
  });

  test('will not withdraw a warning twice, and says who withdrew it', async () => {
    const h = harness();
    h.warnings.seed(GUILD, standing({ revertedAt: new Date(), revertedBy: OWNER }));

    await h.run('warn', subcommand('remove', [stringOption('case', CASE_ID)]));

    expect(h.cases()).toEqual([]);
    expect(h.replyContent()).toContain('already withdrawn');
    expect(h.replyContent()).toContain(OWNER);
  });

  test('explains what a case id looks like when the option is not one', async () => {
    const h = harness();

    await h.run('warn', subcommand('remove', [stringOption('case', 'that one time')]));

    expect(h.cases()).toEqual([]);
    expect(h.replyContent()).toContain('case id');
  });

  test('require-reason refuses before the warning is withdrawn, not after', async () => {
    const h = harness();
    h.warnings.seed(GUILD, standing());

    await h.run('warn', subcommand('remove', [stringOption('case', CASE_ID)]), {
      config: { requireReason: true },
    });

    expect(h.cases()).toEqual([]);
    expect(await h.warnings.find(GUILD, CASE_ID)).toMatchObject({ revertedAt: null });
    expect(h.replyContent()).toContain('requires a reason');
  });

  test('a redelivered interaction withdraws once and records once', async () => {
    const h = harness();
    h.warnings.seed(GUILD, standing());
    const idempotencyKey = 'fixed-interaction-key';

    await h.run('warn', subcommand('remove', [stringOption('case', CASE_ID)]), { idempotencyKey });
    await h.run('warn', subcommand('remove', [stringOption('case', CASE_ID)]), { idempotencyKey });

    // One reply, not two: the second delivery is refused as already withdrawn, and that refusal
    // is deduped on the same interaction token the first answer already spent.
    expect(h.cases()).toHaveLength(1);
    expect(h.rest.calls.filter((call) => call.path.startsWith('/interactions/'))).toHaveLength(1);
    expect(h.replyContent()).toContain('Withdrew');
  });

  test('says so rather than going quiet when the ledger is not bound', async () => {
    const h = harness();

    await h.run('warn', subcommand('remove', [stringOption('case', CASE_ID)]), { warnings: null });

    expect(h.cases()).toEqual([]);
    expect(h.replyContent()).toContain('case ledger');
  });

  // The stamp and the ledger entry cannot share a transaction, so the ledger goes first and the
  // moderator is told plainly when the half they care about did not land.
  test('says the warning still stands when the ledger entry landed but the stamp did not', async () => {
    const h = harness();
    const seeded = standing();

    await h.run('warn', subcommand('remove', [stringOption('case', CASE_ID)]), {
      warnings: {
        find: async () => seeded,
        withdraw: async () => false,
      },
    });

    expect(h.cases()).toHaveLength(1);
    expect(h.cases()[0]?.kind).toBe('unwarn');
    expect(h.replyContent()).toContain('still standing');
    expect(h.replyContent()).not.toContain('Withdrew');
    expect(h.logs.some((entry) => entry.level === 'error')).toBe(true);
  });

  test('withdrawing does not check hierarchy — a promoted member can still be cleared', async () => {
    const h = harness();
    h.warnings.seed(GUILD, standing({ targetId: ABOVE_BOT }));

    await h.run('warn', subcommand('remove', [stringOption('case', CASE_ID)]));

    expect(h.cases()).toHaveLength(1);
    expect(h.cases()[0]?.kind).toBe('unwarn');
  });
});
