import { describe, expect, test } from 'bun:test';
import {
  type ContainerChild,
  editMessagePayloadSchema,
  type GuildStateStore,
  MESSAGE_FLAG_IS_COMPONENTS_V2,
  parseCustomId,
  sendPayloadSchema,
} from '@proton/core';
import { type PlaceholderEnvironment, PROTON_SUPPORT_URL } from '@proton/core/placeholders';
import { ButtonStyle, ComponentType } from 'discord-api-types/v10';
import {
  HONEYPOT_ACTIONS,
  type HoneypotAction,
  type HoneypotLayout,
  MODULE_ID,
} from '../src/config.ts';
import {
  buildNoticeComponents,
  caughtLabel,
  HONEYPOT_COLOUR,
  STATS_ACTION,
} from '../src/notice.ts';
import {
  armed,
  BOT,
  config,
  GUILD,
  type Harness,
  harness,
  LOUNGE,
  MEMBER,
  TRAP,
  trap,
} from './harness.ts';

const REMEMBERED = '700000000000009001';

const two = () => ({ enabled: true, channels: [trap(), trap({ channelId: LOUNGE })] });

type Node = Record<string, unknown>;

function children(node: Node | undefined): Node[] {
  return Array.isArray(node?.components) ? (node.components as Node[]) : [];
}

function texts(nodes: readonly Node[]): string[] {
  return nodes.flatMap((node) =>
    node.type === ComponentType.TextDisplay ? [String(node.content)] : texts(children(node)),
  );
}

function buttons(nodes: readonly Node[]): Node[] {
  return nodes.flatMap((node) =>
    node.type === ComponentType.Button ? [node] : buttons(children(node)),
  );
}

function labelOf(nodes: readonly Node[]): unknown {
  return buttons(nodes)[0]?.label;
}

function caught(at: number, action: HoneypotAction = 'softban') {
  return { userId: MEMBER, action, at, messageId: `${MEMBER}-${at}` };
}

describe('reconciling the notices when the config is saved', () => {
  test('posts the notice into the armed channel and remembers where it put it', async () => {
    const h = harness();

    const outcome = await h.saved({ config: armed() });

    expect(outcome).toEqual({
      action: 'reconciled',
      changes: [{ channelId: TRAP, did: 'posted' }],
    });
    expect(h.calls()).toEqual([`POST /channels/${TRAP}/messages`]);
    expect(h.remembered()[TRAP]?.messageId).toBe(h.rest.posted[0] as string);
  });

  test('the next save edits that message rather than posting a twin', async () => {
    const h = harness();

    await h.saved({ config: armed() });
    const messageId = h.remembered()[TRAP]?.messageId;

    const outcome = await h.saved({ config: armed() });

    expect(outcome).toEqual({
      action: 'reconciled',
      changes: [{ channelId: TRAP, did: 'refreshed' }],
    });
    expect(h.calls()).toEqual([
      `POST /channels/${TRAP}/messages`,
      `PATCH /channels/${TRAP}/messages/${messageId}`,
    ]);
    expect(h.rest.posted).toHaveLength(1);
    expect(h.remembered()[TRAP]?.messageId).toBe(messageId as string);
  });

  test('a remembered message somebody deleted is replaced, and the new id remembered', async () => {
    const h = harness();

    await h.saved({ config: armed() });
    const gone = h.remembered()[TRAP]?.messageId;

    h.rest.fail((call) => call.method === 'PATCH', {
      status: 404,
      body: { message: 'Unknown Message' },
    });

    const outcome = await h.saved({ config: armed() });

    expect(outcome).toEqual({
      action: 'reconciled',
      changes: [{ channelId: TRAP, did: 'posted' }],
    });
    expect(h.rest.posted).toHaveLength(2);
    expect(h.remembered()[TRAP]?.messageId).toBe(h.rest.posted[1] as string);
    expect(h.remembered()[TRAP]?.messageId).not.toBe(gone);
  });

  test('disarming a row takes its notice down and forgets it', async () => {
    const h = harness();

    await h.saved({ config: armed() });
    const messageId = h.remembered()[TRAP]?.messageId;

    const outcome = await h.saved({
      config: { enabled: true, channels: [trap({ enabled: false })] },
    });

    expect(outcome).toEqual({
      action: 'reconciled',
      changes: [{ channelId: TRAP, did: 'removed' }],
    });
    expect(h.deleted()).toEqual([`${TRAP}/${messageId}`]);
    expect(h.remembered()).toEqual({});
  });

  test('a channel dropped from the list has its notice deleted too', async () => {
    const h = harness();
    h.notices.seed(GUILD, { [TRAP]: { messageId: REMEMBERED, postedAt: 1_700_000_000_000 } });

    const outcome = await h.saved({ config: { enabled: true, channels: [] } });

    expect(outcome).toEqual({
      action: 'reconciled',
      changes: [{ channelId: TRAP, did: 'removed' }],
    });
    expect(h.deleted()).toEqual([`${TRAP}/${REMEMBERED}`]);
    expect(h.remembered()).toEqual({});
    expect(h.rest.posted).toEqual([]);
  });

  test('switching the whole module off takes every notice down, on the event alone', async () => {
    const h = harness();

    await h.saved({ config: two() });
    const first = h.remembered()[TRAP]?.messageId;
    const second = h.remembered()[LOUNGE]?.messageId;

    const outcome = await h.saved({ config: two(), enabledAfter: false });

    expect(outcome).toEqual({
      action: 'reconciled',
      changes: [
        { channelId: TRAP, did: 'removed' },
        { channelId: LOUNGE, did: 'removed' },
      ],
    });
    expect(h.deleted()).toEqual([`${TRAP}/${first}`, `${LOUNGE}/${second}`]);
    expect(h.remembered()).toEqual({});
  });

  test('another module’s save is not ours to act on', async () => {
    const h = harness();

    const outcome = await h.saved({ config: armed(), moduleId: 'verification' });

    expect(outcome).toEqual({ action: 'ignored', reason: 'another module was saved' });
    expect(h.calls()).toEqual([]);
    expect(h.remembered()).toEqual({});
  });

  test('a save with nothing armed touches Discord not at all', async () => {
    const h = harness();

    const outcome = await h.saved({ config: { enabled: true, channels: [] } });

    expect(outcome).toEqual({ action: 'reconciled', changes: [] });
    expect(h.calls()).toEqual([]);
  });

  // The window is one setting for the whole module now, so both notices describe the same one.
  // The v1 shape that let them differ is what liftStoredConfig collapses.
  test('two armed channels get two notices, both describing the one delete window', async () => {
    const h = harness();

    const outcome = await h.saved({
      config: {
        enabled: true,
        deleteMessageSeconds: 86_400,
        channels: [trap(), trap({ channelId: LOUNGE })],
      },
    });

    expect(outcome).toEqual({
      action: 'reconciled',
      changes: [
        { channelId: TRAP, did: 'posted' },
        { channelId: LOUNGE, did: 'posted' },
      ],
    });
    expect(h.calls()).toEqual([
      `POST /channels/${TRAP}/messages`,
      `POST /channels/${LOUNGE}/messages`,
    ]);
    expect(texts(h.componentsIn(TRAP)).join('\n')).toContain(
      'Everything you posted in the last day is deleted with you.',
    );
    expect(texts(h.componentsIn(LOUNGE)).join('\n')).toContain(
      'Everything you posted in the last day is deleted with you.',
    );
    expect(h.remembered()[TRAP]?.messageId).not.toBe(h.remembered()[LOUNGE]?.messageId as string);
  });

  test('a deployment without the notice store refuses, and names the port it wants', async () => {
    const h = harness({ notices: false });

    const outcome = await h.saved({ config: armed() });

    expect(outcome).toEqual({ action: 'refused', reason: 'the notice port is unbound' });
    expect(h.calls()).toEqual([]);
    expect(h.said('error').at(-1)).toContain('notices: new RedisNoticeStore(redis)');
  });

  test('a post Discord refuses remembers nothing, so the next save posts instead of editing', async () => {
    const h = harness();
    const outage = { on: true };

    h.rest.fail((call) => outage.on && call.method === 'POST', {
      status: 403,
      body: { message: 'Missing Access' },
    });

    const refused = await h.saved({ config: armed() });

    expect(refused).toEqual({
      action: 'reconciled',
      changes: [{ channelId: TRAP, did: 'failed' }],
    });
    expect(h.remembered()).toEqual({});
    expect(h.said('error').at(-1)).toContain('could not post the notice');

    outage.on = false;
    const retried = await h.saved({ config: armed() });

    expect(retried).toEqual({
      action: 'reconciled',
      changes: [{ channelId: TRAP, did: 'posted' }],
    });
    expect(h.calls().filter((call) => call.startsWith('PATCH'))).toEqual([]);
    expect(h.remembered()[TRAP]?.messageId).toBe(h.rest.posted[0] as string);
  });

  test('is not a moderation case — nobody was acted on', async () => {
    const h = harness();

    await h.saved({ config: armed() });

    expect(h.cases()).toEqual([]);
  });
});

describe('the notice is a Components V2 message', () => {
  test('the send sets the V2 flag and carries no content and no embeds', async () => {
    const h = harness();

    await h.saved({ config: armed() });

    const body = h.sentIn(TRAP).at(-1);
    expect(body?.flags).toBe(MESSAGE_FLAG_IS_COMPONENTS_V2);
    expect(body?.content).toBeUndefined();
    expect(body?.embeds).toBeUndefined();
    expect(h.componentsIn(TRAP).length).toBeGreaterThan(0);
  });

  test('the payload the executor was handed passes the schema enforcing V2 exclusivity', async () => {
    const h = harness();

    await h.saved({ config: armed() });

    const send = h.requests().find((request) => request.kind === 'send');
    const parsed = sendPayloadSchema.safeParse(send?.payload);

    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  test('the edit carries no flags at all — Discord will not take the V2 bit off', async () => {
    const h = harness();

    await h.saved({ config: armed() });
    await h.saved({ config: armed() });

    const edit = h.requests().find((request) => request.kind === 'edit_message');
    expect(edit?.payload).not.toHaveProperty('flags');

    const body = h.editedIn(TRAP).at(-1);
    expect(body).not.toBeUndefined();
    expect(body).not.toHaveProperty('flags');
    expect(editMessagePayloadSchema.safeParse(edit?.payload).success).toBe(true);
  });

  test('mentions nobody, so a trap notice cannot ping the server', async () => {
    const h = harness();

    await h.saved({ config: armed() });

    expect(h.sentIn(TRAP).at(-1)?.allowed_mentions).toEqual({ parse: [] });
  });

  test('is one container carrying the warning and the counter together', async () => {
    const h = harness();

    await h.saved({ config: armed() });

    const containers = h.componentsIn(TRAP);
    expect(containers.map((node) => node.type)).toEqual([ComponentType.Container]);
    expect(containers[0]?.accent_color).toBe(HONEYPOT_COLOUR);
  });

  test('shouts the one thing a reader must not do', async () => {
    const h = harness();

    await h.saved({ config: armed() });

    const said = texts(h.componentsIn(TRAP));
    expect(said[0]).toBe('## 🍯  DO NOT SEND MESSAGES IN THIS CHANNEL');
    expect(said.join('\n')).toContain('There is never a reason to post here.');
  });

  test('holds an action row with exactly one button, inside that same container', async () => {
    const h = harness();

    await h.saved({ config: armed() });

    const row = children(h.componentsIn(TRAP)[0]).find(
      (node) => node.type === ComponentType.ActionRow,
    );
    expect(row?.type).toBe(ComponentType.ActionRow);
    expect(children(row)).toHaveLength(1);
    expect(children(row)[0]?.type).toBe(ComponentType.Button);
    expect(children(row)[0]?.style).toBe(ButtonStyle.Secondary);
    expect(children(row)[0]?.emoji).toEqual({ name: '🍯' });
  });

  test('the button’s custom_id round-trips back to this module, this action, this channel', async () => {
    const h = harness();

    await h.saved({ config: armed() });

    const customId = buttons(h.componentsIn(TRAP))[0]?.custom_id;
    expect(parseCustomId(customId)).toEqual({
      moduleId: MODULE_ID,
      action: STATS_ACTION,
      args: [TRAP],
    });
  });

  test('each channel’s button carries its own channel, not the first one’s', async () => {
    const h = harness();

    await h.saved({ config: two() });

    expect(parseCustomId(buttons(h.componentsIn(LOUNGE))[0]?.custom_id)?.args).toEqual([LOUNGE]);
  });
});

describe('the label on the button', () => {
  test('every action gets its own noun, so the count is never mislabelled', () => {
    expect(HONEYPOT_ACTIONS.map((action) => caughtLabel(action, 4))).toEqual([
      'Softbans: 4',
      'Bans: 4',
      'Kicks: 4',
      'Timeouts: 4',
      'Warnings: 4',
      'Caught: 4',
    ]);
  });

  test('is derived from the action, so a softban trap never says Kicks', () => {
    const softban = buildNoticeComponents(config({ action: 'softban' }), TRAP, 4, 'free');
    const kick = buildNoticeComponents(config({ action: 'kick' }), TRAP, 4, 'free');

    if (!softban.ok || !kick.ok) throw new Error('the notice would not build');

    expect(labelOf(softban.components)).toBe('Softbans: 4');
    expect(String(labelOf(softban.components))).not.toContain('Kick');
    expect(labelOf(kick.components)).toBe('Kicks: 4');
  });

  test('reaches Discord named for the row it was built from, for every action', async () => {
    const rendered: string[] = [];

    for (const action of HONEYPOT_ACTIONS) {
      const h = harness();
      h.stats.seed(GUILD, TRAP, [caught(h.now())]);

      await h.saved({ config: armed({ action }) });
      rendered.push(String(labelOf(h.componentsIn(TRAP))));
    }

    expect(rendered).toEqual([
      'Softbans: 1',
      'Bans: 1',
      'Kicks: 1',
      'Timeouts: 1',
      'Warnings: 1',
      'Caught: 1',
    ]);
  });

  test('counts what the stats store says this trap has caught', async () => {
    const h = harness();
    h.stats.seed(GUILD, TRAP, [
      caught(h.now() - 4),
      caught(h.now() - 3),
      caught(h.now() - 2),
      caught(h.now() - 1),
    ]);

    await h.saved({ config: armed() });

    expect(labelOf(h.componentsIn(TRAP))).toBe('Softbans: 4');
  });

  test('counts only the channel it sits in', async () => {
    const h = harness();
    h.stats.seed(GUILD, TRAP, [caught(h.now())]);

    await h.saved({ config: two() });

    expect(labelOf(h.componentsIn(TRAP))).toBe('Softbans: 1');
    expect(labelOf(h.componentsIn(LOUNGE))).toBe('Softbans: 0');
  });

  test('a save re-renders it with the number as it stands now', async () => {
    const h = harness();

    await h.saved({ config: armed() });
    expect(labelOf(h.componentsIn(TRAP))).toBe('Softbans: 0');

    h.stats.seed(GUILD, TRAP, [caught(h.now())]);
    await h.saved({ config: armed() });

    expect(labelOf(h.componentsIn(TRAP))).toBe('Softbans: 1');
  });
});

describe('what the notice promises about the channel it sits in', () => {
  test('names the consequence that row is configured with', async () => {
    const h = harness();

    await h.saved({ config: armed({ action: 'timeout' }) });

    expect(texts(h.componentsIn(TRAP)).join('\n')).toContain(
      '**you are timed out and cannot speak**',
    );
  });

  test('promises no purge for an action that deletes nothing', async () => {
    const h = harness();

    await h.saved({ config: armed({ action: 'kick' }) });

    const said = texts(h.componentsIn(TRAP)).join('\n');
    expect(said).toContain('**you are removed from the server**');
    expect(said).not.toContain('is deleted with you');
  });

  test('promises no purge for a ban whose window purges nothing', async () => {
    const h = harness();

    await h.saved({ config: armed({ action: 'ban', deleteMessageSeconds: 0 }) });

    expect(texts(h.componentsIn(TRAP)).join('\n')).not.toContain('is deleted with you');
  });
});

describe('the switches on the warning message', () => {
  test('turning the notice off takes every one already posted down', async () => {
    const h = harness();

    await h.saved({ config: two() });
    const first = h.remembered()[TRAP]?.messageId;
    const second = h.remembered()[LOUNGE]?.messageId;

    const outcome = await h.saved({ config: { ...two(), postNotice: false } });

    expect(outcome).toEqual({
      action: 'reconciled',
      changes: [
        { channelId: TRAP, did: 'removed' },
        { channelId: LOUNGE, did: 'removed' },
      ],
    });
    expect(h.deleted()).toEqual([`${TRAP}/${first}`, `${LOUNGE}/${second}`]);
    expect(h.remembered()).toEqual({});
  });

  test('with the notice off, a save posts nothing at all', async () => {
    const h = harness();

    const outcome = await h.saved({ config: { ...armed(), postNotice: false } });

    expect(outcome).toEqual({ action: 'reconciled', changes: [] });
    expect(h.calls()).toEqual([]);
  });

  test('turning the counter off posts the warning with no button', async () => {
    const h = harness();

    await h.saved({ config: { ...armed(), noticeCounterButton: false } });

    const nodes = h.componentsIn(TRAP);

    expect(buttons(nodes)).toEqual([]);
    expect(texts(nodes).join('\n')).toContain('DO NOT SEND MESSAGES IN THIS CHANNEL');
  });

  test('the counter is on by default, and carries this trap’s own channel', async () => {
    const h = harness();

    await h.saved({ config: armed() });

    const pressed = buttons(h.componentsIn(TRAP))[0];

    expect(parseCustomId(pressed?.custom_id)).toEqual({
      moduleId: MODULE_ID,
      action: STATS_ACTION,
      args: [TRAP],
    });
  });

  test('hiding what a honeypot is still warns, without naming the trap', async () => {
    const h = harness();

    await h.saved({ config: { ...armed(), hideWhatIsAHoneypot: true } });

    const said = texts(h.componentsIn(TRAP)).join('\n');

    expect(said).not.toContain('spam bots');
    expect(said).toContain('There is never a reason to post here.');
    expect(said).toContain('you are removed from the server and let straight back in');
  });
});

describe('a guild that may not author its own layout', () => {
  const CUSTOM = {
    mentions: { everyone: false, roles: false, users: false },
    embeds: [],
    components: [],
    v2: [{ kind: 'container' as const, children: [{ kind: 'text' as const, content: 'Ours.' }] }],
  };

  test('a free guild posts the built-in layout', async () => {
    const h = harness();

    await h.saved({ config: { ...armed(), noticeLayout: CUSTOM }, tier: 'free' });

    expect(texts(h.componentsIn(TRAP)).join('\n')).toContain('DO NOT SEND MESSAGES');
  });

  test('a paying guild posts its own', async () => {
    const h = harness();

    await h.saved({ config: { ...armed(), noticeLayout: CUSTOM }, tier: 'plus' });

    expect(texts(h.componentsIn(TRAP)).join('\n')).toBe('Ours.');
  });

  // The substitution is render-only. Nothing on the write path may reach for it, or one unrelated
  // toggle after a downgrade would overwrite work the admin did while they were paying.
  test('what the free guild has stored is untouched by the save', async () => {
    const h = harness();
    const config = { ...armed(), noticeLayout: CUSTOM };

    await h.saved({ config, tier: 'free' });

    expect(config.noticeLayout).toBe(CUSTOM);
    expect(CUSTOM.v2[0]?.children[0]?.content).toBe('Ours.');
  });
});

function layout(...children: ContainerChild[]): HoneypotLayout {
  return {
    mentions: { everyone: false, roles: false, users: false },
    embeds: [],
    components: [],
    v2: [{ kind: 'container', children }],
  };
}

function namedServer(h: Harness, name: string): { reads: () => number } {
  const store = h.deps.guildState;
  if (!store) throw new Error('the harness has no guild state');

  let reads = 0;
  const named: GuildStateStore = {
    ...store,
    get: async (guildId) => {
      reads += 1;
      const state = await store.get(guildId);
      return state === null ? null : { ...state, name };
    },
  };

  h.deps.guildState = named;
  return { reads: () => reads };
}

function protonProfile(h: Harness): { reads: () => number } {
  let reads = 0;
  const environment: PlaceholderEnvironment = {
    applicationId: BOT,
    bot: async () => {
      reads += 1;
      return { id: BOT, name: 'Proton', avatarHash: null, supportUrl: PROTON_SUPPORT_URL };
    },
    server: async (guildId) => ({ id: guildId }),
    user: async (userId) => ({
      id: userId,
      username: 'tester',
      globalName: 'Tester',
      avatarHash: null,
    }),
    now: () => h.now(),
  };

  h.deps.placeholders = environment;
  return { reads: () => reads };
}

describe('placeholders in the warning message', () => {
  const FILLED = layout({
    kind: 'text',
    content:
      '{server.name} watches {channel.mention} (#{channel.name}), which has caught ' +
      '{honeypot.caught}. Kept by {bot.name}.',
  });

  test('a paying guild’s notice fills in the server, the channel, the count and Proton', async () => {
    const h = harness();
    namedServer(h, 'Proton HQ');
    protonProfile(h);
    h.stats.seed(GUILD, TRAP, [caught(h.now())]);

    await h.saved({ config: { ...armed(), noticeLayout: FILLED }, tier: 'plus' });

    expect(texts(h.componentsIn(TRAP))[0]).toBe(
      `Proton HQ watches <#${TRAP}> (#do-not-post), which has caught 1. Kept by Proton.`,
    );
  });

  test('reads the server and Proton’s profile only when the notice uses them', async () => {
    const h = harness();
    const server = namedServer(h, 'Proton HQ');
    const profile = protonProfile(h);

    await h.saved({ config: armed(), tier: 'plus' });

    expect(server.reads()).toBe(0);
    expect(profile.reads()).toBe(0);
  });

  test('the count moving on a catch keeps what the notice filled in', async () => {
    const h = harness();
    namedServer(h, 'Proton HQ');
    protonProfile(h);
    const settings = { ...armed(), noticeLayout: FILLED };

    await h.saved({ config: settings, tier: 'plus' });
    await h.trip({ config: settings, tier: 'plus' });

    const edited = h.editedIn(TRAP).at(-1);
    const nodes = Array.isArray(edited?.components) ? (edited.components as Node[]) : [];

    expect(texts(nodes)[0]).toBe(
      `Proton HQ watches <#${TRAP}> (#do-not-post), which has caught 1. Kept by Proton.`,
    );
    expect(labelOf(nodes)).toBe('Softbans: 1');
  });

  test('a notice that cannot be filled in is not posted, and the log names the field', async () => {
    const h = harness();
    const unnamed = layout(
      { kind: 'text', content: 'Read the rules.' },
      {
        kind: 'row',
        row: {
          kind: 'buttons',
          buttons: [
            { key: 'rules', style: 'link', label: '{server.name}', url: 'https://example.com/' },
          ],
        },
      },
    );

    const outcome = await h.saved({ config: { ...armed(), noticeLayout: unnamed }, tier: 'plus' });

    expect(outcome).toEqual({
      action: 'reconciled',
      changes: [{ channelId: TRAP, did: 'failed' }],
    });
    expect(h.rest.posted).toEqual([]);

    const said = h.said('error').join(' ');
    expect(said).toContain('noticeLayout.v2.0.children.1.row.buttons.0.label');
    expect(said).toContain('{server.name}');
  });

  test('an appeal link typed into the notice posts nothing, and no link is minted for it', async () => {
    const h = harness();
    let secretReads = 0;

    Object.defineProperty(h.deps, 'linkSecret', {
      configurable: true,
      enumerable: true,
      get: () => {
        secretReads += 1;
        return 'a'.repeat(32);
      },
    });

    await h.saved({
      config: {
        ...armed({ action: 'ban', appealPanelId: 'ban-form' }),
        noticeLayout: layout({ kind: 'text', content: 'Appeal: {honeypot.appeal_url}' }),
      },
      tier: 'plus',
    });

    expect(texts(h.componentsIn(TRAP))[0]).toBe('Appeal: ');
    expect(secretReads).toBe(0);
  });

  test('a free guild posts the built-in notice and reads nothing for its stored one', async () => {
    const h = harness();
    const server = namedServer(h, 'Proton HQ');
    const profile = protonProfile(h);

    await h.saved({ config: { ...armed(), noticeLayout: FILLED }, tier: 'free' });

    expect(texts(h.componentsIn(TRAP))[0]).toBe('## 🍯  DO NOT SEND MESSAGES IN THIS CHANNEL');
    expect(server.reads()).toBe(0);
    expect(profile.reads()).toBe(0);
  });
});
