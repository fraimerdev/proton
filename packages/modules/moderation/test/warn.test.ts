import { describe, expect, test } from 'bun:test';
import { moderationModule } from '../src/index.ts';
import { ABOVE_BOT, harness, MEMBER, OWNER, stringOption, userOption } from './harness.ts';

describe('/warn', () => {
  test('is registered by the module', () => {
    expect(moderationModule.commands?.some((c) => c.name === 'warn')).toBe(true);
  });

  test('records a case without calling Discord at all', async () => {
    const h = harness();

    await h.run('warn', [userOption('user', MEMBER), stringOption('reason', 'spamming')]);

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

  test('the published event names the warned member, not the moderator', async () => {
    const h = harness();

    await h.run('warn', [userOption('user', MEMBER)]);

    expect(h.published[0]?.payload).toMatchObject({ userId: MEMBER });
  });

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

  test('a refused warn publishes nothing', async () => {
    const h = harness();

    await h.run('warn', [userOption('user', OWNER)]);

    expect(h.published).toEqual([]);
  });

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
});
