import { describe, expect, test } from 'bun:test';
import { InteractionType } from 'discord-api-types/v10';
import {
  INTERACTION_CALLBACK_AUTOCOMPLETE_RESULT,
  INTERACTION_CALLBACK_CHANNEL_MESSAGE,
  INTERACTION_CALLBACK_DEFERRED_MESSAGE,
  INTERACTION_CALLBACK_DEFERRED_UPDATE,
  INTERACTION_CALLBACK_MODAL,
  INTERACTION_CALLBACK_UPDATE_MESSAGE,
  INTERACTION_TYPE_MODAL_SUBMIT,
  type InteractionReplyPayload,
  interactionEditOriginalPayloadSchema,
  interactionFollowupPayloadSchema,
  interactionReplyPayloadSchema,
  MAX_AUTOCOMPLETE_CHOICES,
  MESSAGE_FLAG_EPHEMERAL,
  MESSAGE_FLAG_IS_COMPONENTS_V2,
  modalSchema,
} from '../../src/actions/payloads.ts';
import { type PayloadResult, type RestCall, toRestCall } from '../../src/actions/rest-mapping.ts';
import type { ActionRequest } from '../../src/actions/types.ts';
import type { ProtonEvent } from '../../src/events/types.ts';
import { readModalInteraction } from '../../src/interactions/read.ts';
import {
  defer,
  deferEphemeral,
  deferUpdate,
  editOriginal,
  type FollowUpTo,
  followUp,
  interactionRef,
  MESSAGE_CONTENT_MAX,
  openModal,
  type RespondTo,
  replyEphemeral,
  respondAutocomplete,
  updateMessage,
} from '../../src/interactions/respond.ts';

const GUILD = '900000000000000001';
const USER = '100000000000000001';
const INTERACTION = '1500000000000000002';
const APPLICATION = '800000000000000001';
const TOKEN = 'interaction-token';

const to: RespondTo = {
  guildId: GUILD,
  moduleId: 'ticket',
  actorId: USER,
  interaction: { id: INTERACTION, token: TOKEN },
};

const followTo: FollowUpTo = { ...to, applicationId: APPLICATION };

function callOf(result: PayloadResult): RestCall {
  if ('error' in result) throw new Error(result.error);
  if ('ledgerOnly' in result) throw new Error('expected a REST call, got a ledger-only kind');
  return result.call;
}

function bodyOf(request: ActionRequest): Record<string, unknown> {
  return callOf(toRestCall(request)).body as Record<string, unknown>;
}

function dataOf(request: ActionRequest): Record<string, unknown> | undefined {
  return bodyOf(request).data as Record<string, unknown> | undefined;
}

const MODAL = { customId: 'proton:ticket:open', title: 'Open a ticket', components: [{}] };

const modalEvent: ProtonEvent = {
  id: 'evt_modal_1',
  type: 'interaction.modal',
  guildId: GUILD,
  occurredAt: 0,
  payload: {
    id: INTERACTION,
    application_id: APPLICATION,
    type: InteractionType.ModalSubmit,
    guild_id: GUILD,
    token: TOKEN,
    data: { custom_id: 'proton:ticket:open', components: [] },
    member: { user: { id: USER } },
  },
};

function replyPayload(request: ActionRequest): InteractionReplyPayload {
  const parsed = interactionReplyPayloadSchema.safeParse(request.payload);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => issue.message).join('; '));
  }
  return parsed.data;
}

const callbackCases: [string, ActionRequest, InteractionReplyPayload['callbackType']][] = [
  ['deferEphemeral', deferEphemeral(to), INTERACTION_CALLBACK_DEFERRED_MESSAGE],
  ['deferUpdate', deferUpdate(to), INTERACTION_CALLBACK_DEFERRED_UPDATE],
  ['replyEphemeral', replyEphemeral(to, 'done'), INTERACTION_CALLBACK_CHANNEL_MESSAGE],
  ['updateMessage', updateMessage(to, 'edited'), INTERACTION_CALLBACK_UPDATE_MESSAGE],
  [
    'openModal',
    openModal(to, { customId: 'proton:ticket:open', title: 'Open a ticket', components: [{}] }),
    INTERACTION_CALLBACK_MODAL,
  ],
  [
    'respondAutocomplete',
    respondAutocomplete(to, [{ name: 'Alpha', value: 'alpha' }]),
    INTERACTION_CALLBACK_AUTOCOMPLETE_RESULT,
  ],
];

describe('every builder produces a request the executor accepts', () => {
  test.each(callbackCases)(
    '%s posts the interaction callback with the right type',
    (_label, request, callbackType) => {
      const call = callOf(toRestCall(request));

      expect(request.kind).toBe('interaction_reply');
      expect(request.dryRun).toBe(false);
      expect(call.method).toBe('POST');
      expect(call.path).toBe(`/interactions/${INTERACTION}/${TOKEN}/callback`);
      expect((call.body as { type: number }).type).toBe(callbackType);
    },
  );
});

describe('deferrals', () => {
  test('deferEphemeral asks Discord for a private "thinking" state', () => {
    expect(dataOf(deferEphemeral(to))).toEqual({ flags: MESSAGE_FLAG_EPHEMERAL });
  });

  test('deferUpdate carries no data — the message stays exactly as it was', () => {
    expect(dataOf(deferUpdate(to))).toBeUndefined();
  });
});

describe('defer', () => {
  test('a private defer is exactly deferEphemeral', () => {
    expect(defer(to, { ephemeral: true })).toEqual(deferEphemeral(to));
  });

  test('a public defer carries no flags at all', () => {
    const request = defer(to, { ephemeral: false });

    expect(dataOf(request)).toBeUndefined();
    expect((bodyOf(request) as { type: number }).type).toBe(INTERACTION_CALLBACK_DEFERRED_MESSAGE);
    expect(replyPayload(request).ephemeral).toBe(false);
  });

  test('both visibilities claim the defer key, so switching a module to it keeps its dedupe', () => {
    expect(defer(to, { ephemeral: false }).idempotencyKey).toBe(`ticket:${INTERACTION}:defer`);
    expect(defer(to, { ephemeral: true }).idempotencyKey).toBe(deferEphemeral(to).idempotencyKey);
  });

  test('never sends a flag other than ephemeral, which a deferral cannot carry', () => {
    expect(dataOf(defer(to, { ephemeral: true }))).toEqual({ flags: MESSAGE_FLAG_EPHEMERAL });
  });
});

describe('replyEphemeral', () => {
  test('is ephemeral whatever the caller passes', () => {
    const data = dataOf(replyEphemeral(to, { content: 'done', ephemeral: false }));

    expect(data?.flags).toBe(MESSAGE_FLAG_EPHEMERAL);
  });

  test('takes a bare string as the content', () => {
    expect(dataOf(replyEphemeral(to, 'done'))?.content).toBe('done');
  });

  test('carries embeds and components through', () => {
    const data = dataOf(
      replyEphemeral(to, { embeds: [{ title: 'Hi' }], components: [{ type: 1 }] }),
    );

    expect(data?.embeds).toEqual([{ title: 'Hi' }]);
    expect(data?.components).toEqual([{ type: 1 }]);
  });

  test('trims content to Discord’s cap instead of losing the whole reply to it', () => {
    const data = dataOf(replyEphemeral(to, 'x'.repeat(MESSAGE_CONTENT_MAX + 50)));

    expect(String(data?.content).length).toBe(MESSAGE_CONTENT_MAX);
  });
});

describe('updateMessage', () => {
  test('edits the message in place rather than replying privately', () => {
    const data = dataOf(updateMessage(to, { content: 'edited', components: [] }));

    expect(data?.content).toBe('edited');
    expect(data?.flags).toBeUndefined();
  });
});

describe('openModal', () => {
  test('sends the modal Discord expects, in Discord’s own spelling', () => {
    const data = dataOf(
      openModal(to, { customId: 'proton:ticket:open', title: 'Open a ticket', components: [{}] }),
    );

    expect(data).toEqual({
      custom_id: 'proton:ticket:open',
      title: 'Open a ticket',
      components: [{}],
    });
  });
});

describe('respondAutocomplete', () => {
  test('sends the choices', () => {
    const data = dataOf(respondAutocomplete(to, [{ name: 'Alpha', value: 'alpha' }]));

    expect(data).toEqual({ choices: [{ name: 'Alpha', value: 'alpha' }] });
  });

  test('an empty list is a valid answer — it means "no suggestions"', () => {
    expect(dataOf(respondAutocomplete(to, []))).toEqual({ choices: [] });
  });
});

describe('followUp', () => {
  test('posts to the webhook endpoint, not the callback endpoint', () => {
    const request = followUp(followTo, 'all done');
    const call = callOf(toRestCall(request));

    expect(request.kind).toBe('interaction_followup');
    expect(call.method).toBe('POST');
    expect(call.path).toBe(`/webhooks/${APPLICATION}/${TOKEN}`);
  });

  test('is ephemeral by default, because it follows an ephemeral defer', () => {
    expect(bodyOf(followUp(followTo, 'all done')).flags).toBe(MESSAGE_FLAG_EPHEMERAL);
  });

  test('can be made public when the caller says so', () => {
    expect(bodyOf(followUp(followTo, { content: 'all done', ephemeral: false })).flags).toBe(
      undefined,
    );
  });

  test('without a suffix it keeps the key it always had', () => {
    expect(followUp(followTo, 'x').idempotencyKey).toBe(`ticket:${INTERACTION}:followup`);
  });

  test('a suffix gives a second followup its own key, so the executor does not drop it', () => {
    const first = followUp(followTo, 'Waiting for the moderator to confirm…', 'placeholder');
    const second = followUp(followTo, 'Banned.', 'result');

    expect(first.idempotencyKey).toBe(`ticket:${INTERACTION}:followup:placeholder`);
    expect(second.idempotencyKey).toBe(`ticket:${INTERACTION}:followup:result`);
    expect(
      new Set([first, second, followUp(followTo, 'x')].map((r) => r.idempotencyKey)).size,
    ).toBe(3);
  });

  test('a suffix changes nothing but the key', () => {
    const plain = followUp(followTo, { content: 'done', ephemeral: false });
    const suffixed = followUp(followTo, { content: 'done', ephemeral: false }, 'result');

    expect({ ...suffixed, idempotencyKey: plain.idempotencyKey }).toEqual(plain);
  });
});

describe('editOriginal', () => {
  const V2 = [{ type: 17, components: [{ type: 10, content: 'Step 2 of 4' }] }];

  test('patches the deferred response in place rather than posting a new message', () => {
    const request = editOriginal(followTo, 'Saved.');
    const call = callOf(toRestCall(request));

    expect(request.kind).toBe('interaction_edit_original');
    expect(call.method).toBe('PATCH');
    expect(call.path).toBe(`/webhooks/${APPLICATION}/${TOKEN}/messages/@original`);
    expect(call.body).toEqual({ content: 'Saved.' });
  });

  test('keys under edit-original, with a suffix for a second edit of the same response', () => {
    expect(editOriginal(followTo, 'x').idempotencyKey).toBe(`ticket:${INTERACTION}:edit-original`);
    expect(editOriginal(followTo, 'x', 'step').idempotencyKey).toBe(
      `ticket:${INTERACTION}:edit-original:step`,
    );
    expect(
      editOriginal({ ...followTo, idempotencyKey: 'ticket:event-7' }, 'x').idempotencyKey,
    ).toBe('ticket:event-7:edit-original');
  });

  test('never collides with the defer or the followup of the same interaction', () => {
    const keys = new Set([
      deferEphemeral(followTo).idempotencyKey,
      followUp(followTo, 'x').idempotencyKey,
      editOriginal(followTo, 'x').idempotencyKey,
    ]);

    expect(keys.size).toBe(3);
  });

  test('drops the ephemeral bit the defer already fixed, and keeps Components V2', () => {
    const request = editOriginal(followTo, {
      components: V2,
      flags: MESSAGE_FLAG_IS_COMPONENTS_V2 | MESSAGE_FLAG_EPHEMERAL,
      ephemeral: true,
    });

    expect(bodyOf(request).flags).toBe(MESSAGE_FLAG_IS_COMPONENTS_V2);
    expect(interactionEditOriginalPayloadSchema.safeParse(request.payload).success).toBe(true);
  });

  test('sends no flags at all when only the ephemeral bit was asked for', () => {
    const request = editOriginal(followTo, { content: 'Saved.', flags: MESSAGE_FLAG_EPHEMERAL });

    expect(bodyOf(request).flags).toBeUndefined();
  });

  test('trims content to Discord’s cap like every other builder', () => {
    const payload = editOriginal(followTo, 'x'.repeat(MESSAGE_CONTENT_MAX + 50)).payload as {
      content: string;
    };

    expect(payload.content).toHaveLength(MESSAGE_CONTENT_MAX);
  });

  test('is not a case and omits absent fields', () => {
    const request = editOriginal(followTo, 'Saved.');
    const payload = request.payload as Record<string, unknown>;

    expect(request.record).toBe(false);
    expect(request.dryRun).toBe(false);
    expect(Object.entries(payload).filter(([, value]) => value === undefined)).toEqual([]);
  });
});

// Discord's rule: the first followup after a defer shows as the defer did, whatever it asks for.
function visibleTo(sequence: readonly ActionRequest[]): Array<'everyone' | 'invoker'> {
  let deferred: boolean | null = null;
  let answered = false;

  return sequence.flatMap((request) => {
    const payload = request.payload as { callbackType?: number; ephemeral?: boolean };

    if (request.kind === 'interaction_reply') {
      if (payload.callbackType === INTERACTION_CALLBACK_DEFERRED_MESSAGE) {
        deferred = payload.ephemeral === true;
        return [];
      }
      answered = true;
      return [payload.ephemeral === true ? 'invoker' : 'everyone'];
    }

    const ephemeral = deferred !== null && !answered ? deferred : payload.ephemeral === true;
    answered = true;
    return [ephemeral ? 'invoker' : 'everyone'];
  });
}

describe('what Discord shows after a deferral', () => {
  test('a private followup after a public defer is shown to everyone', () => {
    expect(
      visibleTo([
        defer(to, { ephemeral: false }),
        followUp(followTo, { content: 'You need a role for that.', ephemeral: true }),
      ]),
    ).toEqual(['everyone']);
  });

  test('so a refusal decided after a public defer must not be its first followup', () => {
    expect(
      visibleTo([
        defer(to, { ephemeral: false }),
        followUp(followTo, { content: 'Here is the leaderboard.', ephemeral: false }),
        followUp(followTo, { content: 'Only you can see this.', ephemeral: true }, 'note'),
      ]),
    ).toEqual(['everyone', 'invoker']);
  });

  test('a private defer keeps the first followup private even if it asks to be public', () => {
    expect(
      visibleTo([deferEphemeral(to), followUp(followTo, { content: 'Done.', ephemeral: false })]),
    ).toEqual(['invoker']);
  });
});

describe('idempotency keys', () => {
  test('are derived from the module and the interaction, so a redelivery is a duplicate', () => {
    expect(deferEphemeral(to).idempotencyKey).toBe(`ticket:${INTERACTION}:defer`);
    expect(replyEphemeral(to, 'x').idempotencyKey).toBe(`ticket:${INTERACTION}:reply`);
    expect(followUp(followTo, 'x').idempotencyKey).toBe(`ticket:${INTERACTION}:followup`);
  });

  test('differ between the calls a single handler makes', () => {
    const keys = new Set([
      deferEphemeral(to).idempotencyKey,
      deferUpdate(to).idempotencyKey,
      replyEphemeral(to, 'x').idempotencyKey,
      updateMessage(to, 'x').idempotencyKey,
      respondAutocomplete(to, []).idempotencyKey,
      followUp(followTo, 'x').idempotencyKey,
    ]);

    expect(keys.size).toBe(6);
  });

  test('the caller’s override scopes the key rather than replacing the suffix', () => {
    const overridden = replyEphemeral({ ...to, idempotencyKey: 'ticket:event-7' }, 'x');

    expect(overridden.idempotencyKey).toBe('ticket:event-7:reply');
  });

  test('a defer and its follow-up under one override still claim two keys', () => {
    const scoped: FollowUpTo = { ...followTo, idempotencyKey: 'ticket:event-7' };

    expect(deferEphemeral(scoped).idempotencyKey).toBe('ticket:event-7:defer');
    expect(followUp(scoped, 'x').idempotencyKey).toBe('ticket:event-7:followup');
  });

  test('two modals from one handler are two keys, so the second still opens', () => {
    const first = openModal(to, { ...MODAL, customId: 'proton:ticket:open' });
    const second = openModal(to, { ...MODAL, customId: 'proton:ticket:close' });

    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
  });

  test('an override keeps every builder’s suffix distinct', () => {
    const scoped: FollowUpTo = { ...followTo, idempotencyKey: 'ticket:event-7' };

    const keys = new Set([
      deferEphemeral(scoped).idempotencyKey,
      deferUpdate(scoped).idempotencyKey,
      replyEphemeral(scoped, 'x').idempotencyKey,
      updateMessage(scoped, 'x').idempotencyKey,
      openModal(scoped, MODAL).idempotencyKey,
      respondAutocomplete(scoped, []).idempotencyKey,
      followUp(scoped, 'x').idempotencyKey,
    ]);

    expect(keys.size).toBe(7);
  });
});

const everyBuilder: [string, ActionRequest][] = [
  ...callbackCases.map(([label, request]): [string, ActionRequest] => [label, request]),
  ['followUp', followUp(followTo, 'all done')],
];

describe('an acknowledgement is not a moderation case', () => {
  test.each(everyBuilder)('%s opts out of the case ledger', (_label, request) => {
    expect(request.record).toBe(false);
  });
});

describe('the payload schema the executor will actually run', () => {
  test.each(callbackCases)(
    '%s builds a payload interactionReplyPayloadSchema accepts',
    (_label, request, callbackType) => {
      const payload = replyPayload(request);

      expect(payload.callbackType).toBe(callbackType);
      expect(payload.interactionId).toBe(INTERACTION);
      expect(payload.interactionToken).toBe(TOKEN);
    },
  );

  test('followUp builds a payload interactionFollowupPayloadSchema accepts', () => {
    const parsed = interactionFollowupPayloadSchema.safeParse(
      followUp(followTo, 'all done').payload,
    );

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.applicationId).toBe(APPLICATION);
  });

  test.each(everyBuilder)(
    '%s omits absent fields rather than setting them to undefined',
    (_label, request) => {
      const payload = request.payload as Record<string, unknown>;

      expect(Object.entries(payload).filter(([, value]) => value === undefined)).toEqual([]);
    },
  );

  test('the 2000-character slice is what keeps an overlong reply inside the schema', () => {
    const overlong = 'x'.repeat(MESSAGE_CONTENT_MAX + 50);

    expect(replyPayload(replyEphemeral(to, overlong)).content).toHaveLength(MESSAGE_CONTENT_MAX);
    expect(
      interactionReplyPayloadSchema.safeParse({
        interactionId: INTERACTION,
        interactionToken: TOKEN,
        callbackType: INTERACTION_CALLBACK_CHANNEL_MESSAGE,
        content: overlong,
      }).success,
    ).toBe(false);
  });

  test('openModal carries a modal that passes modalSchema on its own', () => {
    expect(modalSchema.safeParse(replyPayload(openModal(to, MODAL)).modal).success).toBe(true);
  });

  test('a reply with nothing in it is refused, and the message says what is missing', () => {
    const parsed = interactionReplyPayloadSchema.safeParse(
      updateMessage(to, { components: [] }).payload,
    );

    expect(parsed.success).toBe(false);
    expect(
      parsed.success ? '' : parsed.error.issues.map((issue) => issue.message).join(),
    ).toContain('content, an embed, a component, a file or a poll');
  });

  test('a deferral needs nothing to say, so an empty one still passes', () => {
    expect(replyPayload(deferUpdate(to)).content).toBeUndefined();
    expect(replyPayload(deferEphemeral(to)).ephemeral).toBe(true);
  });

  test('an over-cap choice list is refused whole rather than trimmed to fit', () => {
    const choices = Array.from({ length: MAX_AUTOCOMPLETE_CHOICES + 1 }, (_unused, index) => ({
      name: `choice ${index}`,
      value: `choice-${index}`,
    }));
    const request = respondAutocomplete(to, choices);

    expect((request.payload as { choices: unknown[] }).choices).toHaveLength(
      MAX_AUTOCOMPLETE_CHOICES + 1,
    );
    expect(interactionReplyPayloadSchema.safeParse(request.payload).success).toBe(false);
  });

  test('chaining a modal off a modal submission is refused, and the message says why', () => {
    const fromModal: RespondTo = {
      ...to,
      interaction: { ...to.interaction, type: INTERACTION_TYPE_MODAL_SUBMIT },
    };
    const parsed = interactionReplyPayloadSchema.safeParse(openModal(fromModal, MODAL).payload);

    expect(parsed.success).toBe(false);
    expect(
      parsed.success ? '' : parsed.error.issues.map((issue) => issue.message).join(),
    ).toContain('will not open a modal in response to a modal submission');
  });

  test('a modal opened from a component press carries the source type and passes', () => {
    const fromComponent: RespondTo = {
      ...to,
      interaction: { ...to.interaction, type: InteractionType.MessageComponent },
    };

    expect(replyPayload(openModal(fromComponent, MODAL)).sourceInteractionType).toBe(
      InteractionType.MessageComponent,
    );
  });
});

describe('interactionRef', () => {
  test('carries the source type a modal-submit handler would otherwise lose', () => {
    const facts = readModalInteraction(modalEvent);

    if (!facts) throw new Error('expected the recorded modal submission to be readable');

    expect(interactionRef(facts)).toEqual({
      id: facts.interactionId,
      token: facts.token,
      type: InteractionType.ModalSubmit,
    });
  });

  test('the ref it builds is what makes openModal refuse a second modal', () => {
    const facts = readModalInteraction(modalEvent);

    if (!facts) throw new Error('expected the recorded modal submission to be readable');

    const request = openModal(
      { guildId: GUILD, moduleId: 'ticket', actorId: USER, interaction: interactionRef(facts) },
      MODAL,
    );

    expect(interactionReplyPayloadSchema.safeParse(request.payload).success).toBe(false);
  });
});
