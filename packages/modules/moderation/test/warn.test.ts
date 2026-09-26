import { describe, expect, test } from 'bun:test';
import { STATUS_ERROR_COLOUR, STATUS_SUCCESS_COLOUR } from '@proton/core';
import { type PunishDirection, punishConfigSchema } from '../src/config.ts';
import { moderationModule } from '../src/index.ts';
import type { LedgerCase } from '../src/punish/store.ts';
import {
  ABOVE_BOT,
  GUILD,
  type Harness,
  harness,
  MEMBER,
  MODERATOR,
  OWNER,
  stringOption,
  subcommand,
  userOption,
} from './harness.ts';
import { MemoryCaseLedger } from './punish-stores.ts';

const CASE_ID = 'K7f3M2q';

function forcing(kind: PunishDirection) {
  return { punish: punishConfigSchema.parse({ types: { [kind]: { forceReason: true } } }) };
}

function ledgerFor(h: Harness, warning: Partial<LedgerCase> | null = {}): MemoryCaseLedger {
  const ledger = new MemoryCaseLedger(h.now);
  ledger.follow(h.recorder);

  if (warning) {
    ledger.seed({
      caseId: CASE_ID,
      guildId: GUILD,
      kind: 'warn',
      targetId: MEMBER,
      reason: 'spamming',
      ...warning,
    });
  }

  return ledger;
}

class UnstampableLedger extends MemoryCaseLedger {
  override async closeOpen(): Promise<LedgerCase[]> {
    return [];
  }
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

  test('honours the server’s forced reason for warnings', async () => {
    const h = harness();

    await h.run('warn', subcommand('add', [userOption('user', MEMBER)]), {
      config: forcing('warn'),
    });

    expect(h.cases()).toEqual([]);
    expect(h.published).toEqual([]);
    expect(h.replyContent()).toContain('requires a reason');
  });

  test('a reason forced for another punishment does not stop a warning', async () => {
    const h = harness();

    await h.run('warn', subcommand('add', [userOption('user', MEMBER)]), {
      config: forcing('ban'),
    });

    expect(h.cases()).toHaveLength(1);
  });
});

describe('/warn remove', () => {
  test('withdraws the warning and records the withdrawal as its own case', async () => {
    const h = harness();
    const ledger = ledgerFor(h);

    await h.run(
      'warn',
      subcommand('remove', [stringOption('case', CASE_ID), stringOption('reason', 'appealed')]),
      { deps: { ledger } },
    );

    expect(h.discordCalls()).toEqual([]);
    expect(await ledger.find(GUILD, CASE_ID)).toMatchObject({ revertedBy: MODERATOR });
    expect(h.cases()).toHaveLength(1);
    expect(h.cases()[0]?.kind).toBe('unwarn');
    expect(h.cases()[0]?.targetId).toBe(MEMBER);
    expect(h.cases()[0]?.payload).toMatchObject({ userId: MEMBER, caseId: CASE_ID });
    expect(h.replyContent()).toContain(CASE_ID);
    expect(h.replyMessage()?.embeds?.[0]?.color).toBe(STATUS_SUCCESS_COLOUR);
  });

  test('publishes nothing — a withdrawal must not feed the escalation ladder', async () => {
    const h = harness();
    const ledger = ledgerFor(h);

    await h.run('warn', subcommand('remove', [stringOption('case', CASE_ID)]), {
      deps: { ledger },
    });

    expect(h.cases()).toHaveLength(1);
    expect(h.published).toEqual([]);
  });

  test('names the case id back when nothing in this server carries it', async () => {
    const h = harness();
    const ledger = ledgerFor(h, null);

    await h.run('warn', subcommand('remove', [stringOption('case', CASE_ID)]), {
      deps: { ledger },
    });

    expect(h.cases()).toEqual([]);
    expect(h.replyContent()).toContain(CASE_ID);
    expect(h.replyContent()).toContain('Cases');
  });

  test('will not withdraw a warning twice, and says who withdrew it', async () => {
    const h = harness();
    const ledger = ledgerFor(h, { revertedAt: h.now(), revertedBy: OWNER });

    await h.run('warn', subcommand('remove', [stringOption('case', CASE_ID)]), {
      deps: { ledger },
    });

    expect(h.cases()).toEqual([]);
    expect(h.replyContent()).toContain('already withdrawn');
    expect(h.replyContent()).toContain(OWNER);
  });

  test('explains what a case id looks like when the option is not one', async () => {
    const h = harness();

    await h.run('warn', subcommand('remove', [stringOption('case', 'that one time')]));

    expect(h.cases()).toEqual([]);
    expect(h.replyContent()).toContain('case ID');
  });

  test('require-reason refuses before the warning is withdrawn, not after', async () => {
    const h = harness();
    const ledger = ledgerFor(h);

    await h.run('warn', subcommand('remove', [stringOption('case', CASE_ID)]), {
      config: forcing('unwarn'),
      deps: { ledger },
    });

    expect(h.cases()).toEqual([]);
    expect(await ledger.find(GUILD, CASE_ID)).toMatchObject({ revertedAt: null });
    expect(h.replyContent()).toContain('requires a reason');
  });

  test('a redelivered interaction withdraws once and records once', async () => {
    const h = harness();
    const ledger = ledgerFor(h);
    const idempotencyKey = 'fixed-interaction-key';
    const options = subcommand('remove', [stringOption('case', CASE_ID)]);

    await h.run('warn', options, { idempotencyKey, deps: { ledger } });
    await h.run('warn', options, { idempotencyKey, deps: { ledger } });

    expect(h.cases()).toHaveLength(1);
    expect(h.rest.calls.filter((call) => call.path.startsWith('/interactions/'))).toHaveLength(1);
    expect(h.replyContent()).toContain('Withdrew');
  });

  test('says so rather than going quiet when the ledger is not bound', async () => {
    const h = harness();

    await h.run('warn', subcommand('remove', [stringOption('case', CASE_ID)]));

    expect(h.cases()).toEqual([]);
    expect(h.replyContent()).toContain("can't read this server's cases");
  });

  test('says the warning still stands when the ledger entry landed but the stamp did not', async () => {
    const h = harness();
    const ledger = new UnstampableLedger(h.now);
    ledger.follow(h.recorder);
    ledger.seed({ caseId: CASE_ID, guildId: GUILD, kind: 'warn', targetId: MEMBER });

    await h.run('warn', subcommand('remove', [stringOption('case', CASE_ID)]), {
      deps: { ledger },
    });

    expect(h.cases()).toHaveLength(1);
    expect(h.cases()[0]?.kind).toBe('unwarn');
    expect(h.replyContent()).toContain('still stands');
    expect(h.replyContent()).not.toContain('Withdrew');
    expect(h.replyMessage()?.embeds?.[0]?.color).toBe(STATUS_ERROR_COLOUR);
  });

  test('withdrawing does not check hierarchy — a promoted member can still be cleared', async () => {
    const h = harness();
    const ledger = ledgerFor(h, { targetId: ABOVE_BOT });

    await h.run('warn', subcommand('remove', [stringOption('case', CASE_ID)]), {
      deps: { ledger },
    });

    expect(h.cases()).toHaveLength(1);
    expect(h.cases()[0]?.kind).toBe('unwarn');
  });
});
