import { describe, test } from 'bun:test';
import fc from 'fast-check';
import { type ActionKind, requiredPermissionsFor } from '../../src/actions/kinds.ts';
import { sendPayloadSchema } from '../../src/actions/payloads.ts';
import { runPrechecks } from '../../src/actions/prechecks.ts';
import { resolvePrecheckContext } from '../../src/actions/resolve-context.ts';
import { toRestCall } from '../../src/actions/rest-mapping.ts';
import type { ActionRequest } from '../../src/actions/types.ts';
import type { GuildState, GuildStateStore } from '../../src/guild-state/types.ts';
import { invitePermissionsFor } from '../../src/modules/registry.ts';
import { has, Permissions } from '../../src/permissions/bits.ts';

const GUILD = '900000000000000001';
const OWNER = '200000000000000001';
const BOT = '300000000000000001';
const MEMBER = '100000000000000001';
const CHANNEL = '500000000000000001';
const BOT_ROLE = '410000000000000005';
const MEMBER_ROLE = '410000000000000001';

const permissionBits = fc.bigInt({ min: 0n, max: (1n << 53n) - 1n });
const snowflake = fc.bigInt({ min: 10n ** 16n, max: 10n ** 19n - 1n }).map(String);

const sendPayload = fc.record({
  channelId: fc.constant(CHANNEL),
  content: fc.string({ minLength: 1, maxLength: 200 }),
  embeds: fc.option(fc.constant([{ title: 'Rules' }]), { nil: undefined }),
  poll: fc.option(
    fc.constant({ question: { text: 'Which map?' }, answers: [{ poll_media: { text: 'Dust' } }] }),
    { nil: undefined },
  ),
  replyToMessageId: fc.option(snowflake, { nil: undefined }),
});

type Target = 'owner' | 'bot' | 'member';

const TARGET_IDS: Record<Target, string> = { owner: OWNER, bot: BOT, member: MEMBER };

const renaming = fc.record({
  noise: permissionBits,
  grantsNicknames: fc.boolean(),
  administrator: fc.boolean(),
  botPosition: fc.integer({ min: 1, max: 20 }),
  memberPosition: fc.integer({ min: 1, max: 20 }),
  target: fc.constantFrom<Target>('owner', 'bot', 'member'),
  appPermissions: permissionBits,
  nickname: fc.constantFrom<string | null>('[AFK] Tester', null),
});

function request(kind: ActionKind, payload: unknown, targetId?: string): ActionRequest {
  return {
    guildId: GUILD,
    moduleId: 'afk',
    kind,
    actorId: MEMBER,
    dryRun: false,
    idempotencyKey: 'k',
    payload,
    ...(targetId ? { targetId } : {}),
  };
}

function guild(
  botPermissions: bigint,
  botPosition: number,
  memberPosition: number,
): GuildStateStore {
  const state: GuildState = {
    guildId: GUILD,
    ownerId: OWNER,
    everyoneRoleId: GUILD,
    roles: new Map([
      [GUILD, { id: GUILD, permissions: 0n, position: 0 }],
      [BOT_ROLE, { id: BOT_ROLE, permissions: botPermissions, position: botPosition }],
      [MEMBER_ROLE, { id: MEMBER_ROLE, permissions: 0n, position: memberPosition }],
    ]),
    botRoleIds: [BOT_ROLE],
    channels: new Map([[CHANNEL, { id: CHANNEL, parentId: null, overwrites: [] }]]),
    updatedAt: Date.now(),
  };

  return {
    get: async () => state,
    put: async () => undefined,
    patch: async () => undefined,
    delete: async () => undefined,
  };
}

function expectedRefusal(c: {
  grantsNicknames: boolean;
  administrator: boolean;
  target: Target;
  botPosition: number;
  memberPosition: number;
}): string | null {
  if (!c.administrator && !c.grantsNicknames) return 'missing_permission';
  if (c.target === 'bot') return 'target_is_self';
  if (c.target === 'owner') return 'target_is_owner';
  return c.memberPosition >= c.botPosition ? 'role_hierarchy' : null;
}

describe('a reply asks for Read Message History', () => {
  test('exactly when the send carries replyToMessageId, inside a thread or out', () => {
    fc.assert(
      fc.property(sendPayload, fc.boolean(), (payload, inThread) => {
        const required = requiredPermissionsFor('send', payload, inThread);

        return (
          sendPayloadSchema.safeParse(payload).success &&
          has(required, Permissions.ReadMessageHistory) === (payload.replyToMessageId !== undefined)
        );
      }),
      { numRuns: 300 },
    );
  });

  test('a reply adds that one bit to the message it would otherwise be, and takes nothing away', () => {
    fc.assert(
      fc.property(sendPayload, snowflake, fc.boolean(), (payload, messageId, inThread) => {
        const plain = requiredPermissionsFor(
          'send',
          { ...payload, replyToMessageId: undefined },
          inThread,
        );
        const reply = requiredPermissionsFor(
          'send',
          { ...payload, replyToMessageId: messageId },
          inThread,
        );

        return (
          !has(plain, Permissions.ReadMessageHistory) &&
          reply === (plain | Permissions.ReadMessageHistory)
        );
      }),
      { numRuns: 300 },
    );
  });

  test('the precheck demands it exactly when Discord is sent a message_reference', () => {
    fc.assert(
      fc.property(sendPayload, (payload) => {
        const result = toRestCall(request('send', payload));
        if (!('call' in result)) return false;

        const referenced = 'message_reference' in (result.call.body as Record<string, unknown>);
        return (
          referenced ===
          has(requiredPermissionsFor('send', payload), Permissions.ReadMessageHistory)
        );
      }),
      { numRuns: 300 },
    );
  });

  test('the invite covers everything a send outside a thread can require', () => {
    fc.assert(
      fc.property(sendPayload, (payload) =>
        has(invitePermissionsFor('send'), requiredPermissionsFor('send', payload)),
      ),
      { numRuns: 300 },
    );
  });
});

describe('set_member_nickname is refused exactly where Discord refuses a rename', () => {
  test('Manage Nicknames first, then Proton itself, then the owner, then anyone ranked at or above Proton', async () => {
    await fc.assert(
      fc.asyncProperty(renaming, async (c) => {
        const ranked = Permissions.ManageNicknames | Permissions.Administrator;
        const botPermissions =
          (c.noise & ~ranked) |
          (c.grantsNicknames ? Permissions.ManageNicknames : 0n) |
          (c.administrator ? Permissions.Administrator : 0n);

        const result = await resolvePrecheckContext(
          { store: guild(botPermissions, c.botPosition, c.memberPosition), botUserId: BOT },
          request('set_member_nickname', { nickname: c.nickname }, TARGET_IDS[c.target]),
          { channelId: CHANNEL, appPermissions: c.appPermissions, targetRoleIds: [MEMBER_ROLE] },
        );
        if (!('context' in result)) return false;

        const failure = runPrechecks(result.context);
        const expected = expectedRefusal(c);
        if ((failure?.code ?? null) !== expected) return false;
        if (expected !== 'missing_permission') return true;

        const reason = failure?.humanReason ?? '';
        return (
          reason.includes('Manage Nicknames') &&
          reason.includes('this server') &&
          !reason.includes('<#')
        );
      }),
      { numRuns: 300 },
    );
  });

  test('needs Manage Nicknames alone whatever the nickname or thread, and the invite asks for it', () => {
    fc.assert(
      fc.property(
        fc.option(fc.string({ minLength: 1, maxLength: 32 }), { nil: null }),
        fc.boolean(),
        (nickname, inThread) => {
          const required = requiredPermissionsFor('set_member_nickname', { nickname }, inThread);

          return (
            required === Permissions.ManageNicknames &&
            has(invitePermissionsFor('set_member_nickname'), required)
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});
