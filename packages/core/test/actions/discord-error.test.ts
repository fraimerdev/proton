import { describe, expect, test } from 'bun:test';
import type { CaseInput, CaseRecorder } from '../../src/actions/case-recorder.ts';
import type { DedupeStore } from '../../src/actions/dedupe.ts';
import {
  type DiscordErrorContext,
  describeDiscordError,
  discordDetail,
  refusalDetail,
} from '../../src/actions/discord-error.ts';
import { DefaultActionExecutor } from '../../src/actions/executor.ts';
import { type ActionKind, requiredPermissionsFor } from '../../src/actions/kinds.ts';
import type { PrecheckInput } from '../../src/actions/prechecks.ts';
import { resolvePrecheckContext } from '../../src/actions/resolve-context.ts';
import type {
  RestProxyClient,
  RestRequestOptions,
  RestResponse,
} from '../../src/actions/rest-client.ts';
import type { GuildState } from '../../src/guild-state/types.ts';
import { newId } from '../../src/ids.ts';
import { Permissions } from '../../src/permissions/bits.ts';

const GUILD = '900000000000000001';
const BOT = '300000000000000000';
const OWNER = '200000000000000000';
const MEMBER = '400000000000000000';
const CHANNEL = '500000000000000000';
const CATEGORY = '510000000000000000';
const THREAD_PARENT = '520000000000000000';
const ROLE = '700000000000000000';

const TODAY_403 =
  "Discord refused that. It's usually a missing permission, or a role ranked above Proton's.";

function resolvedFor(
  kind: ActionKind,
  payload?: unknown,
  overrides: Partial<PrecheckInput> = {},
): PrecheckInput {
  return {
    guildId: GUILD,
    guildOwnerId: OWNER,
    botUserId: BOT,
    botHighestRolePosition: 10,
    botChannelPermissions: 0n,
    requiredPermissions: requiredPermissionsFor(kind, payload),
    ...overrides,
  };
}

function describeFor(
  status: number,
  body: unknown,
  kind: ActionKind,
  payload?: unknown,
  overrides: Partial<PrecheckInput> = {},
): string {
  const context: DiscordErrorContext = {
    status,
    body,
    request: { kind, payload },
    resolved: resolvedFor(kind, payload, overrides),
  };
  return describeDiscordError(context);
}

const MISSING_PERMISSIONS = { code: 50013, message: 'Missing Permissions' };
const MISSING_ACCESS = { code: 50001, message: 'Missing Access' };

describe('a 403 with code 50013 names what Discord wanted', () => {
  test('a ban names Ban Members, the whole server and the role order', () => {
    const reason = describeFor(403, MISSING_PERMISSIONS, 'ban', undefined, {
      target: { id: MEMBER, highestRolePosition: 1 },
    });

    expect(reason).toContain('Ban Members');
    expect(reason).toContain('this server');
    expect(reason).toContain('highest role');
  });

  test('without a ranked target the role order is left out', () => {
    const reason = describeFor(403, MISSING_PERMISSIONS, 'kick', undefined, {
      target: { id: MEMBER, highestRolePosition: 0 },
      hierarchy: false,
    });

    expect(reason).toContain('Kick Members');
    expect(reason).not.toContain('highest role');
    expect(reason.endsWith('this server.')).toBe(true);
  });

  test('a ban of somebody not in the server leaves the role order out', () => {
    const reason = describeFor(403, MISSING_PERMISSIONS, 'ban', undefined, {
      target: { id: MEMBER, highestRolePosition: 0 },
      targetIsMember: false,
    });

    expect(reason).toContain('Ban Members');
    expect(reason).not.toContain('highest role');
  });

  test('add_role names the role being handed out, not the member', () => {
    const reason = describeFor(403, MISSING_PERMISSIONS, 'add_role', {
      userId: MEMBER,
      roleId: ROLE,
    });

    expect(reason).toContain(`<@&${ROLE}>`);
    expect(reason).toContain('Manage Roles');
    expect(reason).toContain("below Proton's highest role");
  });

  test('delete_role names the role the precheck resolved', () => {
    const reason = describeFor(403, MISSING_PERMISSIONS, 'delete_role', undefined, {
      role: { id: ROLE, position: 3 },
    });

    expect(reason).toContain(`<@&${ROLE}>`);
  });

  test('a timeout mentions Discord refusing an Administrator target', () => {
    const reason = describeFor(403, MISSING_PERMISSIONS, 'timeout', undefined, {
      target: { id: MEMBER, highestRolePosition: 1 },
    });

    expect(reason).toContain('Timeout Members');
    expect(reason).toContain('Administrator');
  });

  test('an untimeout speaks of changing the timeout, not of applying one', () => {
    const reason = describeFor(403, MISSING_PERMISSIONS, 'untimeout', undefined, {
      target: { id: MEMBER, highestRolePosition: 1 },
    });

    expect(reason).toContain('Timeout Members');
    expect(reason).toContain("won't change the timeout of a member who has Administrator");
    expect(reason).not.toContain("won't time out");
  });

  test('a channel created in a category names the category as well as the server', () => {
    const reason = describeFor(403, MISSING_PERMISSIONS, 'create_channel', {
      name: 'ticket-1',
      type: 0,
      parentId: CATEGORY,
    });

    expect(reason).toContain('Manage Channels');
    expect(reason).toContain(`<#${CATEGORY}> category`);
    expect(reason).toContain('this server');
  });

  test('a channel moved into a category names the channel and the category', () => {
    const reason = describeFor(
      403,
      MISSING_PERMISSIONS,
      'edit_channel',
      { channelId: CHANNEL, parentId: CATEGORY },
      { channelId: CHANNEL },
    );

    expect(reason).toContain(`<#${CATEGORY}> category`);
    expect(reason).toContain(`<#${CHANNEL}>`);
  });

  test('a channel created outside a category names only the server', () => {
    const reason = describeFor(403, MISSING_PERMISSIONS, 'create_channel', {
      name: 'ticket-1',
      type: 0,
    });

    expect(reason).toContain('in this server,');
    expect(reason).not.toContain('category');
  });

  test('a message that is not a string does not hide the code', () => {
    const reason = describeFor(403, { code: 50013, message: null }, 'ban', undefined, {
      target: { id: MEMBER, highestRolePosition: 1 },
    });

    expect(reason).toContain('Ban Members');
  });

  test('an overwrite says Proton must hold the bits it sets', () => {
    const payload = {
      channelId: CHANNEL,
      overwriteId: MEMBER,
      type: 1,
      allow: String(Permissions.ViewChannel),
    };
    const reason = describeFor(403, MISSING_PERMISSIONS, 'set_channel_overwrite', payload, {
      channelId: CHANNEL,
    });

    expect(reason).toContain('overwrite');
    expect(reason).toContain('View Channel');
  });

  test('a send names Send Messages and the channel', () => {
    const reason = describeFor(403, MISSING_PERMISSIONS, 'send', undefined, {
      channelId: CHANNEL,
      requiredPermissions: Permissions.SendMessages,
    });

    expect(reason).toContain('Send Messages');
    expect(reason).toContain(`<#${CHANNEL}>`);
  });

  test('a kind that needs no permission keeps the general sentence', () => {
    expect(describeFor(403, MISSING_PERMISSIONS, 'interaction_followup')).toBe(TODAY_403);
  });
});

describe('a 403 with code 50001 says what Proton cannot see', () => {
  test('a send names View Channel in that channel', () => {
    const reason = describeFor(403, MISSING_ACCESS, 'send', undefined, { channelId: CHANNEL });

    expect(reason).toContain('View Channel');
    expect(reason).toContain(`<#${CHANNEL}>`);
  });

  test('a thread points at the channel it takes its permissions from', () => {
    const reason = describeFor(403, MISSING_ACCESS, 'send', undefined, {
      channelId: CHANNEL,
      threadParentId: THREAD_PARENT,
    });

    expect(reason).toContain(`<#${THREAD_PARENT}>`);
    expect(reason).toContain('View Channel');
  });

  test('a channel created in a category names the category', () => {
    const reason = describeFor(403, MISSING_ACCESS, 'create_channel', {
      name: 'ticket-1',
      type: 0,
      parentId: CATEGORY,
    });

    expect(reason).toContain(`<#${CATEGORY}>`);
    expect(reason).toContain('Manage Channels');
  });

  test('a channel moved into a category names both', () => {
    const reason = describeFor(
      403,
      MISSING_ACCESS,
      'edit_channel',
      { channelId: CHANNEL, parentId: CATEGORY },
      { channelId: CHANNEL },
    );

    expect(reason).toContain(`<#${CHANNEL}>`);
    expect(reason).toContain(`<#${CATEGORY}>`);
  });

  test('a guild-wide kind never claims Proton has left the server', () => {
    const reason = describeFor(403, MISSING_ACCESS, 'create_role', { name: 'Muted' });

    expect(reason).toContain('channel or category');
    expect(reason).not.toContain('no longer in this server');
  });
});

describe('Discord codes that are not a permission', () => {
  test('closed DMs name no permission and blame the user’s own setting', () => {
    const reason = describeFor(
      403,
      { code: 50007, message: 'Cannot send messages to this user' },
      'send',
    );

    expect(reason).toContain("That user doesn't accept DMs");
    expect(reason).not.toContain('permission');
  });

  test('a user who shares no server with Proton is not said to have closed their DMs', () => {
    const reason = describeFor(
      403,
      {
        code: 50278,
        message: 'Cannot send messages to this user due to having no mutual guilds',
      },
      'send',
    );

    expect(reason).toContain('no longer shares a server with Proton');
    expect(reason).toContain('DMs');
    expect(reason).not.toContain("doesn't accept");
    expect(reason).not.toContain('permission');
  });

  test('an unban of somebody not banned stays true if a retried unban already landed', () => {
    const reason = describeFor(404, { code: 10026, message: 'Unknown Ban' }, 'unban');

    expect(reason).toContain("isn't banned");
    expect(reason).toContain('nothing left to lift');
    expect(reason).not.toContain('was nothing');
  });

  test('the server channel limit names 500', () => {
    expect(describeFor(400, { code: 30013 }, 'create_channel')).toContain('500');
  });

  test.each([
    ['a move', { userId: MEMBER, channelId: CHANNEL }],
    ['a disconnect', { userId: MEMBER, channelId: null }],
  ])('%s of somebody out of voice says so without claiming nothing changed', (_, payload) => {
    const reason = describeFor(400, { code: 40032 }, 'move_member', payload);

    expect(reason).toContain('voice channel');
    expect(reason).toContain('move or disconnect');
    expect(reason).not.toContain('nothing was changed');
  });

  test('a full category is named from the form errors', () => {
    const body = {
      code: 50035,
      message: 'Invalid Form Body',
      errors: {
        parent_id: {
          _errors: [{ code: 'CHANNEL_PARENT_MAX_CHANNELS', message: 'Maximum channels reached' }],
        },
      },
    };

    expect(describeFor(400, body, 'create_channel')).toContain('50 channels');
  });

  test('a full AutoMod rule type is this server’s rules, not a Proton problem', () => {
    const body = {
      code: 50035,
      message: 'Invalid Form Body',
      errors: {
        trigger_type: {
          _errors: [
            {
              code: 'AUTO_MODERATION_MAX_RULES_OF_TYPE_EXCEEDED',
              message: 'Maximum number of rules of this type reached (1).',
            },
          ],
        },
      },
    };

    const reason = describeFor(400, body, 'automod_rule_create');

    expect(reason).toBe(
      "This server already has Discord's maximum number of AutoMod rules of that type, so no " +
        'rule was created.',
    );
  });

  test.each([
    [30003, '250 pinned'],
    [30005, '250 roles'],
    [30010, '20 different reactions'],
    [50083, 'archived'],
    [160005, 'locked'],
    [200000, 'AutoMod'],
    [240000, 'harmful-links'],
    [50034, '14 days'],
  ])('code %d is explained as a Discord limit', (code, phrase) => {
    const reason = describeFor(400, { code, message: 'x' }, 'send');

    expect(reason).toContain(phrase);
    expect(reason).not.toContain('Proton problem');
    expect(reason.endsWith('.')).toBe(true);
  });

  test('another code Discord refused is not blamed on Proton', () => {
    const reason = describeFor(400, { code: 30007, message: 'Maximum webhooks' }, 'send');

    expect(reason).toBe('Discord refused that, and nothing was changed.');
  });
});

describe('a refused direct message names no server setting', () => {
  const DM = { channelId: CHANNEL, content: 'hi', directMessage: true };
  const REFUSED_DM =
    "Discord wouldn't allow a DM to that user. No setting in this server changes that.";

  test.each([
    ['50013', MISSING_PERMISSIONS],
    ['50001', MISSING_ACCESS],
    ['40004', { code: 40004, message: 'Send messages has been temporarily disabled' }],
    ['no code', { message: 'Forbidden' }],
    ['a non-JSON body', '<html>403 Forbidden</html>'],
  ])('a 403 on a marked DM send with %s', (_, body) => {
    const reason = describeFor(403, body, 'send', DM);

    expect(reason).toBe(REFUSED_DM);
    expect(reason).not.toContain('permission');
    expect(reason).not.toContain('role');
  });

  test('a 403 opening the DM reads the same', () => {
    expect(describeFor(403, MISSING_PERMISSIONS, 'create_dm', { userId: MEMBER })).toBe(REFUSED_DM);
    expect(describeFor(403, undefined, 'create_dm', { userId: MEMBER })).toBe(REFUSED_DM);
  });

  test('closed DMs keep their own wording', () => {
    expect(describeFor(403, { code: 50007 }, 'send', DM)).toContain("That user doesn't accept DMs");
    expect(describeFor(403, { code: 50278 }, 'send', DM)).toContain(
      'no longer shares a server with Proton',
    );
  });

  test('a send the precheck judged as a server channel keeps the permission wording', () => {
    expect(
      describeFor(403, MISSING_PERMISSIONS, 'send', DM, {
        channelId: CHANNEL,
        requiredPermissions: Permissions.SendMessages,
      }),
    ).toContain('Send Messages');
    expect(
      describeFor(
        403,
        MISSING_PERMISSIONS,
        'send',
        { channelId: CHANNEL, content: 'hi' },
        {
          channelId: CHANNEL,
          requiredPermissions: Permissions.SendMessages,
        },
      ),
    ).toContain('Send Messages');
  });

  test('a DM refusal that is not a 403 keeps its status wording', () => {
    expect(describeFor(404, { code: 10003, message: 'Unknown Channel' }, 'send', DM)).toContain(
      'may have been deleted',
    );
  });
});

describe('the status alone, when there is no usable code', () => {
  test.each([
    ['a message without a code', { message: 'Missing Permissions' }],
    ['a string', '<html>403 Forbidden</html>'],
    ['nothing', undefined],
  ])('a 403 carrying %s keeps today’s sentence', (_, body) => {
    expect(describeFor(403, body, 'ban')).toBe(TODAY_403);
  });

  test('a 404 without a code says it may have gone', () => {
    expect(describeFor(404, undefined, 'kick')).toContain('may have left');
  });

  test('a 404 with a code nothing maps still says it may have gone', () => {
    expect(describeFor(404, { code: 10007, message: 'Unknown Member' }, 'kick')).toContain(
      'may have left',
    );
  });

  test('a plain 50035 and a 401 with code 0 are Proton problems', () => {
    expect(describeFor(400, { code: 50035, message: 'Invalid Form Body' }, 'send')).toContain(
      'Proton problem',
    );
    expect(describeFor(401, { code: 0, message: '401: Unauthorized' }, 'send')).toContain(
      'Proton problem',
    );
  });

  test('a 429 makes no promise to retry', () => {
    const reason = describeFor(429, { message: 'You are being rate limited.' }, 'send');

    expect(reason).toBe("Discord is rate limiting Proton right now, so that didn't go through.");
  });

  test('a 5xx says it may not have gone through', () => {
    expect(describeFor(502, { error: 'rest_proxy_upstream_failure' }, 'ban')).toContain(
      'may not have gone through',
    );
  });
});

describe('discordDetail', () => {
  test('flattens the form errors the way discord.js does, five at most', () => {
    const body = {
      code: 50035,
      message: 'Invalid Form Body',
      errors: {
        content: {
          _errors: [{ code: 'BASE_TYPE_MAX_LENGTH', message: 'Must be 2000 or fewer in length.' }],
        },
        embeds: {
          0: {
            title: { _errors: [{ code: 'BASE_TYPE_REQUIRED', message: 'This field is required' }] },
          },
        },
        a: { _errors: [{ code: 'A', message: 'a' }] },
        b: { _errors: [{ code: 'B', message: 'b' }] },
        c: { _errors: [{ code: 'C', message: 'c' }] },
        d: { _errors: [{ code: 'D', message: 'd' }] },
      },
    };

    const lines = discordDetail(body)?.split('\n') ?? [];

    expect(lines[0]).toBe('Invalid Form Body (50035)');
    expect(lines[1]).toBe('content[BASE_TYPE_MAX_LENGTH]: Must be 2000 or fewer in length.');
    expect(lines[2]).toBe('embeds[0].title[BASE_TYPE_REQUIRED]: This field is required');
    expect(lines).toHaveLength(6);
  });

  test('a body with no errors key still parses', () => {
    expect(discordDetail(MISSING_PERMISSIONS)).toBe('Missing Permissions (50013)');
  });

  test('keeps the message of a body without a code', () => {
    expect(discordDetail({ error: 'rest_proxy_upstream_failure', message: 'timed out' })).toBe(
      'timed out',
    );
  });

  test('a string or an empty body has no detail', () => {
    expect(discordDetail('<html>403 Forbidden</html>')).toBeUndefined();
    expect(discordDetail(undefined)).toBeUndefined();
  });

  test('a message that is not a string keeps the code', () => {
    expect(discordDetail({ code: 50013, message: null })).toBe('code 50013');
  });
});

describe('refusalDetail', () => {
  test('a Discord body is said to be Discord’s answer', () => {
    expect(refusalDetail(403, MISSING_PERMISSIONS)).toBe(
      'Discord answered 403: Missing Permissions (50013)',
    );
  });

  test('the proxy’s own 502 is not said to come from Discord', () => {
    const detail = refusalDetail(502, {
      error: 'rest_proxy_upstream_failure',
      message: 'The operation timed out.',
    });

    expect(detail).toBe(
      'the REST proxy answered 502 (rest_proxy_upstream_failure): The operation timed out.',
    );
    expect(detail).not.toContain('Discord answered');
  });

  test('the proxy’s own 400 without a message names its error', () => {
    expect(refusalDetail(400, { error: 'invalid JSON body' })).toBe(
      'the REST proxy answered 400 (invalid JSON body)',
    );
  });

  test('a non-JSON body is logged, squeezed onto one line and cut at 200 characters', () => {
    const page = `<html>\n  <title>403 Forbidden</title>\n${'x'.repeat(500)}</html>`;
    const detail = refusalDetail(403, page);
    const shown = detail.slice('Discord answered 403 (not JSON): '.length);

    expect(detail.startsWith('Discord answered 403 (not JSON): <html> <title>403 Forbidden')).toBe(
      true,
    );
    expect(detail).not.toContain('\n');
    expect(shown).toHaveLength(200);
  });

  test('an empty string or no body says only the status', () => {
    expect(refusalDetail(404, '')).toBe('Discord answered 404');
    expect(refusalDetail(404, '   ')).toBe('Discord answered 404');
    expect(refusalDetail(404, undefined)).toBe('Discord answered 404');
  });
});

class MemoryDedupe implements DedupeStore {
  readonly claimed = new Set<string>();

  async claim(key: string): Promise<boolean> {
    if (this.claimed.has(key)) return false;
    this.claimed.add(key);
    return true;
  }

  async release(key: string): Promise<void> {
    this.claimed.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return this.claimed.has(key);
  }
}

class MemoryRecorder implements CaseRecorder {
  async record(_input: CaseInput): Promise<{ caseId: string }> {
    return { caseId: newId() };
  }
}

class RefusingRest implements RestProxyClient {
  constructor(readonly response: RestResponse) {}

  async request(_options: RestRequestOptions): Promise<RestResponse> {
    return this.response;
  }
}

async function sendRefusedWith(response: RestResponse) {
  const logs: string[] = [];
  const executor = new DefaultActionExecutor({
    dedupe: new MemoryDedupe(),
    rest: new RefusingRest(response),
    recorder: new MemoryRecorder(),
    resolveContext: async (request) =>
      resolvedFor(request.kind, request.payload, {
        botChannelPermissions: Permissions.ViewChannel | Permissions.SendMessages,
        channelId: CHANNEL,
      }),
    logger: {
      info: () => {},
      warn: (message) => logs.push(message),
      error: () => {},
    },
  });

  const result = await executor.execute({
    guildId: GUILD,
    moduleId: 'ping',
    kind: 'send',
    actorId: 'proton:ping',
    dryRun: false,
    idempotencyKey: newId(),
    payload: { channelId: CHANNEL, content: 'hi' },
  });

  return { result, log: logs.join('\n') };
}

describe('the executor on a Discord refusal', () => {
  test('keeps discord_403, names the permission, and logs Discord’s own words', async () => {
    const { result, log } = await sendRefusedWith({ status: 403, body: MISSING_PERMISSIONS });

    expect(result.status).toBe('failed_api');
    expect(result.failure?.code).toBe('discord_403');
    expect(result.failure?.discordCode).toBe(50013);
    expect(result.failure?.humanReason).toContain('Send Messages');
    expect(result.failure?.humanReason).toContain(`<#${CHANNEL}>`);
    expect(log).toContain('403');
    expect(log).toContain('Missing Permissions');
  });

  test('logs the field Discord objected to, and blames Proton for a bad body', async () => {
    const { result, log } = await sendRefusedWith({
      status: 400,
      body: {
        code: 50035,
        message: 'Invalid Form Body',
        errors: {
          content: {
            _errors: [
              { code: 'BASE_TYPE_MAX_LENGTH', message: 'Must be 2000 or fewer in length.' },
            ],
          },
        },
      },
    });

    expect(result.failure?.code).toBe('discord_400');
    expect(result.failure?.discordCode).toBe(50035);
    expect(result.failure?.humanReason).toContain('Proton problem');
    expect(log).toContain('Discord answered 400: Invalid Form Body (50035)');
    expect(log).toContain('content[BASE_TYPE_MAX_LENGTH]: Must be 2000 or fewer in length.');
  });

  test('a non-JSON refusal keeps the status wording and carries no Discord code', async () => {
    const { result, log } = await sendRefusedWith({
      status: 403,
      body: '<html>403 Forbidden</html>',
    });

    expect(result.failure?.code).toBe('discord_403');
    expect(result.failure?.discordCode).toBeUndefined();
    expect(result.failure?.humanReason).toBe(TODAY_403);
    expect(log).toContain('Discord answered 403 (not JSON): <html>403 Forbidden</html>');
  });

  test('the proxy’s own 502 keeps discord_502 but is logged as the proxy’s answer', async () => {
    const { result, log } = await sendRefusedWith({
      status: 502,
      body: { error: 'rest_proxy_upstream_failure', message: 'socket hang up' },
    });

    expect(result.failure?.code).toBe('discord_502');
    expect(result.failure?.discordCode).toBeUndefined();
    expect(result.failure?.humanReason).toContain('may not have gone through');
    expect(log).toContain(
      'send failed: the REST proxy answered 502 (rest_proxy_upstream_failure): socket hang up',
    );
    expect(log).not.toContain('Discord answered');
  });

  test('the Discord code and the wording agree when the message is malformed', async () => {
    const { result } = await sendRefusedWith({
      status: 403,
      body: { code: 50013, message: null },
    });

    expect(result.failure?.discordCode).toBe(50013);
    expect(result.failure?.humanReason).toContain('Send Messages');
  });

  test('a marked DM send refused with 50013 keeps discord_403 and names no server setting', async () => {
    const DM_CHANNEL = '800000000000000000';
    const state: GuildState = {
      guildId: GUILD,
      ownerId: OWNER,
      everyoneRoleId: GUILD,
      roles: new Map([[GUILD, { id: GUILD, permissions: 0n, position: 0 }]]),
      botRoleIds: [],
      channels: new Map([[CHANNEL, { id: CHANNEL, parentId: null, overwrites: [] }]]),
      updatedAt: Date.now(),
    };

    const executor = new DefaultActionExecutor({
      dedupe: new MemoryDedupe(),
      rest: new RefusingRest({ status: 403, body: MISSING_PERMISSIONS }),
      recorder: new MemoryRecorder(),
      resolveContext: async (request) => {
        const resolved = await resolvePrecheckContext(
          {
            store: {
              get: async () => state,
              put: async () => undefined,
              patch: async () => undefined,
              delete: async () => undefined,
            },
            botUserId: BOT,
          },
          request,
        );
        return 'context' in resolved ? resolved.context : resolved;
      },
    });

    const result = await executor.execute({
      guildId: GUILD,
      moduleId: 'afk',
      kind: 'send',
      actorId: 'proton:afk',
      dryRun: false,
      idempotencyKey: newId(),
      payload: { channelId: DM_CHANNEL, content: 'While you were away', directMessage: true },
    });

    expect(result.status).toBe('failed_api');
    expect(result.failure?.code).toBe('discord_403');
    expect(result.failure?.discordCode).toBe(50013);
    expect(result.failure?.humanReason).toBe(
      "Discord wouldn't allow a DM to that user. No setting in this server changes that.",
    );
  });
});
