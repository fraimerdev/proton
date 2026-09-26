import { describe, expect, test } from 'bun:test';
import {
  Permissions,
  STATUS_ERROR_COLOUR,
  STATUS_ERROR_EMOJI,
  STATUS_SUCCESS_COLOUR,
  STATUS_SUCCESS_EMOJI,
} from '@proton/core';
import { APPEALS_ACTOR } from '../src/config.ts';
import { applyDecision } from '../src/decision.ts';
import { tellAppellant } from '../src/notify.ts';
import type { AppealRecord } from '../src/store.ts';
import {
  CARD,
  callsOf,
  type Fake,
  GUILD,
  harness,
  MEMBER,
  MOD,
  OTHER_MOD,
  OTHER_ROLE,
  panel,
  REVIEW_CHANNEL,
  REVIEWER_ROLE,
  replyColour,
  replyCount,
  replyText,
} from './harness.ts';

const NOT_CARRIED_OUT = 'the outcome has NOT been carried out yet';

async function fileWithCard(fake: Fake): Promise<AppealRecord> {
  const appeal = await fake.file();
  await fake.store.rememberCard(GUILD, appeal.id, REVIEW_CHANNEL, CARD);

  return appeal;
}

function cardText(fake: Fake): string {
  const edited = callsOf(fake, 'edit_message').filter((call) => call.status === 'executed');

  return JSON.stringify(edited.at(-1)?.payload ?? null);
}

function logged(fake: Fake, level: string): string[] {
  return fake.logs.filter((entry) => entry.level === level).map((entry) => entry.message);
}

async function decided(fake: Fake, decision: 'approved' | 'denied'): Promise<AppealRecord> {
  const appeal = await fake.file();
  const done = await fake.store.decide({
    guildId: GUILD,
    appealId: appeal.id,
    decision,
    decidedBy: MOD,
  });
  if (!done) throw new Error('the appeal was not decided');

  return done;
}

describe('deciding an appeal', () => {
  test('accepting it lifts the ban and answers green', async () => {
    const fake = harness();
    const appeal = await fake.file();

    const outcome = await fake.press({ appealId: appeal.id });

    expect(outcome).toEqual({ action: 'decided', decision: 'approved', appealId: appeal.id });
    expect(replyText(fake)).toBe(
      `${STATUS_SUCCESS_EMOJI} Appeal #1 accepted. <@${MEMBER}> has been told.`,
    );
    expect(replyColour(fake)).toBe(STATUS_SUCCESS_COLOUR);
    expect(callsOf(fake, 'unban')).toHaveLength(1);
  });

  test('the unban is the moderator’s who accepted, so the logs name them', async () => {
    const fake = harness();
    const appeal = await fake.file();

    await fake.press({ appealId: appeal.id, userId: OTHER_MOD });

    expect(callsOf(fake, 'unban').map((call) => call.actorId)).toEqual([OTHER_MOD]);
    expect(callsOf(fake, 'unban')[0]?.idempotencyKey).toBe(`appeals:${appeal.id}:unban`);
  });

  test('an acceptance with no member on record is Appeals’ own', async () => {
    const fake = harness();
    const appeal = await decided(fake, 'approved');

    await applyDecision(fake.ctx, fake.deps, { ...appeal, decidedBy: null }, panel());

    expect(callsOf(fake, 'unban').map((call) => call.actorId)).toEqual([APPEALS_ACTOR]);
  });

  test('a lifted timeout is the accepting moderator’s too', async () => {
    const fake = harness({ panels: [panel({ onApprove: 'untimeout' })] });
    const appeal = await fake.file();

    await fake.press({ appealId: appeal.id });

    expect(callsOf(fake, 'untimeout').map((call) => call.actorId)).toEqual([MOD]);
  });

  test('turning it down answers green too — the decision was carried out', async () => {
    const fake = harness();
    const appeal = await fake.file();

    await fake.press({ appealId: appeal.id, decision: 'denied' });

    expect(replyText(fake)).toBe(
      `${STATUS_SUCCESS_EMOJI} Appeal #1 turned down. <@${MEMBER}> has been told.`,
    );
    expect(replyColour(fake)).toBe(STATUS_SUCCESS_COLOUR);
    expect(callsOf(fake, 'unban')).toHaveLength(0);
  });

  test('a named reviewer role may decide without Manage Server', async () => {
    const fake = harness({ config: { reviewerRoleIds: [REVIEWER_ROLE] } });
    const appeal = await fake.file();

    await fake.press({ appealId: appeal.id, permissions: 0n, roleIds: [REVIEWER_ROLE] });

    expect(replyColour(fake)).toBe(STATUS_SUCCESS_COLOUR);
    expect((await fake.store.find(appeal.guildId, appeal.id))?.status).toBe('approved');
  });
});

describe('when Proton cannot decide it', () => {
  test('somebody without Manage Server is refused in red, and nothing is recorded', async () => {
    const fake = harness();
    const appeal = await fake.file();

    const outcome = await fake.press({
      appealId: appeal.id,
      permissions: Permissions.BanMembers,
      roleIds: [OTHER_ROLE],
    });

    expect(outcome.action).toBe('refused');
    expect(replyText(fake)).toStartWith(STATUS_ERROR_EMOJI);
    expect(replyText(fake)).toContain('Manage Server');
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
    expect((await fake.store.find(appeal.guildId, appeal.id))?.status).toBe('open');
    expect(callsOf(fake, 'unban')).toHaveLength(0);
  });

  test('a role-gated server names its reviewers rather than Manage Server', async () => {
    const fake = harness({ config: { reviewerRoleIds: [REVIEWER_ROLE] } });
    const appeal = await fake.file();

    await fake.press({ appealId: appeal.id, permissions: 0n, roleIds: [OTHER_ROLE] });

    expect(replyText(fake)).toBe(
      `${STATUS_ERROR_EMOJI} Only this server’s appeal reviewers can decide this one.`,
    );
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
  });

  test('an appeal that is gone says so in red', async () => {
    const fake = harness();

    const outcome = await fake.press({ appealId: 'appeal-404' });

    expect(outcome).toEqual({ action: 'ignored', reason: 'no such appeal' });
    expect(replyText(fake)).toBe(
      `${STATUS_ERROR_EMOJI} I couldn’t find that appeal, so nothing changed.`,
    );
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
  });

  test('a removed form is named, because Proton no longer knows what accepting means', async () => {
    const fake = harness({ panels: [panel({ id: 'other' })] });
    const appeal = await fake.file();

    const outcome = await fake.press({ appealId: appeal.id });

    expect(outcome).toEqual({ action: 'refused', reason: 'the panel is gone' });
    expect(replyText(fake)).toStartWith(STATUS_ERROR_EMOJI);
    expect(replyText(fake)).toContain('has been deleted');
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
  });

  test('an unbound store refuses in red and says so in the log', async () => {
    const fake = harness({ store: false });

    const outcome = await fake.press();

    expect(outcome).toEqual({ action: 'refused', reason: 'the appeal store is unbound' });
    expect(replyText(fake)).toBe(
      `${STATUS_ERROR_EMOJI} I can’t record appeal decisions right now, so nothing changed.`,
    );
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
    expect(fake.logs.some((entry) => entry.level === 'error')).toBe(true);
  });
});

describe('two reviewers at once', () => {
  test('the loser is told who got there first, in red', async () => {
    const fake = harness();
    const appeal = await fake.file();

    await fake.press({ appealId: appeal.id });
    const outcome = await fake.press({
      appealId: appeal.id,
      decision: 'denied',
      userId: OTHER_MOD,
    });

    expect(outcome).toEqual({ action: 'ignored', reason: 'already decided' });
    expect(replyText(fake)).toBe(
      `${STATUS_ERROR_EMOJI} Someone else got there first. Appeal #1 was accepted by <@${MOD}>.`,
    );
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
  });

  // Pressing the same button again repairs a crash between the decision and the unban, so it ends
  // green: the appeal really is accepted and the rest has now been carried out.
  test('pressing the same button again finishes the rest and answers green', async () => {
    const fake = harness();
    const appeal = await fake.file();

    await fake.press({ appealId: appeal.id });
    const outcome = await fake.press({ appealId: appeal.id });

    expect(outcome).toEqual({ action: 'decided', decision: 'approved', appealId: appeal.id });
    expect(replyText(fake)).toBe(
      `${STATUS_SUCCESS_EMOJI} Appeal #1 was already accepted. I’ve finished carrying it out, ` +
        `and <@${MEMBER}> has been told.`,
    );
    expect(replyColour(fake)).toBe(STATUS_SUCCESS_COLOUR);
    expect(replyCount(fake)).toBe(2);
    expect(callsOf(fake, 'unban')).toHaveLength(2);
  });
});

describe('when Discord answers the unban with a refusal', () => {
  test('a member who is no longer banned counts as unbanned, and the rest is carried out', async () => {
    const fake = harness({ blocked: true });
    const appeal = await fileWithCard(fake);
    fake.refuse('unban', 'discord_404', 'That user is not banned here.');

    await fake.press({ appealId: appeal.id });

    expect((await fake.store.find(GUILD, appeal.id))?.outcomeApplied).toBe(true);
    expect(fake.lifts.map((lift) => lift.userId)).toEqual([MEMBER]);
    expect(cardText(fake)).toContain(`Accepted by <@${MOD}>.`);
    expect(cardText(fake)).not.toContain(NOT_CARRIED_OUT);
    expect(logged(fake, 'error')).toEqual([]);
    expect(logged(fake, 'info').join('\n')).toContain('was no longer banned');
    expect(replyColour(fake)).toBe(STATUS_SUCCESS_COLOUR);
  });

  test('Discord’s own Unknown Ban code counts the same way', async () => {
    const fake = harness({ blocked: true });
    const appeal = await fileWithCard(fake);
    fake.refuse('unban', 'discord_404', 'That user is not banned here.', { discordCode: 10026 });

    await fake.press({ appealId: appeal.id });

    expect((await fake.store.find(GUILD, appeal.id))?.outcomeApplied).toBe(true);
    expect(fake.lifts).toHaveLength(1);
    expect(cardText(fake)).not.toContain(NOT_CARRIED_OUT);
  });

  test('a 404 whose body carries no Discord code is decided by the status', async () => {
    const fake = harness({ blocked: true });
    const appeal = await fileWithCard(fake);
    fake.refuse('unban', 'discord_404', 'That user is not banned here.', {});

    await fake.press({ appealId: appeal.id });

    expect((await fake.store.find(GUILD, appeal.id))?.outcomeApplied).toBe(true);
    expect(fake.lifts).toHaveLength(1);
  });

  test('a 404 about something other than the ban is still a failure', async () => {
    const fake = harness({ blocked: true });
    const appeal = await fileWithCard(fake);
    fake.refuse('unban', 'discord_404', 'Discord does not know this server.', {
      discordCode: 10004,
    });

    await fake.press({ appealId: appeal.id });

    expect((await fake.store.find(GUILD, appeal.id))?.outcomeApplied).toBe(false);
    expect(fake.lifts).toEqual([]);
    expect(cardText(fake)).toContain(NOT_CARRIED_OUT);
    expect(logged(fake, 'error').join('\n')).toContain('could NOT be unbanned');
    expect(replyText(fake)).toContain(
      `I couldn’t unban <@${MEMBER}>: Discord does not know this server.`,
    );
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
  });

  test('an unknown-route 404 (code 0) is a failure, not a lifted ban', async () => {
    const fake = harness({ blocked: true });
    const appeal = await fileWithCard(fake);
    fake.refuse('unban', 'discord_404', 'Discord did not recognise that request.', {
      discordCode: 0,
    });

    await fake.press({ appealId: appeal.id });

    expect((await fake.store.find(GUILD, appeal.id))?.outcomeApplied).toBe(false);
    expect(fake.lifts).toEqual([]);
    expect(cardText(fake)).toContain(NOT_CARRIED_OUT);
  });

  test('a 403 leaves the outcome unapplied and says why, in the log and to the moderator', async () => {
    const fake = harness({ blocked: true });
    const appeal = await fileWithCard(fake);
    fake.refuse('unban', 'discord_403', 'Discord says Proton may not ban members here.');

    await fake.press({ appealId: appeal.id });

    expect((await fake.store.find(GUILD, appeal.id))?.outcomeApplied).toBe(false);
    expect(fake.lifts).toEqual([]);
    expect(cardText(fake)).toContain(NOT_CARRIED_OUT);

    const [error] = logged(fake, 'error');
    expect(error).toContain(`${MEMBER} could NOT be unbanned`);
    expect(error).toContain(
      'Discord says Proton may not ban members here. A moderator has to lift the ban by hand if ' +
        'it is still in place.',
    );
    expect(error).not.toContain('Accept again');
    expect(error).not.toContain('..');

    expect(replyText(fake)).toBe(
      `${STATUS_ERROR_EMOJI} Appeal #1 accepted, but I couldn’t unban <@${MEMBER}>: Discord says ` +
        'Proton may not ban members here. Lift the ban by hand if it’s still in place. ' +
        `<@${MEMBER}> has been told.`,
    );
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
  });

  test('a lifted timeout is never assumed: a 404 on untimeout stays a failure', async () => {
    const fake = harness({ blocked: true, panels: [panel({ onApprove: 'untimeout' })] });
    const appeal = await fileWithCard(fake);
    fake.refuse('untimeout', 'discord_404', 'That member is not in this server.');

    await fake.press({ appealId: appeal.id });

    expect((await fake.store.find(GUILD, appeal.id))?.outcomeApplied).toBe(false);
    expect(fake.lifts).toEqual([]);
    expect(logged(fake, 'error').join('\n')).toContain(
      'could NOT be untimed out: That member is not in this server. A moderator has to lift the ' +
        'timeout by hand if it is still in place.',
    );
    expect(replyText(fake)).toContain(
      `I couldn’t lift the timeout on <@${MEMBER}>: That member is not in this server.`,
    );
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
  });

  test('a redelivered press after a failed unban re-runs it, and answers red if it fails again', async () => {
    const fake = harness({ blocked: true });
    const appeal = await fileWithCard(fake);
    fake.refuse('unban', 'discord_403', 'Discord says Proton may not ban members here.');
    await fake.press({ appealId: appeal.id });

    fake.refuse('unban', 'discord_403', 'Discord says Proton may not ban members here.');
    await fake.press({ appealId: appeal.id });

    expect(callsOf(fake, 'unban')).toHaveLength(2);
    expect(replyText(fake)).toStartWith(
      `${STATUS_ERROR_EMOJI} Appeal #1 was already accepted, but I couldn’t unban <@${MEMBER}>:`,
    );
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
  });

  test('a ban found gone on a redelivered press re-stamps a card already marked not carried out', async () => {
    const fake = harness({ blocked: true });
    const appeal = await fileWithCard(fake);
    fake.refuse('unban', 'transport_failure', 'I could not reach Discord.');
    await fake.press({ appealId: appeal.id });

    expect(cardText(fake)).toContain(NOT_CARRIED_OUT);

    fake.refuse('unban', 'discord_404', 'That user is not banned here.', { discordCode: 10026 });
    await fake.press({ appealId: appeal.id });

    expect((await fake.store.find(GUILD, appeal.id))?.outcomeApplied).toBe(true);
    expect(cardText(fake)).toContain(`Accepted by <@${MOD}>.`);
    expect(cardText(fake)).not.toContain(NOT_CARRIED_OUT);
  });
});

describe('the stamped review card', () => {
  test('a turned-down appeal owes nothing, so its card never says the outcome is pending', async () => {
    const fake = harness();
    const appeal = await fileWithCard(fake);

    await fake.press({ appealId: appeal.id, decision: 'denied' });

    expect(cardText(fake)).toContain(`Turned down by <@${MOD}>.`);
    expect(cardText(fake)).not.toContain(NOT_CARRIED_OUT);
  });

  test('a form that does nothing on acceptance never says the outcome is pending', async () => {
    const fake = harness({ panels: [panel({ onApprove: 'nothing' })] });
    const appeal = await fileWithCard(fake);

    await fake.press({ appealId: appeal.id });

    expect(callsOf(fake, 'unban')).toHaveLength(0);
    expect(cardText(fake)).toContain(`Accepted by <@${MOD}>.`);
    expect(cardText(fake)).not.toContain(NOT_CARRIED_OUT);
  });
});

describe('telling the appellant', () => {
  test('a message Discord refuses with 403 is closed direct messages, and names no permission', async () => {
    const fake = harness();
    const appeal = await decided(fake, 'denied');
    fake.refuse('send', 'discord_403', 'Proton is missing Send Messages in that channel.');

    expect(await tellAppellant(fake.ctx, fake.store, appeal, panel())).toBe('closed');

    const [warning] = logged(fake, 'warn');
    expect(warning).toContain(`appeal #1 was decided but ${MEMBER} could not be told`);
    expect(warning).toContain('Their direct messages are closed');
    expect(warning).not.toContain('Send Messages');
    expect(logged(fake, 'error')).toEqual([]);
  });

  test.each([
    ['DMs closed', 50007],
    ['no shared server', 50278],
  ])('a 403 whose code says %s is closed direct messages', async (_label, discordCode) => {
    const fake = harness();
    const appeal = await decided(fake, 'denied');
    fake.refuse('send', 'discord_403', 'Discord would not deliver that.', { discordCode });

    expect(await tellAppellant(fake.ctx, fake.store, appeal, panel())).toBe('closed');
    expect(logged(fake, 'warn').join('\n')).toContain('Their direct messages are closed');
    expect(logged(fake, 'error')).toEqual([]);
  });

  test('a 403 with any other code is a failure that carries Discord’s reason, not closed DMs', async () => {
    const fake = harness();
    const appeal = await decided(fake, 'denied');
    fake.refuse('send', 'discord_403', 'Discord has temporarily stopped Proton sending messages.', {
      discordCode: 40004,
    });

    expect(await tellAppellant(fake.ctx, fake.store, appeal, panel())).toBe('failed');

    const [error] = logged(fake, 'error');
    expect(error).toContain(
      `${MEMBER} could not be told: Discord has temporarily stopped Proton sending messages. ` +
        'They do not know the outcome.',
    );
    expect(logged(fake, 'warn')).toEqual([]);
  });

  test('a conversation Discord refuses to open with another 403 code is a failure too', async () => {
    const fake = harness();
    const appeal = await decided(fake, 'approved');
    fake.refuse('create_dm', 'discord_403', 'Discord says Proton lacks access.', {
      discordCode: 50001,
    });

    expect(await tellAppellant(fake.ctx, fake.store, appeal, panel())).toBe('failed');
    expect(callsOf(fake, 'send')).toHaveLength(0);
    expect(logged(fake, 'warn').join('\n')).not.toContain('Their direct messages are closed');
  });

  test('any other refused message is an error that carries Discord’s reason', async () => {
    const fake = harness();
    const appeal = await decided(fake, 'approved');
    fake.refuse('send', 'discord_400', 'Discord rejected the message.');

    expect(await tellAppellant(fake.ctx, fake.store, appeal, panel())).toBe('failed');

    const [error] = logged(fake, 'error');
    expect(error).toContain(
      `${MEMBER} could not be told: Discord rejected the message. They do not know the outcome.`,
    );
    expect(logged(fake, 'warn')).toEqual([]);
  });

  test('a message that may have landed is never reported as unread', async () => {
    for (const code of ['transport_failure', 'discord_502']) {
      const fake = harness();
      const appeal = await decided(fake, 'approved');
      fake.refuse('send', code, 'That may not have gone through.');

      expect(await tellAppellant(fake.ctx, fake.store, appeal, panel())).toBe('unconfirmed');

      const [error] = logged(fake, 'error');
      expect(error).toContain(`the message telling ${MEMBER} may not have reached them`);
      expect(error).toContain('Proton cannot tell whether they know the outcome.');
      expect(error).not.toContain('They do not know the outcome.');
    }
  });

  test('a conversation that could not be opened was never sent, whatever the failure', async () => {
    const fake = harness();
    const appeal = await decided(fake, 'approved');
    fake.refuse('create_dm', 'transport_failure', 'I could not reach Discord.');

    expect(await tellAppellant(fake.ctx, fake.store, appeal, panel())).toBe('failed');
    expect(callsOf(fake, 'send')).toHaveLength(0);
    expect(logged(fake, 'error').join('\n')).toContain('They do not know the outcome.');
  });

  test('a conversation that could not be opened is logged rather than dropped', async () => {
    const fake = harness();
    const appeal = await decided(fake, 'approved');
    fake.refuse('create_dm', 'discord_403', 'Proton is missing Send Messages.');

    expect(await tellAppellant(fake.ctx, fake.store, appeal, panel())).toBe('closed');
    expect(callsOf(fake, 'send')).toHaveLength(0);
    expect(logged(fake, 'warn').join('\n')).toContain('Their direct messages are closed');
  });

  test('a member who could not be told does not undo the accepted decision', async () => {
    const fake = harness();
    const appeal = await fake.file();
    fake.refuse('send', 'discord_403', 'Cannot send messages to this user.');

    const outcome = await fake.press({ appealId: appeal.id });

    expect(outcome).toEqual({ action: 'decided', decision: 'approved', appealId: appeal.id });
    expect((await fake.store.find(GUILD, appeal.id))?.outcomeApplied).toBe(true);
    expect(logged(fake, 'warn').join('\n')).toContain('Their direct messages are closed');
  });
});

describe('what the moderator is told about telling the member', () => {
  test('closed direct messages keep the reply green but never claim the member was told', async () => {
    const fake = harness();
    const appeal = await fake.file();
    fake.refuse('send', 'discord_403', 'Cannot send messages to this user.');

    await fake.press({ appealId: appeal.id });

    expect(replyText(fake)).toBe(
      `${STATUS_SUCCESS_EMOJI} Appeal #1 accepted. I couldn’t DM <@${MEMBER}>. Their DMs are ` +
        'closed, or they no longer share a server with me.',
    );
    expect(replyColour(fake)).toBe(STATUS_SUCCESS_COLOUR);
  });

  test('a message that may not have landed is reported as unconfirmed', async () => {
    const fake = harness();
    const appeal = await fake.file();
    fake.refuse('send', 'transport_failure', 'I could not reach Discord.');

    await fake.press({ appealId: appeal.id, decision: 'denied' });

    expect(replyText(fake)).toBe(
      `${STATUS_SUCCESS_EMOJI} Appeal #1 turned down. I can’t tell whether <@${MEMBER}> got the ` +
        'decision, because Discord didn’t confirm it.',
    );
  });

  test('a refused message asks the moderator to tell the member themselves', async () => {
    const fake = harness();
    const appeal = await fake.file();
    fake.refuse('send', 'discord_400', 'Discord rejected the message.');

    await fake.press({ appealId: appeal.id });

    expect(replyText(fake)).toBe(
      `${STATUS_SUCCESS_EMOJI} Appeal #1 accepted. I couldn’t send <@${MEMBER}> the decision, so ` +
        'let them know yourself.',
    );
  });

  test('a repeated press that still cannot reach the member says so', async () => {
    const fake = harness();
    const appeal = await fake.file();
    fake.refuse('send', 'discord_403', 'Cannot send messages to this user.');
    await fake.press({ appealId: appeal.id });

    fake.refuse('send', 'discord_403', 'Cannot send messages to this user.');
    await fake.press({ appealId: appeal.id });

    expect(replyText(fake)).toBe(
      `${STATUS_SUCCESS_EMOJI} Appeal #1 was already accepted. I’ve finished carrying it out. ` +
        `I couldn’t DM <@${MEMBER}>. Their DMs are closed, or they no longer share a server ` +
        'with me.',
    );
  });
});
