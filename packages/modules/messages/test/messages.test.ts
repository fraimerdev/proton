import { describe, expect, test } from 'bun:test';
import {
  BUTTON_STYLE_VALUES,
  DEFAULT_MENTION_POLICY,
  INTERACTION_CALLBACK_MODAL,
  Permissions,
} from '@proton/core';
import { ChannelType } from 'discord-api-types/v10';
import { messagesCommands } from '../src/commands.ts';
import {
  COLOUR_FIELD,
  COMPOSER_TITLE,
  DESCRIPTION_FIELD,
  IMAGE_FIELD,
  TITLE_FIELD,
} from '../src/compose.ts';
import { messagesConfigSchema, type SavedMessage } from '../src/config.ts';
import {
  APPLICATION,
  autocompleteEvent,
  CHANNEL,
  channelOption,
  harness,
  modalEvent,
  OTHER_CHANNEL,
  ROLE,
  stringOption,
  subcommand,
} from './harness.ts';

const ACTION_ROW_TYPE = 1;
const BUTTON_TYPE = 2;

const WELCOME: SavedMessage = {
  name: 'welcome',
  embeds: [
    {
      title: 'Welcome',
      description: 'Read the rules and say hello.',
      color: 0x5865f2,
      fields: [{ name: 'Start here', value: '<#500000000000000001>', inline: true }],
    },
  ],
  components: [],
  mentions: DEFAULT_MENTION_POLICY,
  v2: [],
};

const RULES: SavedMessage = {
  name: 'Rules',
  embeds: [{ description: 'Be kind.' }],
  components: [],
  mentions: DEFAULT_MENTION_POLICY,
  v2: [],
};

const ANNOUNCE: SavedMessage = {
  name: 'announce',
  content: 'Doors open at six.',
  embeds: [
    { title: 'Launch night', description: 'The stage is set.' },
    { title: 'Getting here', description: 'The blue door on the left.' },
  ],
  components: [],
  mentions: { everyone: false, roles: false, users: false },
  v2: [],
};

const PICKER: SavedMessage = {
  name: 'picker',
  embeds: [{ description: 'Pick a role.' }],
  components: [
    {
      kind: 'buttons',
      buttons: [
        { key: 'site', style: 'link', label: 'Website', url: 'https://example.test/' },
        {
          key: 'artist',
          style: 'primary',
          label: 'Artist',
          action: { kind: 'role', mode: 'toggle', roleId: ROLE },
        },
      ],
    },
  ],
  mentions: DEFAULT_MENTION_POLICY,
  v2: [],
};

interface OptionShape {
  name: string;
  channel_types?: number[];
  options?: OptionShape[];
}

function embedCommandData() {
  const [definition] = messagesCommands({ applicationId: APPLICATION });
  if (!definition) throw new Error('the embeds module registered no commands');
  return definition;
}

function postChannelTypes(): number[] {
  const options = embedCommandData().data.options as OptionShape[] | undefined;
  const post = options?.find((option) => option.name === 'post');
  return post?.options?.find((option) => option.name === 'channel')?.channel_types ?? [];
}

describe('who may run /message', () => {
  test('Discord gates the command on Manage Messages', () => {
    expect(embedCommandData().data.default_member_permissions).toBe(
      Permissions.ManageMessages.toString(),
    );
  });

  test('the description names the permission the gate is', () => {
    expect(embedCommandData().description).toContain('Manage Messages');
    expect(embedCommandData().data.description).toContain('Manage Messages');
  });

  test('the channel option offers text channels but not private threads', () => {
    expect(postChannelTypes()).toContain(ChannelType.GuildText);
    expect(postChannelTypes()).not.toContain(ChannelType.PrivateThread);
  });
});

describe('/message post', () => {
  test('sends the saved embed to the channel the command was run in', async () => {
    const h = harness();

    await h.run(subcommand('post', [stringOption('name', 'welcome')]), { templates: [WELCOME] });

    const send = h.sends()[0];
    expect(send?.method).toBe('POST');
    expect(send?.path).toBe(`/channels/${CHANNEL}/messages`);
    expect(h.postedEmbed()).toEqual({
      title: 'Welcome',
      description: 'Read the rules and say hello.',
      color: 0x5865f2,
      fields: [{ name: 'Start here', value: '<#500000000000000001>', inline: true }],
    });
    expect(h.lastSaid()).toContain('Posted **welcome**');
  });

  test('sends it to the channel the member chose instead', async () => {
    const h = harness();

    await h.run(
      subcommand('post', [
        stringOption('name', 'welcome'),
        channelOption('channel', OTHER_CHANNEL),
      ]),
      { templates: [WELCOME] },
    );

    expect(h.sends()[0]?.path).toBe(`/channels/${OTHER_CHANNEL}/messages`);
    expect(h.lastSaid()).toContain(`<#${OTHER_CHANNEL}>`);
  });

  test('finds a saved embed whatever case the member typed', async () => {
    const h = harness();

    await h.run(subcommand('post', [stringOption('name', 'rules')]), { templates: [RULES] });

    expect(h.sends()).toHaveLength(1);
    expect(h.lastSaid()).toContain('Posted **Rules**');
  });

  test('acknowledges before it posts, so the interaction cannot time out', async () => {
    const h = harness();

    await h.run(subcommand('post', [stringOption('name', 'welcome')]), { templates: [WELCOME] });

    expect(h.calls()[0]?.path).toContain('/callback');
    expect(h.calls()[1]?.path).toBe(`/channels/${CHANNEL}/messages`);
    expect(h.calls()[2]?.path).toBe(`/webhooks/${APPLICATION}/interaction-token`);
  });

  test('a name that is not saved is refused, and the saved names are listed', async () => {
    const h = harness();

    await h.run(subcommand('post', [stringOption('name', 'goodbye')]), {
      templates: [WELCOME, RULES],
    });

    expect(h.sends()).toHaveLength(0);

    const reply = h.lastSaid() ?? '';
    expect(reply).toContain('no saved message called “goodbye”');
    expect(reply).toContain('`welcome`');
    expect(reply).toContain('`Rules`');
  });

  test('an empty server says where saved messages come from', async () => {
    const h = harness();

    await h.run(subcommand('post', [stringOption('name', 'welcome')]), { templates: [] });

    expect(h.sends()).toHaveLength(0);
    expect(h.lastSaid()).toContain('/message send');
  });

  test('sends the message’s own text alongside its embeds', async () => {
    const h = harness();

    await h.run(subcommand('post', [stringOption('name', 'announce')]), { templates: [ANNOUNCE] });

    expect(h.postedMessage()?.content).toBe('Doors open at six.');
    expect(h.postedMessage()?.embeds).toHaveLength(2);
  });

  test('sends every embed on the message, in order, in the one call', async () => {
    const h = harness();

    await h.run(subcommand('post', [stringOption('name', 'announce')]), { templates: [ANNOUNCE] });

    expect(h.sends()).toHaveLength(1);
    expect(h.postedMessage()?.embeds).toEqual([
      { title: 'Launch night', description: 'The stage is set.' },
      { title: 'Getting here', description: 'The blue door on the left.' },
    ]);
  });

  test('a link button carries its address and no custom_id', async () => {
    const h = harness();

    await h.run(subcommand('post', [stringOption('name', 'picker')]), { templates: [PICKER] });

    expect(h.postedRows()).toHaveLength(1);
    expect(h.postedRows()[0]?.type).toBe(ACTION_ROW_TYPE);
    expect(h.postedButtons()[0]).toEqual({
      type: BUTTON_TYPE,
      style: BUTTON_STYLE_VALUES.link,
      label: 'Website',
      url: 'https://example.test/',
    });
    expect(h.postedButtons()[0]).not.toHaveProperty('custom_id');
  });

  test('an action button carries a custom_id naming the message and the key, and no address', async () => {
    const h = harness();

    await h.run(subcommand('post', [stringOption('name', 'picker')]), { templates: [PICKER] });

    expect(h.postedButtons()[1]).toEqual({
      type: BUTTON_TYPE,
      style: BUTTON_STYLE_VALUES.primary,
      label: 'Artist',
      custom_id: 'proton:messages:picker:artist',
    });
    expect(h.postedButtons()[1]).not.toHaveProperty('url');
  });

  test('the custom_id uses the normalised name, so a press finds the row again', async () => {
    const h = harness();

    await h.run(subcommand('post', [stringOption('name', 'rules')]), {
      templates: [{ ...PICKER, name: 'Rules' }],
    });

    expect(h.postedButtons()[1]?.custom_id).toBe('proton:messages:rules:artist');
  });

  test('a row saved under v1 still posts everything it held', async () => {
    const h = harness();
    const stored = messagesConfigSchema.parse({
      enabled: true,
      templates: [
        {
          name: 'legacy',
          title: 'Welcome',
          description: 'Read the rules.',
          footer: 'Updated monthly',
        },
      ],
    });

    await h.run(subcommand('post', [stringOption('name', 'legacy')]), {
      templates: stored.templates,
    });

    expect(h.postedEmbed()).toEqual({
      title: 'Welcome',
      description: 'Read the rules.',
      footer: { text: 'Updated monthly' },
    });
  });

  test('allowed_mentions is on the call even when the message says nothing about mentions', async () => {
    const h = harness();

    await h.run(subcommand('post', [stringOption('name', 'welcome')]), { templates: [WELCOME] });

    expect(h.postedMessage()?.allowed_mentions).toEqual({ parse: ['roles', 'users'] });
  });

  test('a message that pings nothing still sends an explicit empty allowed_mentions', async () => {
    const h = harness();

    await h.run(subcommand('post', [stringOption('name', 'announce')]), { templates: [ANNOUNCE] });

    expect(h.postedMessage()?.allowed_mentions).toEqual({ parse: [] });
  });

  test('names the missing permission and the channel when the bot cannot post', async () => {
    const h = harness();

    await h.run(subcommand('post', [stringOption('name', 'welcome')]), {
      templates: [WELCOME],
      botPermissions: Permissions.ViewChannel | Permissions.EmbedLinks,
    });

    expect(h.sends()).toHaveLength(0);

    const reply = h.lastSaid() ?? '';
    expect(reply).toContain('SendMessages');
    expect(reply).toContain(CHANNEL);
    expect(reply).toContain('could not post **welcome**');
  });

  test('a refusal for another channel names the gate as well as the missing permission', async () => {
    const h = harness();

    await h.run(
      subcommand('post', [
        stringOption('name', 'welcome'),
        channelOption('channel', OTHER_CHANNEL),
      ]),
      { templates: [WELCOME], botPermissions: Permissions.ViewChannel | Permissions.EmbedLinks },
    );

    expect(h.sends()).toHaveLength(0);

    const reply = h.lastSaid() ?? '';
    expect(reply).toContain('SendMessages');
    expect(reply).toContain('Manage Messages');
  });

  test('a refusal for the channel it was run in does not lecture about the gate', async () => {
    const h = harness();

    await h.run(subcommand('post', [stringOption('name', 'welcome')]), {
      templates: [WELCOME],
      botPermissions: Permissions.ViewChannel | Permissions.EmbedLinks,
    });

    expect(h.lastSaid() ?? '').not.toContain('Manage Messages');
  });

  test('names the missing wiring rather than posting something it cannot report on', async () => {
    const h = harness();

    await h.run(subcommand('post', [stringOption('name', 'welcome')]), {
      templates: [WELCOME],
      deps: {},
    });

    expect(h.sends()).toHaveLength(0);
    expect(h.lastSaid()).toContain("isn't fully set up");
    expect(
      h.logs.some((line) => line.level === 'error' && line.message.includes('applicationId')),
    ).toBe(true);
  });

  test('a redelivered command posts the embed once', async () => {
    const h = harness();

    for (let attempt = 0; attempt < 2; attempt++) {
      await h.run(subcommand('post', [stringOption('name', 'welcome')]), {
        templates: [WELCOME],
        idempotencyKey: 'command-event-1',
      });
    }

    expect(h.sends()).toHaveLength(1);
  });

  test('posting an embed is not a moderation case', async () => {
    const h = harness();

    await h.run(subcommand('post', [stringOption('name', 'welcome')]), { templates: [WELCOME] });

    expect(h.recorder.recorded).toHaveLength(0);
  });
});

describe('/message list', () => {
  test('names the saved embeds', async () => {
    const h = harness();

    await h.run(subcommand('list'), { templates: [WELCOME, RULES] });

    const reply = h.lastSaid() ?? '';
    expect(reply).toContain('2 in this server');
    expect(reply).toContain('`welcome`');
    expect(h.sends()).toHaveLength(0);
  });

  test('says where they come from when there are none', async () => {
    const h = harness();

    await h.run(subcommand('list'), { templates: [] });

    expect(h.lastSaid()).toContain('dashboard');
  });
});

describe('/message send', () => {
  test('opens a modal with the four inputs', async () => {
    const h = harness();

    await h.run(subcommand('send'));

    expect(h.callbackType()).toBe(INTERACTION_CALLBACK_MODAL);

    const modal = h.modalOpened();
    expect(modal?.custom_id).toBe('proton:messages:send');
    expect(modal?.title).toBe(COMPOSER_TITLE);

    const inputs = (modal?.components ?? []).map(
      (label) => (label.component as { custom_id?: string } | undefined)?.custom_id,
    );
    expect(inputs).toEqual([TITLE_FIELD, DESCRIPTION_FIELD, COLOUR_FIELD, IMAGE_FIELD]);
  });

  test('posts nothing by itself', async () => {
    const h = harness();

    await h.run(subcommand('send'));

    expect(h.sends()).toHaveLength(0);
  });
});

describe('the /message send modal submission', () => {
  test('posts what was composed into the channel it was composed in', async () => {
    const h = harness();

    await h.modal(
      modalEvent({
        [TITLE_FIELD]: 'Maintenance',
        [DESCRIPTION_FIELD]: 'Back in an hour.',
        [COLOUR_FIELD]: '#5865F2',
        [IMAGE_FIELD]: 'https://example.test/banner.png',
      }),
    );

    expect(h.sends()[0]?.path).toBe(`/channels/${CHANNEL}/messages`);
    expect(h.postedEmbed()).toEqual({
      title: 'Maintenance',
      description: 'Back in an hour.',
      color: 0x5865f2,
      image: { url: 'https://example.test/banner.png' },
    });
    expect(h.lastSaid()).toContain(`Posted your embed in <#${CHANNEL}>`);
  });

  test('acknowledges, posts, then confirms — and never opens a second modal', async () => {
    const h = harness();

    await h.modal(modalEvent({ [DESCRIPTION_FIELD]: 'Hello.' }));

    expect(h.calls().map((call) => call.path)).toEqual([
      `/interactions/600000000000000001/modal-token/callback`,
      `/channels/${CHANNEL}/messages`,
      `/webhooks/${APPLICATION}/modal-token`,
    ]);
    expect(h.bodies().some((body) => body.type === INTERACTION_CALLBACK_MODAL)).toBe(false);
  });

  test('an empty composer is refused instead of posting an empty embed', async () => {
    const h = harness();

    await h.modal(modalEvent({ [TITLE_FIELD]: '  ', [DESCRIPTION_FIELD]: '' }));

    expect(h.sends()).toHaveLength(0);
    expect(h.lastSaid()).toContain('has nothing in it');
  });

  test('a colour it cannot read is refused, and it says what one looks like', async () => {
    const h = harness();

    await h.modal(modalEvent({ [DESCRIPTION_FIELD]: 'x', [COLOUR_FIELD]: 'blurple' }));

    expect(h.sends()).toHaveLength(0);
    expect(h.lastSaid()).toContain('#5865F2');
  });

  test('an image that is not a link is refused, and it says what is missing', async () => {
    const h = harness();

    await h.modal(modalEvent({ [DESCRIPTION_FIELD]: 'x', [IMAGE_FIELD]: 'example.test/a.png' }));

    expect(h.sends()).toHaveLength(0);
    expect(h.lastSaid()).toContain('http://');
  });

  test('names the missing permission when the bot cannot post in that channel', async () => {
    const h = harness();

    await h.modal(modalEvent({ [DESCRIPTION_FIELD]: 'x' }), {
      botPermissions: Permissions.ViewChannel | Permissions.EmbedLinks,
    });

    expect(h.sends()).toHaveLength(0);

    const reply = h.lastSaid() ?? '';
    expect(reply).toContain('SendMessages');
    expect(reply).toContain(CHANNEL);
  });

  test('says the module is off rather than posting from a stale modal', async () => {
    const h = harness();

    await h.modal(modalEvent({ [DESCRIPTION_FIELD]: 'x' }), { config: { enabled: false } });

    expect(h.sends()).toHaveLength(0);
    expect(h.lastSaid()).toContain('switched off');
  });

  test('names the missing wiring when it has no way to confirm', async () => {
    const h = harness();

    await h.modal(modalEvent({ [DESCRIPTION_FIELD]: 'x' }), { deps: {} });

    expect(h.sends()).toHaveLength(0);
    expect(h.lastSaid()).toContain("isn't fully set up");
  });

  test('leaves another module’s modal alone', async () => {
    const h = harness();

    await h.modal(modalEvent({ reason: 'x' }, { customId: 'proton:verification:appeal' }));

    expect(h.calls()).toHaveLength(0);
  });

  test('leaves a custom_id of its own that it does not recognise alone', async () => {
    const h = harness();

    await h.modal(modalEvent({ [TITLE_FIELD]: 'x' }, { customId: 'proton:messages:edit' }));

    expect(h.calls()).toHaveLength(0);
  });

  test('says so rather than guessing when Discord names no channel', async () => {
    const h = harness();

    await h.modal(modalEvent({ [DESCRIPTION_FIELD]: 'x' }, { channelId: null }));

    expect(h.sends()).toHaveLength(0);
    expect(h.lastSaid()).toContain('/message send');
  });

  test('a redelivered submission posts once', async () => {
    const h = harness();
    const event = modalEvent({ [DESCRIPTION_FIELD]: 'Hello.' });

    await h.modal(event);
    await h.modal(event);

    expect(h.sends()).toHaveLength(1);
  });
});

describe('autocomplete on /message post', () => {
  test('suggests the saved names', async () => {
    const h = harness();

    await h.autocomplete(autocompleteEvent('w'), { templates: [WELCOME, RULES] });

    expect(h.choices().map((choice) => choice.value)).toEqual(['welcome']);
  });

  test('answers with an empty list rather than leaving the member on a spinner', async () => {
    const h = harness();

    await h.autocomplete(autocompleteEvent('nothing-matches'), { templates: [WELCOME] });

    expect(h.calls()).toHaveLength(1);
    expect(h.choices()).toEqual([]);
  });

  test('ignores an autocomplete for a command another module owns', async () => {
    const h = harness();

    await h.autocomplete(autocompleteEvent('w', { commandName: 'tag' }), { templates: [WELCOME] });

    expect(h.calls()).toHaveLength(0);
  });

  test('ignores a subcommand that takes no saved name', async () => {
    const h = harness();

    await h.autocomplete(autocompleteEvent('w', { subcommand: 'list' }), { templates: [WELCOME] });

    expect(h.calls()).toHaveLength(0);
  });

  test('ignores a focused option that is not the name', async () => {
    const h = harness();

    await h.autocomplete(autocompleteEvent('w', { focusedName: 'channel' }), {
      templates: [WELCOME],
    });

    expect(h.calls()).toHaveLength(0);
  });

  test('stays quiet while the module is switched off', async () => {
    const h = harness();

    await h.autocomplete(autocompleteEvent('w'), {
      templates: [WELCOME],
      config: { enabled: false },
    });

    expect(h.calls()).toHaveLength(0);
  });
});
