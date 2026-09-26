import { describe, expect, test } from 'bun:test';
import { type DispatchName, dispatch } from '@proton/fixtures';
import type { EventType, ProtonEvent } from '../../src/events/types.ts';
import {
  attachmentExpiry,
  readAutocompleteInteraction,
  readComponentInteraction,
  readModalInteraction,
  readResolved,
  toResolvedMessage,
} from '../../src/interactions/read.ts';

const GUILD = '900000000000000001';
const CHANNEL = '500000000000000001';
const TARGET = '100000000000000003';

function recorded(type: EventType, name: DispatchName): ProtonEvent {
  const raw = dispatch(name);
  return {
    id: `evt_${name}`,
    type,
    guildId: typeof raw.d.guild_id === 'string' ? raw.d.guild_id : null,
    occurredAt: 0,
    payload: raw.d,
  };
}

describe('attachmentExpiry', () => {
  test('reads the hex ex parameter of a signed CDN url as milliseconds', () => {
    expect(
      attachmentExpiry(
        'https://cdn.discordapp.com/attachments/1/2/a.png?ex=6abf9cc0&is=6aad27c0&hm=ab&',
      ),
    ).toBe(Date.parse('2026-10-02T12:00:00Z'));
  });

  test.each([
    ['an unsigned url', 'https://cdn.discordapp.com/attachments/1/2/a.png'],
    ['an ex that is not hex', 'https://cdn.discordapp.com/a.png?ex=tomorrow'],
    ['an empty ex', 'https://cdn.discordapp.com/a.png?ex='],
    ['something that is not a url', 'not a url at all'],
  ])('is null for %s', (_label, url) => {
    expect(attachmentExpiry(url)).toBeNull();
  });
});

describe('readResolved on a USER context menu', () => {
  const payload = dispatch('interactionCreateUserCommand').d;

  test('reads the targeted user', () => {
    expect(readResolved(payload).users.get(TARGET)).toEqual({
      id: TARGET,
      username: 'rulebreaker',
      globalName: 'Rule Breaker',
      avatar: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      bot: false,
    });
  });

  test('reads the partial member Discord sends without its user', () => {
    expect(readResolved(payload).members.get(TARGET)).toEqual({
      roleIds: ['700000000000000001', '700000000000000002'],
      nick: 'Breaker',
      joinedAt: Date.parse('2026-08-01T09:30:00Z'),
      permissions: 1071698660929n,
      communicationDisabledUntil: null,
    });
  });

  test('has no messages or attachments to offer', () => {
    const resolved = readResolved(payload);

    expect(resolved.messages.size).toBe(0);
    expect(resolved.attachments.size).toBe(0);
  });

  test('a user who is not a member resolves without one', () => {
    const d = dispatch('interactionCreateUserCommand').d;
    delete ((d.data as Record<string, unknown>).resolved as Record<string, unknown>).members;

    const resolved = readResolved(d);

    expect(resolved.users.has(TARGET)).toBe(true);
    expect(resolved.members.has(TARGET)).toBe(false);
  });

  test('a timed-out member carries when the timeout ends', () => {
    const d = dispatch('interactionCreateUserCommand').d;
    const members = ((d.data as Record<string, unknown>).resolved as Record<string, unknown>)
      .members as Record<string, Record<string, unknown>>;
    const member = members[TARGET];
    if (!member) throw new Error('the fixture lost its member');
    member.communication_disabled_until = '2026-09-19T08:00:00.000000+00:00';

    expect(readResolved(d).members.get(TARGET)?.communicationDisabledUntil).toBe(
      Date.parse('2026-09-19T08:00:00Z'),
    );
  });
});

describe('readResolved on a MESSAGE context menu', () => {
  const resolved = readResolved(dispatch('interactionCreateMessageCommand').d);
  const message = resolved.messages.get('1400000000000000010');

  test('reads the targeted message as the snapshot a report keeps', () => {
    expect(message).toMatchObject({
      id: '1400000000000000010',
      channelId: CHANNEL,
      webhookId: null,
      content: 'Free nitro for everyone who clicks the link in my bio',
      createdAt: Date.parse('2026-09-18T11:58:00Z'),
      editedAt: Date.parse('2026-09-18T11:59:30Z'),
      type: 0,
      flags: 0,
      stickerNames: ['wave'],
      forwarded: false,
      snapshotContent: null,
    });
    expect(message?.author?.id).toBe(TARGET);
    expect(message?.embeds).toEqual([
      { type: 'rich', title: 'Claim your prize', description: 'Limited time only' },
    ]);
  });

  test('keeps attachment metadata and when its link stops working', () => {
    expect(message?.attachments).toEqual([
      {
        id: '1410000000000000001',
        filename: 'proof.png',
        contentType: 'image/png',
        size: 48213,
        url: expect.stringContaining('/attachments/500000000000000001/1410000000000000001/'),
        proxyUrl: expect.stringContaining('media.discordapp.net'),
        width: 800,
        height: 600,
        ephemeral: false,
        expiresAt: Date.parse('2026-10-02T12:00:00Z'),
      },
    ]);
  });
});

describe('readResolved is tolerant', () => {
  test.each([
    ['nothing at all', undefined],
    ['an interaction with no data', { id: '1', token: 't' }],
    ['a command with no resolved block', { data: { name: 'ping', type: 1 } }],
    ['a resolved block of the wrong shape', { data: { resolved: { users: [1, 2] } } }],
  ])('gives empty maps for %s', (_label, payload) => {
    const resolved = readResolved(payload);

    expect(resolved.users.size).toBe(0);
    expect(resolved.members.size).toBe(0);
    expect(resolved.messages.size).toBe(0);
    expect(resolved.attachments.size).toBe(0);
  });

  test('skips an entry it cannot read and keeps the rest', () => {
    const resolved = readResolved({
      data: {
        resolved: {
          users: { '1': { id: '1' }, '2': { id: '2', username: 'kept' } },
          attachments: { '3': { id: '3', filename: 'no-url.png' } },
        },
      },
    });

    expect([...resolved.users.keys()]).toEqual(['2']);
    expect(resolved.attachments.size).toBe(0);
  });

  test('also reads the interaction data block handed over on its own', () => {
    const d = dispatch('interactionCreateUserCommand').d;

    expect(readResolved(d.data).users.has(TARGET)).toBe(true);
  });
});

describe('toResolvedMessage on a message fetched over REST', () => {
  const fetched = {
    id: '1400000000000000020',
    channel_id: CHANNEL,
    type: 0,
    content: '',
    author: { id: '100000000000000004', username: 'hook', bot: true },
    webhook_id: '1700000000000000001',
    timestamp: '2026-09-18T10:00:00.000000+00:00',
    edited_timestamp: null,
    flags: 16384,
    embeds: [],
    attachments: [],
    stickers: [{ id: '1', name: 'legacy' }],
    message_reference: { type: 1, channel_id: '500000000000000009', message_id: '1' },
    message_snapshots: [
      { message: { type: 0, content: 'the text that was forwarded', attachments: [] } },
    ],
  };

  test('flags a forward and keeps the forwarded text apart from the empty content', () => {
    const message = toResolvedMessage(fetched);

    expect(message?.forwarded).toBe(true);
    expect(message?.content).toBe('');
    expect(message?.snapshotContent).toBe('the text that was forwarded');
  });

  test('names the webhook, marks the bot author and falls back to legacy stickers', () => {
    const message = toResolvedMessage(fetched);

    expect(message?.webhookId).toBe('1700000000000000001');
    expect(message?.author?.bot).toBe(true);
    expect(message?.editedAt).toBeNull();
    expect(message?.flags).toBe(16384);
    expect(message?.stickerNames).toEqual(['legacy']);
  });

  test.each([
    ['no id', { channel_id: CHANNEL }],
    ['no channel', { id: '1400000000000000020' }],
    ['not an object', 'hello'],
  ])('is null for %s', (_label, raw) => {
    expect(toResolvedMessage(raw)).toBeNull();
  });
});

describe('the recorded modal with a file upload', () => {
  const submitted = recorded('interaction.modal', 'interactionCreateModalFileUpload');

  test('keeps the uploaded ids in values and the files themselves in attachments', () => {
    const read = readModalInteraction(submitted);

    expect(read?.values.evidence).toEqual(['1430000000000000001', '1430000000000000002']);
    expect([...(read?.attachments.keys() ?? [])]).toEqual([
      '1430000000000000001',
      '1430000000000000002',
    ]);
  });

  test('an uploaded file is ephemeral and says when its link expires', () => {
    const file = readModalInteraction(submitted)?.attachments.get('1430000000000000001');

    expect(file).toMatchObject({
      filename: 'screenshot.png',
      contentType: 'image/png',
      size: 241394,
      width: 2482,
      height: 604,
      ephemeral: true,
      expiresAt: Date.parse('2026-09-19T12:00:00Z'),
    });
    expect(file?.url).toContain('/ephemeral-attachments/');
  });

  test('a file with no dimensions reads them as null', () => {
    const file = readModalInteraction(submitted)?.attachments.get('1430000000000000002');

    expect(file?.width).toBeNull();
    expect(file?.height).toBeNull();
    expect(file?.contentType).toBe('text/plain; charset=utf-8');
  });

  test('still reads the text and select answers beside it', () => {
    const read = readModalInteraction(submitted);

    expect(read?.fields).toEqual({
      comment: 'They posted this in three channels within a minute.',
    });
    expect(read?.values.reason).toEqual(['spam']);
  });

  test('a modal opened from a command has no message to point at', () => {
    expect(readModalInteraction(submitted)?.messageId).toBeNull();
  });
});

describe('readModalInteraction beyond text', () => {
  function modal(extra: Record<string, unknown>): ProtonEvent {
    return {
      id: 'evt_modal',
      type: 'interaction.modal',
      guildId: GUILD,
      occurredAt: 0,
      payload: {
        id: '1500000000000000099',
        token: 't',
        type: 5,
        guild_id: GUILD,
        member: { user: { id: '100000000000000001' }, roles: [] },
        ...extra,
      },
    };
  }

  test('a checkbox answer is a boolean in checks, never a text field', () => {
    const read = readModalInteraction(
      modal({
        data: {
          custom_id: 'proton:x:y',
          components: [
            { type: 18, component: { type: 23, custom_id: 'notify', value: true } },
            { type: 18, component: { type: 23, custom_id: 'silent', value: false } },
          ],
        },
      }),
    );

    expect(read?.checks).toEqual({ notify: true, silent: false });
    expect(read?.fields).toEqual({});
  });

  test('a modal opened from a button names the message the button was on', () => {
    const read = readModalInteraction(
      modal({
        data: { custom_id: 'proton:x:y', components: [] },
        message: { id: '1400000000000000009', flags: 0 },
      }),
    );

    expect(read?.messageId).toBe('1400000000000000009');
  });

  test('a modal with no uploads has an empty attachment map', () => {
    const read = readModalInteraction(modal({ data: { custom_id: 'proton:x:y', components: [] } }));

    expect(read?.attachments.size).toBe(0);
    expect(read?.checks).toEqual({});
  });
});

describe('the new recordings reach only the reader for their type', () => {
  test('context menus are commands, which no component, modal or autocomplete reader takes', () => {
    for (const name of [
      'interactionCreateUserCommand',
      'interactionCreateMessageCommand',
    ] as const) {
      const event = recorded('interaction.command', name);

      expect(readComponentInteraction(event)).toBeNull();
      expect(readModalInteraction(event)).toBeNull();
      expect(readAutocompleteInteraction(event)).toBeNull();
    }
  });

  test('the file-upload modal is a modal', () => {
    const event = recorded('interaction.modal', 'interactionCreateModalFileUpload');

    expect(readModalInteraction(event)).not.toBeNull();
    expect(readComponentInteraction(event)).toBeNull();
  });

  test('a press in a DM has no guild, a user instead of a member, and no roles', () => {
    const event = recorded('interaction.component', 'interactionCreateComponentDm');
    const read = readComponentInteraction(event);

    expect(event.guildId).toBeNull();
    expect(read?.guildId).toBeNull();
    expect(read?.userId).toBe('100000000000000001');
    expect(read?.roleIds).toBeNull();
    expect(read?.customId).toBe('proton:moderation:rfin:900000000000000001:Ab3dE5gH9k');
    expect(read?.channelId).toBe('1600000000000000001');
  });
});
