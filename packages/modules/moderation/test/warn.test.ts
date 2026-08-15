import { describe, expect, test } from 'bun:test';
import { moderationModule } from '../src/index.ts';
import { ABOVE_BOT, harness, MEMBER, OWNER, stringOption, userOption } from './harness.ts';

/**
 * `/warn` and the event that finally makes escalation work.
 *
 * Two things are being pinned here, and they fail in opposite directions. A warn
 * must reach the ledger without touching Discord — there is no endpoint for it,
 * so any REST call at all means the kind was mis-mapped. And
 * `moderation.warned` must be published if and only if the warn was genuinely
 * recorded, because the `cases` ladder counts those events and a spurious one
 * times somebody out for nothing.
 */
describe('/warn', () => {
  test('is registered by the module', () => {
    expect(moderationModule.commands?.some((c) => c.name === 'warn')).toBe(true);
  });

  test('records a case without calling Discord at all', async () => {
    const h = harness();

    await h.run('warn', [userOption('user', MEMBER), stringOption('reason', 'spamming')]);

    // The interaction acknowledgement is the only REST traffic a warn generates.
    expect(h.discordCalls()).toEqual([]);
    expect(h.cases()).toHaveLength(1);
    expect(h.cases()[0]?.kind).toBe('warn');
    expect(h.cases()[0]?.targetId).toBe(MEMBER);
    expect(h.cases()[0]?.reason).toBe('spamming');
  });

  test('tells the moderator it happened', async () => {
    const h = harness();

    await h.run('warn', [userOption('user', MEMBER)]);

    expect(h.replyContent()).toContain('Warned');
  });

  test('publishes moderation.warned so the escalation ladder can fire', async () => {
    const h = harness();

    await h.run('warn', [userOption('user', MEMBER)]);

    expect(h.published).toHaveLength(1);
    expect(h.published[0]?.type).toBe('moderation.warned');
  });

  /**
   * The single most important assertion in this file. `cases/escalation.ts`
   * compiles each rung to a `rate-over-window` keyed on `RuleFacts.actorId`, and
   * the resolver takes that from `userId`. Publishing the moderator here would
   * escalate against staff — every moderator who issued three warnings would be
   * timed out by their own bot.
   */
  test('the published event names the warned member, not the moderator', async () => {
    const h = harness();

    await h.run('warn', [userOption('user', MEMBER)]);

    expect(h.published[0]?.payload).toMatchObject({ userId: MEMBER });
  });

  /**
   * I8 applies even though nothing is sent to Discord. §15 is explicit that
   * Proton refuses to act on the owner, and a ledger row saying the owner was
   * warned is still Proton acting.
   */
  test('refuses to warn the guild owner, and says why', async () => {
    const h = harness();

    await h.run('warn', [userOption('user', OWNER)]);

    expect(h.cases()).toEqual([]);
    expect(h.published).toEqual([]);
    expect(h.replyContent()).toBeTruthy();
  });

  test('refuses to warn a member above the bot', async () => {
    const h = harness();

    await h.run('warn', [userOption('user', ABOVE_BOT)]);

    expect(h.cases()).toEqual([]);
    expect(h.published).toEqual([]);
  });

  /**
   * A refused warn must not advance the ladder. This is the gate the
   * `status === 'executed'` check in `perform` exists for: a warn that never
   * happened raising an event would make the third *attempt* time someone out.
   */
  test('a refused warn publishes nothing', async () => {
    const h = harness();

    await h.run('warn', [userOption('user', OWNER)]);

    expect(h.published).toEqual([]);
  });

  /**
   * Gateway RESUME redelivers interactions. The executor discards the second
   * attempt as a duplicate, and because the event is only published on a genuine
   * `executed` result, the ladder counts one warning rather than two.
   */
  test('a redelivered interaction warns once and publishes once', async () => {
    const h = harness();
    const idempotencyKey = 'fixed-interaction-key';

    await h.run('warn', [userOption('user', MEMBER)], { idempotencyKey });
    await h.run('warn', [userOption('user', MEMBER)], { idempotencyKey });

    expect(h.cases()).toHaveLength(1);
    expect(h.published).toHaveLength(1);
  });

  test('honours the server’s require-reason policy', async () => {
    const h = harness();

    await h.run('warn', [userOption('user', MEMBER)], { config: { requireReason: true } });

    expect(h.cases()).toEqual([]);
    expect(h.published).toEqual([]);
    expect(h.replyContent()).toContain('requires a reason');
  });

  test('is refused when the module is switched off', async () => {
    const h = harness();

    await h.run('warn', [userOption('user', MEMBER)], { config: { enabled: false } });

    expect(h.cases()).toEqual([]);
    expect(h.published).toEqual([]);
  });
});
