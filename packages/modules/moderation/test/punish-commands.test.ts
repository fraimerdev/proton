import { describe, expect, test } from 'bun:test';
import {
  INTERACTION_CALLBACK_AUTOCOMPLETE_RESULT,
  INTERACTION_CALLBACK_DEFERRED_MESSAGE,
  INTERACTION_CALLBACK_MODAL,
  INTERACTION_CALLBACK_UPDATE_MESSAGE,
  MESSAGE_FLAG_EPHEMERAL,
  OptionType,
  parseCustomId,
  type RawOption,
} from '@proton/core';
import { ComponentType } from 'discord-api-types/v10';
import { banCommand, kickCommand, timeoutCommand, warnCommand } from '../src/commands/member.ts';
import { EXPIRED, MODERATION_OFF, NOT_YOURS } from '../src/punish/pending.ts';
import { autocompleteEvent, modalEvent, pressEvent, slashEvent } from './drivers.ts';
import {
  discordError,
  GUILD,
  LOW_ROLE,
  MEMBER,
  MODERATOR,
  OWNER,
  stringOption,
  subcommand,
  userOption,
} from './harness.ts';
import { MOD_PERMISSIONS } from './punish-kit.ts';
import {
  callbacks,
  customIds,
  lastCallback,
  lastFollowUp,
  lastModal,
  modalFields,
  NOW,
  type PunishRig,
  punishRig,
  textOf,
} from './punish-rig.ts';

const REASONS = [
  { id: 'spam', reason: 'Spamming the channels', aliases: ['sp'] },
  { id: 'raid', reason: 'Taking part in a raid', aliases: ['r'] },
];

const RECENT = { punish: { confirmRecentCase: { enabled: true } } };

function warnAdd(options: RawOption[] = [], settings: Parameters<typeof slashEvent>[2] = {}) {
  return slashEvent('warn', subcommand('add', [userOption('user', MEMBER), ...options]), {
    permissions: MOD_PERMISSIONS,
    ...settings,
  });
}

function seedRecentWarn(rig: PunishRig): void {
  rig.ledger.seed({
    caseId: 'Krecent',
    guildId: GUILD,
    kind: 'warn',
    targetId: MEMBER,
    createdAt: NOW - 60_000,
  });
}

function promptIds(rig: PunishRig): { go: string; stop: string; pendingId: string } {
  const [go, stop] = customIds(lastFollowUp(rig.h));
  const pendingId = parseCustomId(go)?.args[0];
  if (!go || !stop || !pendingId) throw new Error('the last follow-up carries no confirm prompt');
  return { go, stop, pendingId };
}

function warnCases(rig: PunishRig) {
  return rig.h.cases().filter((entry) => entry.kind === 'warn');
}

describe('punishment commands answer through the pipeline', () => {
  test('defers privately, then follows up with the case stamp', async () => {
    const rig = punishRig();
    const event = warnAdd([stringOption('reason', 'being rude')]);

    await rig.command(event);

    const [defer] = callbacks(rig.h);
    expect(defer?.type).toBe(INTERACTION_CALLBACK_DEFERRED_MESSAGE);
    expect(defer?.data.flags).toBe(MESSAGE_FLAG_EPHEMERAL);

    const result = lastFollowUp(rig.h);
    expect(rig.h.statusOf(result)).toBe('success');
    expect(textOf(result)).toMatch(/Warned <@\d+>\.\n-# Case `[A-Za-z0-9]{7}`$/);
    expect(warnCases(rig)).toHaveLength(1);
    expect(rig.h.keysUsed()).toContain(`${event.id}:action`);
  });

  test('with public replies the defer and the result are public', async () => {
    const rig = punishRig({ config: { publicReplies: true } });

    await rig.command(warnAdd());

    expect(callbacks(rig.h)[0]?.data.flags).toBeUndefined();
    expect(lastFollowUp(rig.h).flags).toBeUndefined();
    expect(rig.h.statusOf(lastFollowUp(rig.h))).toBe('success');
  });

  test('a predefined alias typed as the reason is expanded on the case', async () => {
    const rig = punishRig({ config: { punish: { reasons: REASONS } } });

    await rig.command(warnAdd([stringOption('reason', 'SP')]));

    expect(warnCases(rig)[0]?.reason).toBe('Spamming the channels');
  });

  test('a refusal from the pipeline comes back red, and nothing is recorded', async () => {
    const rig = punishRig({ config: { punish: { immunity: { warn: [LOW_ROLE] } } } });

    await rig.command(warnAdd());

    expect(rig.h.statusOf(lastFollowUp(rig.h))).toBe('error');
    expect(textOf(lastFollowUp(rig.h))).toContain(`<@&${LOW_ROLE}>`);
    expect(warnCases(rig)).toHaveLength(0);
  });

  test('reason options autocomplete only where a punishment is given', () => {
    const reasonsOf = (data: unknown): boolean[] => {
      const found: boolean[] = [];
      const walk = (node: unknown): void => {
        if (typeof node !== 'object' || node === null) return;
        const option = node as { name?: unknown; type?: unknown; autocomplete?: unknown };
        if (option.name === 'reason' && option.type === OptionType.String) {
          found.push(option.autocomplete === true);
        }
        for (const child of (node as { options?: unknown[] }).options ?? []) walk(child);
      };
      walk(data);
      return found;
    };

    expect(reasonsOf(banCommand({}).data)).toEqual([true, false]);
    expect(reasonsOf(kickCommand({}).data)).toEqual([true]);
    expect(reasonsOf(timeoutCommand({}).data)).toEqual([true, false]);
    expect(reasonsOf(warnCommand({}).data)).toEqual([true, false]);
  });

  test('/ban remove lifts the ban through the ledger, reverting the open ban case', async () => {
    const rig = punishRig();
    rig.ledger.seed({ caseId: 'Kbanned', guildId: GUILD, kind: 'ban', targetId: MEMBER });

    await rig.command(
      slashEvent('ban', subcommand('remove', [stringOption('user_id', MEMBER)]), {
        permissions: MOD_PERMISSIONS,
      }),
    );

    expect(rig.h.discordCalls().map((call) => `${call.method} ${call.path}`)).toEqual([
      `DELETE /guilds/${GUILD}/bans/${MEMBER}`,
    ]);
    expect((await rig.ledger.find(GUILD, 'Kbanned'))?.revertedBy).toBe(MODERATOR);
    expect(textOf(lastFollowUp(rig.h))).toContain('Unbanned');
  });

  test('refuses at once when moderation is turned off', async () => {
    const rig = punishRig();

    await rig.h.run('kick', [userOption('user', MEMBER)], {
      ...rig.overrides(),
      configInput: { enabled: false },
    });

    expect(rig.h.discordCalls()).toEqual([]);
    expect(rig.h.statusOf(rig.h.replies()[0])).toBe('error');
    expect(textOf(rig.h.replies()[0])).toContain(MODERATION_OFF);
  });
});

describe('recent-case confirmation', () => {
  test('asks to continue instead of punishing, and Continue carries it out once', async () => {
    const rig = punishRig({ config: RECENT });
    seedRecentWarn(rig);

    await rig.command(warnAdd());

    const prompt = lastFollowUp(rig.h);
    expect(rig.h.statusOf(prompt)).toBe('neutral');
    expect(prompt.flags).toBe(MESSAGE_FLAG_EPHEMERAL);
    expect(textOf(prompt)).toContain('Krecent');
    expect(warnCases(rig)).toHaveLength(0);

    const { go, pendingId } = promptIds(rig);
    await rig.interact(pressEvent(go, { permissions: MOD_PERMISSIONS }));

    const update = lastCallback(rig.h);
    expect(update.type).toBe(INTERACTION_CALLBACK_UPDATE_MESSAGE);
    expect(update.data.content).toBe('Working on it…');
    expect(update.data.components).toEqual([]);

    expect(rig.h.statusOf(lastFollowUp(rig.h))).toBe('success');
    expect(warnCases(rig)).toHaveLength(1);
    expect(rig.h.keysUsed()).toContain(`moderation:pending:${GUILD}:${pendingId}:action`);
  });

  test('Cancel replaces the prompt and nothing is done, even if Continue is pressed after', async () => {
    const rig = punishRig({ config: RECENT });
    seedRecentWarn(rig);
    await rig.command(warnAdd());
    const { go, stop } = promptIds(rig);

    await rig.interact(pressEvent(stop));
    expect(lastCallback(rig.h).type).toBe(INTERACTION_CALLBACK_UPDATE_MESSAGE);
    expect(lastCallback(rig.h).data.content).toBe('Cancelled.');

    await rig.interact(pressEvent(go, { permissions: MOD_PERMISSIONS }));
    expect(lastCallback(rig.h).data.content).toBe('Cancelled.');
    expect(warnCases(rig)).toHaveLength(0);
  });

  test('a double Continue press punishes once and answers the second with the outcome', async () => {
    const rig = punishRig({ config: RECENT });
    seedRecentWarn(rig);
    await rig.command(warnAdd());
    const { go } = promptIds(rig);

    await rig.interact(pressEvent(go, { permissions: MOD_PERMISSIONS }));
    await rig.interact(pressEvent(go, { permissions: MOD_PERMISSIONS }));

    expect(warnCases(rig)).toHaveLength(1);
    const second = lastCallback(rig.h);
    expect(second.type).toBe(INTERACTION_CALLBACK_UPDATE_MESSAGE);
    expect(rig.h.statusOf(second.data)).toBe('success');
    expect(textOf(second.data)).toContain('Warned');
  });

  test('only the moderator who ran the command can confirm it', async () => {
    const rig = punishRig({ config: RECENT });
    seedRecentWarn(rig);
    await rig.command(warnAdd());
    const { go } = promptIds(rig);

    await rig.interact(pressEvent(go, { userId: MEMBER }));

    const refusal = lastCallback(rig.h);
    expect(refusal.data.flags).toBe(MESSAGE_FLAG_EPHEMERAL);
    expect(textOf(refusal.data)).toContain(NOT_YOURS);
    expect(warnCases(rig)).toHaveLength(0);

    await rig.interact(pressEvent(go, { permissions: MOD_PERMISSIONS }));
    expect(warnCases(rig)).toHaveLength(1);
  });

  test('a press on an expired prompt says so', async () => {
    const rig = punishRig({ config: RECENT });
    seedRecentWarn(rig);
    await rig.command(warnAdd());
    const { go } = promptIds(rig);

    rig.h.advance(16 * 60_000);
    await rig.interact(pressEvent(go, { permissions: MOD_PERMISSIONS }));

    expect(lastCallback(rig.h).type).toBe(INTERACTION_CALLBACK_UPDATE_MESSAGE);
    expect(textOf(lastCallback(rig.h).data)).toContain(EXPIRED);
    expect(warnCases(rig)).toHaveLength(0);
  });

  test('with public replies it first says who must confirm, then asks privately', async () => {
    const rig = punishRig({ config: { ...RECENT, publicReplies: true } });
    seedRecentWarn(rig);

    await rig.command(warnAdd());

    const [waiting, prompt] = rig.h.followUps();
    expect(waiting?.flags).toBeUndefined();
    expect(waiting?.content).toBe(`Waiting for <@${MODERATOR}> to confirm…`);
    expect(prompt?.flags).toBe(MESSAGE_FLAG_EPHEMERAL);
    expect(customIds(prompt)).toHaveLength(2);

    const followUpKeys = rig.h.requests
      .filter((request) => request.kind === 'interaction_followup')
      .map((request) => request.idempotencyKey);
    expect(new Set(followUpKeys).size).toBe(2);

    const { go } = promptIds(rig);
    await rig.interact(pressEvent(go, { permissions: MOD_PERMISSIONS }));
    expect(lastFollowUp(rig.h).flags).toBeUndefined();
    expect(rig.h.statusOf(lastFollowUp(rig.h))).toBe('success');
  });

  test('a disabled module refuses the press', async () => {
    const rig = punishRig({ config: RECENT });
    seedRecentWarn(rig);
    await rig.command(warnAdd());
    const { go } = promptIds(rig);

    await rig.interact(pressEvent(go, { permissions: MOD_PERMISSIONS }), {
      configInput: { ...RECENT, enabled: false },
    });

    expect(textOf(lastCallback(rig.h).data)).toContain(MODERATION_OFF);
    expect(warnCases(rig)).toHaveLength(0);
  });

  test('a Continue whose first answer fails leaves the prompt for another press', async () => {
    const rig = punishRig({ config: RECENT });
    seedRecentWarn(rig);
    await rig.command(warnAdd());
    const { go } = promptIds(rig);
    rig.h.rest.respond(/^POST \/interactions\//, discordError(404, 10062, 'Unknown interaction'), {
      times: 1,
    });

    await rig.interact(pressEvent(go, { permissions: MOD_PERMISSIONS }));
    expect(warnCases(rig)).toHaveLength(0);

    await rig.interact(pressEvent(go, { permissions: MOD_PERMISSIONS }));
    expect(warnCases(rig)).toHaveLength(1);
    expect(rig.h.statusOf(lastFollowUp(rig.h))).toBe('success');
  });

  test('Continue asks the permissions module again, for the moderator pressing it', async () => {
    const rig = punishRig({ config: RECENT });
    seedRecentWarn(rig);
    await rig.command(warnAdd());
    const { go } = promptIds(rig);
    rig.denied.set('warn', 'You can’t use /warn in this server.');

    await rig.interact(pressEvent(go, { permissions: MOD_PERMISSIONS }));

    expect(rig.h.statusOf(lastFollowUp(rig.h))).toBe('error');
    expect(textOf(lastFollowUp(rig.h))).toContain('You can’t use /warn in this server.');
    expect(warnCases(rig)).toHaveLength(0);
  });

  test('Continue is refused once the moderator has lost the permission they ran it with', async () => {
    const rig = punishRig({ config: RECENT });
    seedRecentWarn(rig);
    await rig.command(warnAdd());
    const { go } = promptIds(rig);

    await rig.interact(pressEvent(go, { permissions: 0n }));

    expect(rig.h.statusOf(lastFollowUp(rig.h))).toBe('error');
    expect(textOf(lastFollowUp(rig.h))).toContain(
      'You need the Timeout Members permission in this server to warn members',
    );
    expect(warnCases(rig)).toHaveLength(0);
  });

  test('a moderator who never had the permission, only the command, can still confirm', async () => {
    const rig = punishRig({ config: RECENT });
    seedRecentWarn(rig);
    await rig.command(warnAdd([], { permissions: 0n }));
    const { go } = promptIds(rig);

    await rig.interact(pressEvent(go, { permissions: 0n }));

    expect(rig.h.statusOf(lastFollowUp(rig.h))).toBe('success');
    expect(warnCases(rig)).toHaveLength(1);
  });

  test('the owner is never refused for a permission they lost', async () => {
    const rig = punishRig({ config: RECENT });
    seedRecentWarn(rig);
    await rig.command(warnAdd([], { userId: OWNER }));
    const { go } = promptIds(rig);

    await rig.interact(pressEvent(go, { userId: OWNER, permissions: 0n }));

    expect(rig.h.statusOf(lastFollowUp(rig.h))).toBe('success');
    expect(warnCases(rig)).toHaveLength(1);
  });
});

describe('/ban add durations', () => {
  function banAdd(options: RawOption[] = []) {
    return slashEvent('ban', subcommand('add', [userOption('user', MEMBER), ...options]), {
      permissions: MOD_PERMISSIONS,
    });
  }

  const SEVEN_DAYS = { punish: { types: { ban: { defaultDuration: '7d' } } } };

  test.each(['permanent', 'Perm', ' FOREVER '])(
    "'%s' bans for good even when the server has a default length",
    async (typed) => {
      const rig = punishRig({ config: SEVEN_DAYS });

      await rig.command(banAdd([stringOption('duration', typed)]));

      const bans = rig.h.cases().filter((entry) => entry.kind === 'ban');
      expect(bans).toHaveLength(1);
      expect(bans[0]?.expiresAt).toBeUndefined();
      expect(rig.h.scheduled).toHaveLength(0);
      expect(textOf(lastFollowUp(rig.h))).not.toContain('lifts automatically');
    },
  );

  test('no duration uses the server default', async () => {
    const rig = punishRig({ config: SEVEN_DAYS });

    await rig.command(banAdd());

    expect(rig.h.scheduled).toHaveLength(1);
    expect(textOf(lastFollowUp(rig.h))).toContain('for 1w. The ban lifts automatically');
  });

  test('a temporary ban longer than a year is refused', async () => {
    const rig = punishRig();

    await rig.command(banAdd([stringOption('duration', '400d')]));

    expect(rig.h.statusOf(lastFollowUp(rig.h))).toBe('error');
    expect(textOf(lastFollowUp(rig.h))).toContain('at most 365 days');
    expect(rig.h.cases()).toHaveLength(0);
  });

  test('the option says how to ban for good', () => {
    type Option = { name: string; description: string; options?: Option[] };
    const [add] = (banCommand({}).data as { options?: Option[] }).options ?? [];
    const duration = (add?.options ?? []).find((option) => option.name === 'duration');

    expect(duration?.description).toBe(
      'Ban length, like 12h or 7d. Leave empty for the server default, or type permanent to ban ' +
        'for good.',
    );
  });

  test('the review form takes permanent as well', async () => {
    const config = { punish: { types: { ban: { alwaysReview: true, defaultDuration: '7d' } } } };
    const rig = punishRig({ config });
    await rig.command(banAdd());

    await rig.interact(
      modalEvent(
        lastModal(rig.h).custom_id ?? '',
        { text: { reason: 'Raid', duration: 'permanent' } },
        { permissions: MOD_PERMISSIONS },
      ),
    );

    expect(rig.h.cases().filter((entry) => entry.kind === 'ban')).toHaveLength(1);
    expect(rig.h.scheduled).toHaveLength(0);
  });
});

describe('always review', () => {
  const REVIEW = { punish: { types: { timeout: { alwaysReview: true } } } };

  test('opens the review modal as the first response, and submitting carries it out', async () => {
    const rig = punishRig({ config: REVIEW });

    await rig.command(
      slashEvent(
        'timeout',
        subcommand('add', [userOption('user', MEMBER), stringOption('reason', 'sp')]),
        { permissions: MOD_PERMISSIONS },
      ),
      { configInput: { ...REVIEW, punish: { ...REVIEW.punish, reasons: REASONS } } },
    );

    expect(rig.h.callbackTypes()).toEqual([INTERACTION_CALLBACK_MODAL]);
    const modal = lastModal(rig.h);
    const fields = modalFields(modal);
    expect(fields.map((field) => field.type)).toEqual([
      ComponentType.TextDisplay,
      ComponentType.Label,
      ComponentType.Label,
    ]);
    expect(fields[1]?.value).toBe('Spamming the channels');
    expect(fields[2]?.value).toBe('1h');
    expect(rig.h.cases()).toHaveLength(0);

    await rig.interact(
      modalEvent(
        modal.custom_id ?? '',
        { text: { reason: 'Flooding #general', duration: '2h' } },
        { permissions: MOD_PERMISSIONS },
      ),
    );

    expect(rig.h.callbackTypes().at(-1)).toBe(INTERACTION_CALLBACK_DEFERRED_MESSAGE);
    const timeouts = rig.h.cases().filter((entry) => entry.kind === 'timeout');
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]?.reason).toBe('Flooding #general');
    expect(textOf(lastFollowUp(rig.h))).toContain('for 2h');
  });

  test('a recent case is shown inside the modal, and submitting confirms it', async () => {
    const config = { punish: { ...REVIEW.punish, confirmRecentCase: { enabled: true } } };
    const rig = punishRig({ config });
    rig.ledger.seed({
      caseId: 'Kearly1',
      guildId: GUILD,
      kind: 'timeout',
      targetId: MEMBER,
      createdAt: NOW - 30_000,
    });

    await rig.command(
      slashEvent('timeout', subcommand('add', [userOption('user', MEMBER)]), {
        permissions: MOD_PERMISSIONS,
      }),
    );

    const modal = lastModal(rig.h);
    expect(modalFields(modal)[0]?.content).toContain('Kearly1');

    await rig.interact(
      modalEvent(
        modal.custom_id ?? '',
        { text: { reason: '', duration: '' } },
        { permissions: MOD_PERMISSIONS },
      ),
    );

    expect(rig.h.cases().filter((entry) => entry.kind === 'timeout')).toHaveLength(1);
    expect(customIds(lastFollowUp(rig.h))).toEqual([]);
  });

  test('an immune member is refused before any modal opens', async () => {
    const rig = punishRig({
      config: { punish: { ...REVIEW.punish, immunity: { timeout: [LOW_ROLE] } } },
    });

    await rig.command(
      slashEvent('timeout', subcommand('add', [userOption('user', MEMBER)]), {
        permissions: MOD_PERMISSIONS,
      }),
    );

    expect(rig.h.modalsOpened()).toHaveLength(0);
    expect(rig.h.statusOf(rig.h.replies()[0])).toBe('error');
    expect(textOf(rig.h.replies()[0])).toContain(`<@&${LOW_ROLE}>`);
  });

  test('a second submission of the same review answers with the first outcome', async () => {
    const rig = punishRig({ config: REVIEW });
    await rig.command(
      slashEvent('timeout', subcommand('add', [userOption('user', MEMBER)]), {
        permissions: MOD_PERMISSIONS,
      }),
    );
    const customId = lastModal(rig.h).custom_id ?? '';

    const permissions = { permissions: MOD_PERMISSIONS };
    await rig.interact(modalEvent(customId, { text: { reason: 'one' } }, permissions));
    await rig.interact(modalEvent(customId, { text: { reason: 'two' } }, permissions));

    const timeouts = rig.h.cases().filter((entry) => entry.kind === 'timeout');
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]?.reason).toBe('one');
    expect(rig.h.statusOf(lastFollowUp(rig.h))).toBe('success');
  });

  test('a submission whose defer fails leaves the review for the moderator to submit again', async () => {
    const rig = punishRig({ config: REVIEW });
    await rig.command(
      slashEvent('timeout', subcommand('add', [userOption('user', MEMBER)]), {
        permissions: MOD_PERMISSIONS,
      }),
    );
    const customId = lastModal(rig.h).custom_id ?? '';
    rig.h.rest.respond(/^POST \/interactions\//, discordError(404, 10062, 'Unknown interaction'), {
      times: 1,
    });

    const permissions = { permissions: MOD_PERMISSIONS };
    await rig.interact(modalEvent(customId, { text: { reason: 'one' } }, permissions));
    expect(rig.h.cases()).toHaveLength(0);

    await rig.interact(modalEvent(customId, { text: { reason: 'one' } }, permissions));
    expect(rig.h.cases().filter((entry) => entry.kind === 'timeout')).toHaveLength(1);
  });
});

describe('reason autocomplete', () => {
  test('suggests predefined reasons matching the typed alias or text', async () => {
    const rig = punishRig({ config: { punish: { reasons: REASONS } } });

    await rig.autocomplete(
      autocompleteEvent('ban', { name: 'reason', value: 'rai' }, { subcommand: 'add' }),
    );

    const answer = lastCallback(rig.h);
    expect(answer.type).toBe(INTERACTION_CALLBACK_AUTOCOMPLETE_RESULT);
    expect((answer.data as { choices?: unknown }).choices).toEqual([
      { name: 'Taking part in a raid', value: 'Taking part in a raid' },
    ]);
  });

  test('kick has no subcommand and still gets suggestions', async () => {
    const rig = punishRig({ config: { punish: { reasons: REASONS } } });

    await rig.autocomplete(autocompleteEvent('kick', { name: 'reason', value: '' }));

    expect((lastCallback(rig.h).data as { choices?: unknown[] }).choices).toHaveLength(2);
  });

  test('answers with no choices when moderation is off, rather than leaving a spinner', async () => {
    const rig = punishRig({ config: { enabled: false, punish: { reasons: REASONS } } });

    await rig.autocomplete(
      autocompleteEvent('warn', { name: 'reason', value: '' }, { subcommand: 'add' }),
    );

    expect((lastCallback(rig.h).data as { choices?: unknown[] }).choices).toEqual([]);
  });

  test('leaves other options and the lifting subcommands alone', async () => {
    const rig = punishRig({ config: { punish: { reasons: REASONS } } });

    await rig.autocomplete(
      autocompleteEvent('ban', { name: 'reason', value: '' }, { subcommand: 'remove' }),
    );
    await rig.autocomplete(
      autocompleteEvent('ban', { name: 'duration', value: '' }, { subcommand: 'add' }),
    );
    await rig.autocomplete(
      autocompleteEvent('tag', { name: 'reason', value: '', type: OptionType.String }),
    );

    expect(callbacks(rig.h)).toHaveLength(0);
  });
});
