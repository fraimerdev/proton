import { describe, expect, test } from 'bun:test';
import { type ActionKind, requiredPermissionsFor } from '../../src/actions/kinds.ts';
import {
  INTERACTION_CALLBACK_AUTOCOMPLETE_RESULT,
  INTERACTION_CALLBACK_MODAL,
  INTERACTION_TYPE_MODAL_SUBMIT,
  MAX_COMPONENTS_PER_MESSAGE,
  MAX_COMPONENTS_PER_MODAL,
  MESSAGE_FLAG_IS_COMPONENTS_V2,
  THREAD_TYPE_PRIVATE,
  THREAD_TYPE_PUBLIC,
} from '../../src/actions/payloads.ts';
import { type PayloadResult, type RestCall, toRestCall } from '../../src/actions/rest-mapping.ts';
import type { ActionRequest } from '../../src/actions/types.ts';
import { has, Permissions } from '../../src/permissions/bits.ts';

const GUILD = '900000000000000001';
const USER = '100000000000000001';
const CHANNEL = '500000000000000001';
const VOICE = '500000000000000002';
const MESSAGE = '700000000000000001';

function request(kind: ActionKind, payload: unknown, reason?: string): ActionRequest {
  return {
    guildId: GUILD,
    moduleId: 'moderation',
    kind,
    actorId: USER,
    dryRun: false,
    idempotencyKey: 'k',
    payload,
    ...(reason ? { reason } : {}),
  };
}

function callOf(result: PayloadResult): RestCall {
  if ('error' in result) throw new Error(result.error);
  if ('ledgerOnly' in result) throw new Error('expected a REST call, got a ledger-only kind');
  return result.call;
}

function errorOf(result: PayloadResult): string {
  if (!('error' in result)) throw new Error('expected the payload to be refused');
  return result.error;
}

describe('delete_channel', () => {
  test('maps to a bare DELETE on the channel', () => {
    const call = callOf(toRestCall(request('delete_channel', { channelId: CHANNEL })));

    expect(call.method).toBe('DELETE');
    expect(call.path).toBe(`/channels/${CHANNEL}`);
    expect(call.body).toBeUndefined();
  });

  test('carries the reason into the audit log', () => {
    const call = callOf(
      toRestCall(request('delete_channel', { channelId: CHANNEL }, 'ticket closed')),
    );

    expect(call.headers?.['x-audit-log-reason']).toBe('ticket%20closed');
  });

  test('needs Manage Channels', () => {
    expect(requiredPermissionsFor('delete_channel')).toBe(Permissions.ManageChannels);
  });

  test('refuses a channel id that is not a snowflake', () => {
    expect(errorOf(toRestCall(request('delete_channel', { channelId: 'general' })))).toContain(
      'snowflake',
    );
  });
});

describe('edit_channel', () => {
  test('sends only the fields the caller set, in Discord’s casing', () => {
    const call = callOf(
      toRestCall(
        request('edit_channel', {
          channelId: VOICE,
          name: 'Squad — 3',
          userLimit: 3,
          bitrate: 64_000,
          rateLimitPerUser: 5,
        }),
      ),
    );

    expect(call.method).toBe('PATCH');
    expect(call.path).toBe(`/channels/${VOICE}`);
    expect(call.body).toEqual({
      name: 'Squad — 3',
      user_limit: 3,
      bitrate: 64_000,
      rate_limit_per_user: 5,
    });
  });

  test('passes permission overwrites through untouched', () => {
    const overwrites = [{ id: GUILD, type: 0, allow: '0', deny: '1024' }];
    const call = callOf(
      toRestCall(request('edit_channel', { channelId: CHANNEL, permissionOverwrites: overwrites })),
    );

    expect((call.body as { permission_overwrites: unknown }).permission_overwrites).toEqual(
      overwrites,
    );
  });

  test('refuses a bitrate below Discord’s floor', () => {
    expect(
      errorOf(toRestCall(request('edit_channel', { channelId: VOICE, bitrate: 7999 }))),
    ).toContain('bitrate');
  });

  test('refuses a bitrate above the boost-level-3 ceiling', () => {
    expect(
      errorOf(toRestCall(request('edit_channel', { channelId: VOICE, bitrate: 500_000 }))),
    ).toContain('bitrate');
  });

  test('refuses a user limit above the stage-channel ceiling', () => {
    expect(
      errorOf(toRestCall(request('edit_channel', { channelId: VOICE, userLimit: 10_001 }))),
    ).toContain('userLimit');
  });

  test('refuses slowmode beyond six hours', () => {
    expect(
      errorOf(
        toRestCall(request('edit_channel', { channelId: CHANNEL, rateLimitPerUser: 21_601 })),
      ),
    ).toContain('rateLimitPerUser');
  });

  test('refuses an overwrite whose type is neither role nor member', () => {
    expect(
      errorOf(
        toRestCall(
          request('edit_channel', {
            channelId: CHANNEL,
            permissionOverwrites: [{ id: GUILD, type: 2 }],
          }),
        ),
      ),
    ).toContain('permissionOverwrites.0.type');
  });

  test('needs Manage Channels', () => {
    expect(requiredPermissionsFor('edit_channel')).toBe(Permissions.ManageChannels);
  });

  test('needs Manage Roles on top once it carries overwrites, which is what Discord checks', () => {
    expect(
      requiredPermissionsFor('edit_channel', {
        channelId: CHANNEL,
        permissionOverwrites: [{ id: GUILD, type: 0, deny: '1024' }],
      }),
    ).toBe(Permissions.ManageChannels | Permissions.ManageRoles);
  });
});

describe('create_thread', () => {
  test('maps to the threads collection with the thread type', () => {
    const call = callOf(
      toRestCall(
        request('create_thread', {
          channelId: CHANNEL,
          name: 'ticket-0007',
          type: THREAD_TYPE_PRIVATE,
          autoArchiveDuration: 1440,
          invitable: false,
        }),
      ),
    );

    expect(call.method).toBe('POST');
    expect(call.path).toBe(`/channels/${CHANNEL}/threads`);
    expect(call.body).toEqual({
      name: 'ticket-0007',
      type: THREAD_TYPE_PRIVATE,
      auto_archive_duration: 1440,
      invitable: false,
    });
  });

  test('accepts a public thread with no archive duration', () => {
    const call = callOf(
      toRestCall(
        request('create_thread', {
          channelId: CHANNEL,
          name: 'spoilers',
          type: THREAD_TYPE_PUBLIC,
        }),
      ),
    );

    expect(call.body).toEqual({ name: 'spoilers', type: THREAD_TYPE_PUBLIC });
  });

  test('refuses a channel type that is not a thread type', () => {
    expect(
      errorOf(toRestCall(request('create_thread', { channelId: CHANNEL, name: 'x', type: 0 }))),
    ).toContain('type');
  });

  test('refuses an archive duration Discord does not offer', () => {
    expect(
      errorOf(
        toRestCall(
          request('create_thread', {
            channelId: CHANNEL,
            name: 'x',
            type: THREAD_TYPE_PUBLIC,
            autoArchiveDuration: 120,
          }),
        ),
      ),
    ).toContain('autoArchiveDuration');
  });

  test('refuses a nameless thread', () => {
    expect(
      errorOf(
        toRestCall(request('create_thread', { channelId: CHANNEL, type: THREAD_TYPE_PUBLIC })),
      ),
    ).toContain('name');
  });

  test('is gated on the thread bit the payload actually asks for', () => {
    const base = { channelId: CHANNEL, name: 'x' };

    expect(requiredPermissionsFor('create_thread', { ...base, type: THREAD_TYPE_PUBLIC })).toBe(
      Permissions.ViewChannel | Permissions.CreatePublicThreads,
    );
    expect(requiredPermissionsFor('create_thread', { ...base, type: THREAD_TYPE_PRIVATE })).toBe(
      Permissions.ViewChannel | Permissions.CreatePrivateThreads,
    );
  });
});

describe('move_member', () => {
  test('maps to a member patch carrying the destination channel', () => {
    const call = callOf(toRestCall(request('move_member', { userId: USER, channelId: VOICE })));

    expect(call.method).toBe('PATCH');
    expect(call.path).toBe(`/guilds/${GUILD}/members/${USER}`);
    expect(call.body).toEqual({ channel_id: VOICE });
  });

  test('refuses a move with no destination', () => {
    expect(errorOf(toRestCall(request('move_member', { userId: USER })))).toContain('channelId');
  });

  test('needs Move Members, and Connect in the channel it moves them into', () => {
    const required = requiredPermissionsFor('move_member');

    expect(has(required, Permissions.MoveMembers)).toBe(true);
    expect(has(required, Permissions.Connect)).toBe(true);
  });
});

describe('end_poll', () => {
  test('maps to the expire endpoint with no body', () => {
    const call = callOf(
      toRestCall(request('end_poll', { channelId: CHANNEL, messageId: MESSAGE })),
    );

    expect(call.method).toBe('POST');
    expect(call.path).toBe(`/channels/${CHANNEL}/polls/${MESSAGE}/expire`);
    expect(call.body).toBeUndefined();
  });

  test('refuses a poll message id that is not a snowflake', () => {
    expect(
      errorOf(toRestCall(request('end_poll', { channelId: CHANNEL, messageId: 'latest' }))),
    ).toContain('messageId');
  });

  test('needs only View Channel', () => {
    expect(requiredPermissionsFor('end_poll')).toBe(Permissions.ViewChannel);
  });
});

describe('pin_message', () => {
  test('maps to the pins collection route, not the old channel-level one', () => {
    const call = callOf(
      toRestCall(request('pin_message', { channelId: CHANNEL, messageId: MESSAGE })),
    );

    expect(call.method).toBe('PUT');
    expect(call.path).toBe(`/channels/${CHANNEL}/messages/pins/${MESSAGE}`);
  });

  test('needs the Pin Messages bit split out of Manage Messages', () => {
    expect(requiredPermissionsFor('pin_message')).toBe(Permissions.PinMessages);
    expect(requiredPermissionsFor('pin_message')).toBe(1n << 51n);
  });

  test('refuses a pin with no message', () => {
    expect(errorOf(toRestCall(request('pin_message', { channelId: CHANNEL })))).toContain(
      'messageId',
    );
  });
});

const POLL = {
  question: { text: 'Which map?' },
  answers: [{ poll_media: { text: 'Dust' } }, { poll_media: { text: 'Nuke' } }],
  duration: 24,
  allow_multiselect: false,
};

describe('sending a poll', () => {
  test('a poll alone is enough of a message to send', () => {
    const call = callOf(toRestCall(request('send', { channelId: CHANNEL, poll: POLL })));

    expect((call.body as { poll: unknown }).poll).toEqual(POLL);
  });

  test('a send with neither content nor poll is still refused', () => {
    expect(errorOf(toRestCall(request('send', { channelId: CHANNEL })))).toContain('or a poll');
  });

  test('refuses a question longer than Discord allows', () => {
    const result = toRestCall(
      request('send', {
        channelId: CHANNEL,
        poll: { ...POLL, question: { text: 'q'.repeat(301) } },
      }),
    );

    expect(errorOf(result)).toContain('300 characters');
  });

  test('refuses more than ten answers', () => {
    const answers = Array.from({ length: 11 }, (_, i) => ({ poll_media: { text: `a${i}` } }));
    const result = toRestCall(request('send', { channelId: CHANNEL, poll: { ...POLL, answers } }));

    expect(errorOf(result)).toContain('10 answers');
  });

  test('refuses an answer longer than Discord allows', () => {
    const result = toRestCall(
      request('send', {
        channelId: CHANNEL,
        poll: { ...POLL, answers: [{ poll_media: { text: 'a'.repeat(56) } }] },
      }),
    );

    expect(errorOf(result)).toContain('55 characters');
  });

  test('refuses a poll running longer than 32 days', () => {
    const result = toRestCall(
      request('send', { channelId: CHANNEL, poll: { ...POLL, duration: 769 } }),
    );

    expect(errorOf(result)).toContain('768 hours');
  });

  test('accepts a poll sitting exactly on every one of those limits', () => {
    const call = callOf(
      toRestCall(
        request('send', {
          channelId: CHANNEL,
          poll: {
            question: { text: 'q'.repeat(300) },
            answers: Array.from({ length: 10 }, () => ({ poll_media: { text: 'a'.repeat(55) } })),
            duration: 768,
          },
        }),
      ),
    );

    expect((call.body as { poll: { answers: unknown[] } }).poll.answers).toHaveLength(10);
  });

  test('leaves the rest of the poll object alone, since it is Discord’s shape', () => {
    const call = callOf(
      toRestCall(
        request('send', {
          channelId: CHANNEL,
          poll: { ...POLL, layout_type: 1, question: { text: 'Which map?', emoji: { id: null } } },
        }),
      ),
    );

    expect((call.body as { poll: { layout_type: number } }).poll.layout_type).toBe(1);
  });

  test('needs Send Polls as well as Send Messages, which a plain send does not', () => {
    expect(requiredPermissionsFor('send', { channelId: CHANNEL, poll: POLL })).toBe(
      Permissions.ViewChannel | Permissions.SendMessages | Permissions.SendPolls,
    );
    expect(requiredPermissionsFor('send', { channelId: CHANNEL, content: 'hi' })).toBe(
      Permissions.ViewChannel | Permissions.SendMessages,
    );
  });
});

describe('a poll whose every field is the wrong type', () => {
  test('is refused whole rather than slipping through field by field', () => {
    const error = errorOf(
      toRestCall(
        request('send', {
          channelId: CHANNEL,
          poll: { question: { text: 123 }, answers: 'yes', duration: '48' },
        }),
      ),
    );

    expect(error).toContain('poll.question.text');
    expect(error).toContain('poll.answers');
    expect(error).toContain('poll.duration');
  });

  test('refuses a question that is a bare string instead of a poll media object', () => {
    expect(
      errorOf(
        toRestCall(
          request('send', { channelId: CHANNEL, poll: { ...POLL, question: 'Which map?' } }),
        ),
      ),
    ).toContain('poll.question');
  });

  test('refuses an answer that is not wrapped in poll_media', () => {
    expect(
      errorOf(
        toRestCall(
          request('send', { channelId: CHANNEL, poll: { ...POLL, answers: [{ text: 'Dust' }] } }),
        ),
      ),
    ).toContain('poll.answers.0.poll_media');
  });

  test('refuses a poll with a question but no answers at all', () => {
    expect(
      errorOf(
        toRestCall(request('send', { channelId: CHANNEL, poll: { question: POLL.question } })),
      ),
    ).toContain('poll.answers');
  });

  test('refuses an empty answer list, which Discord has nothing to render', () => {
    expect(
      errorOf(toRestCall(request('send', { channelId: CHANNEL, poll: { ...POLL, answers: [] } }))),
    ).toContain('poll.answers');
  });

  test('refuses a fractional duration', () => {
    expect(
      errorOf(
        toRestCall(request('send', { channelId: CHANNEL, poll: { ...POLL, duration: 1.5 } })),
      ),
    ).toContain('poll.duration');
  });

  test('refuses a zero-hour duration, which would expire the poll on arrival', () => {
    expect(
      errorOf(toRestCall(request('send', { channelId: CHANNEL, poll: { ...POLL, duration: 0 } }))),
    ).toContain('poll.duration');
  });

  test('refuses allow_multiselect given as a string', () => {
    expect(
      errorOf(
        toRestCall(
          request('send', { channelId: CHANNEL, poll: { ...POLL, allow_multiselect: 'true' } }),
        ),
      ),
    ).toContain('poll.allow_multiselect');
  });
});

describe('message flags', () => {
  test('IS_COMPONENTS_V2 is bit 15', () => {
    expect(MESSAGE_FLAG_IS_COMPONENTS_V2).toBe(1 << 15);
  });

  test('a caller-supplied flag reaches the send body', () => {
    const call = callOf(
      toRestCall(
        request('send', {
          channelId: CHANNEL,
          components: [{ type: 10, content: 'hi' }],
          flags: MESSAGE_FLAG_IS_COMPONENTS_V2,
        }),
      ),
    );

    expect((call.body as { flags: number }).flags).toBe(MESSAGE_FLAG_IS_COMPONENTS_V2);
  });

  test('a send without flags carries none', () => {
    const call = callOf(toRestCall(request('send', { channelId: CHANNEL, content: 'hi' })));

    expect(call.body).not.toHaveProperty('flags');
  });
});

function reply(payload: Record<string, unknown>): PayloadResult {
  return toRestCall(
    request('interaction_reply', { interactionId: USER, interactionToken: 'tok', ...payload }),
  );
}

function rows(count: number): unknown[] {
  return Array.from({ length: count }, (_, i) => ({
    type: 1,
    components: [{ type: 4, custom_id: `field${i}` }],
  }));
}

describe('opening a modal', () => {
  test('callback type 9 is the modal response', () => {
    expect(INTERACTION_CALLBACK_MODAL).toBe(9);
  });

  test('a modal response carries the modal instead of a message', () => {
    const call = callOf(
      reply({
        callbackType: INTERACTION_CALLBACK_MODAL,
        modal: {
          customId: 'appeal:0007',
          title: 'Appeal your ban',
          components: [{ type: 1, components: [{ type: 4, custom_id: 'why' }] }],
        },
      }),
    );

    expect(call.body).toEqual({
      type: INTERACTION_CALLBACK_MODAL,
      data: {
        custom_id: 'appeal:0007',
        title: 'Appeal your ban',
        components: [{ type: 1, components: [{ type: 4, custom_id: 'why' }] }],
      },
    });
  });

  test('refuses a modal response with no modal on it', () => {
    expect(errorOf(reply({ callbackType: INTERACTION_CALLBACK_MODAL }))).toContain(
      'carries no modal',
    );
  });

  test('refuses a custom id longer than Discord stores', () => {
    const result = reply({
      callbackType: INTERACTION_CALLBACK_MODAL,
      modal: { customId: 'c'.repeat(101), title: 'Appeal', components: [{ type: 1 }] },
    });

    expect(errorOf(result)).toContain('customId');
  });

  test('accepts a custom id of exactly the 100 characters Discord stores', () => {
    const call = callOf(
      reply({
        callbackType: INTERACTION_CALLBACK_MODAL,
        modal: { customId: 'c'.repeat(100), title: 'Appeal', components: [{ type: 1 }] },
      }),
    );

    expect((call.body as { data: { custom_id: string } }).data.custom_id).toHaveLength(100);
  });

  test('refuses a title longer than 45 characters', () => {
    const result = reply({
      callbackType: INTERACTION_CALLBACK_MODAL,
      modal: { customId: 'appeal', title: 't'.repeat(46), components: [{ type: 1 }] },
    });

    expect(errorOf(result)).toContain('title');
  });

  test('refuses a modal with no inputs in it', () => {
    const result = reply({
      callbackType: INTERACTION_CALLBACK_MODAL,
      modal: { customId: 'appeal', title: 'Appeal', components: [] },
    });

    expect(errorOf(result)).toContain('components');
  });

  test('accepts the five rows Discord renders', () => {
    const components = rows(MAX_COMPONENTS_PER_MODAL);
    const call = callOf(
      reply({
        callbackType: INTERACTION_CALLBACK_MODAL,
        modal: { customId: 'appeal', title: 'Appeal', components },
      }),
    );

    expect((call.body as { data: { components: unknown[] } }).data.components).toHaveLength(5);
  });

  test('refuses a sixth, rather than letting the message-level cap of 40 stand in', () => {
    const result = reply({
      callbackType: INTERACTION_CALLBACK_MODAL,
      modal: {
        customId: 'appeal',
        title: 'Appeal',
        components: rows(MAX_COMPONENTS_PER_MODAL + 1),
      },
    });

    expect(errorOf(result)).toContain('at most 5 components');
  });

  test('is capped well below the 40 a Components-V2 message may carry', () => {
    expect(MAX_COMPONENTS_PER_MODAL).toBe(5);
    expect(MAX_COMPONENTS_PER_MESSAGE).toBe(40);

    const result = reply({
      callbackType: INTERACTION_CALLBACK_MODAL,
      modal: { customId: 'appeal', title: 'Appeal', components: rows(MAX_COMPONENTS_PER_MESSAGE) },
    });

    expect(errorOf(result)).toContain('components');
  });

  test('refuses to answer a modal submission with another modal, and says why', () => {
    const result = reply({
      callbackType: INTERACTION_CALLBACK_MODAL,
      sourceInteractionType: INTERACTION_TYPE_MODAL_SUBMIT,
      modal: { customId: 'appeal', title: 'Appeal', components: [{ type: 1 }] },
    });

    expect(errorOf(result)).toContain('will not open a modal in response to a modal submission');
  });

  test('still opens a modal for a component interaction', () => {
    const call = callOf(
      reply({
        callbackType: INTERACTION_CALLBACK_MODAL,
        sourceInteractionType: 3,
        modal: { customId: 'appeal', title: 'Appeal', components: [{ type: 1 }] },
      }),
    );

    expect((call.body as { type: number }).type).toBe(INTERACTION_CALLBACK_MODAL);
  });
});

describe('answering an autocomplete', () => {
  test('callback type 8 is the autocomplete result', () => {
    expect(INTERACTION_CALLBACK_AUTOCOMPLETE_RESULT).toBe(8);
  });

  test('an autocomplete response carries choices instead of a message', () => {
    const call = callOf(
      reply({
        callbackType: INTERACTION_CALLBACK_AUTOCOMPLETE_RESULT,
        choices: [{ name: 'Warn', value: 'warn' }],
      }),
    );

    expect(call.body).toEqual({
      type: INTERACTION_CALLBACK_AUTOCOMPLETE_RESULT,
      data: { choices: [{ name: 'Warn', value: 'warn' }] },
    });
  });

  test('an empty choice list is a valid answer — it means no matches', () => {
    const call = callOf(
      reply({ callbackType: INTERACTION_CALLBACK_AUTOCOMPLETE_RESULT, choices: [] }),
    );

    expect(call.body).toEqual({
      type: INTERACTION_CALLBACK_AUTOCOMPLETE_RESULT,
      data: { choices: [] },
    });
  });

  test('refuses an autocomplete response with no choices field at all', () => {
    expect(errorOf(reply({ callbackType: INTERACTION_CALLBACK_AUTOCOMPLETE_RESULT }))).toContain(
      'carries no choices',
    );
  });

  test('refuses more than the 25 choices Discord renders', () => {
    const choices = Array.from({ length: 26 }, (_, i) => ({ name: `n${i}`, value: `v${i}` }));

    expect(
      errorOf(reply({ callbackType: INTERACTION_CALLBACK_AUTOCOMPLETE_RESULT, choices })),
    ).toContain('choices');
  });

  test('accepts exactly 25 of them', () => {
    const choices = Array.from({ length: 25 }, (_, i) => ({ name: `n${i}`, value: `v${i}` }));
    const call = callOf(reply({ callbackType: INTERACTION_CALLBACK_AUTOCOMPLETE_RESULT, choices }));

    expect((call.body as { data: { choices: unknown[] } }).data.choices).toHaveLength(25);
  });

  test('accepts a numeric choice value', () => {
    const call = callOf(
      reply({
        callbackType: INTERACTION_CALLBACK_AUTOCOMPLETE_RESULT,
        choices: [{ name: '7 days', value: 7 }],
      }),
    );

    expect(call.body).toEqual({
      type: INTERACTION_CALLBACK_AUTOCOMPLETE_RESULT,
      data: { choices: [{ name: '7 days', value: 7 }] },
    });
  });
});
