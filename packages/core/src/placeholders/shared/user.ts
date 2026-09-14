import type { PlaceholderDefinitionInput } from '../definitions.ts';
import {
  type PlaceholderValue,
  type ResolvedValue,
  typeOf,
  placeholderValue as v,
} from '../values.ts';
import type { MemberFacts, UserFacts } from './facts.ts';

export const USER_NAMESPACES = ['user', 'actor', 'moderator', 'target'] as const;

export type UserNamespace = (typeof USER_NAMESPACES)[number];

const GROUPS: Record<UserNamespace, string> = {
  user: 'Member',
  actor: 'Who did it',
  moderator: 'Moderator',
  target: 'Target',
};

const CDN = 'https://cdn.discordapp.com';

const SNOWFLAKE = /^\d{17,20}$/;

const DISCORD_EPOCH_MS = 1_420_070_400_000;

const DAY = 86_400_000;

export function isSnowflake(id: string): boolean {
  return SNOWFLAKE.test(id);
}

export function snowflakeTime(id: string): number | null {
  return SNOWFLAKE.test(id) ? Number((BigInt(id) >> 22n) + BigInt(DISCORD_EPOCH_MS)) : null;
}

export function cdnImageUrl(path: string, hash: string, size: number): string {
  const extension = hash.startsWith('a_') ? 'gif' : 'png';
  return `${CDN}/${path}/${encodeURIComponent(hash)}.${extension}?size=${size}`;
}

export function userAvatarUrl(userId: string, hash: string | null, size = 256): string | null {
  if (!SNOWFLAKE.test(userId)) return null;
  if (hash !== null && hash !== '') return cdnImageUrl(`avatars/${userId}`, hash, size);

  return `${CDN}/embed/avatars/${(BigInt(userId) >> 22n) % 6n}.png`;
}

const EXAMPLE_ID = '100000000000000010';

const EXAMPLE_ROLE = '100000000000000020';

const EXAMPLE_AT = Date.UTC(2026, 8, 14, 9);

const ACCOUNT_KEYS = [
  'id',
  'mention',
  'username',
  'global_name',
  'display_name',
  'avatar_url',
  'is_bot',
  'created_at',
  'account_age',
] as const;

const MEMBER_KEYS = [
  'nickname',
  'joined_at',
  'is_boosting',
  'boosting_since',
  'role_mentions',
  'role_count',
] as const;

type AccountKey = (typeof ACCOUNT_KEYS)[number];

type MemberKey = (typeof MEMBER_KEYS)[number];

type Entry = readonly [label: string, description: string, example: PlaceholderValue];

const ACCOUNT: Record<AccountKey, Entry> = {
  id: ['ID', 'Discord user id', v.text(EXAMPLE_ID)],
  mention: ['Mention', 'Pings them where mentions are allowed', v.user(EXAMPLE_ID, 'Fraimer')],
  username: ['Username', 'Unique account handle', v.text('fraimer')],
  global_name: [
    'Display name',
    'Account display name, or the username when none is set (as Discord shows it)',
    v.text('Fraimer'),
  ],
  display_name: [
    'Name in this server',
    'Nickname here, else display name, else username',
    v.text('Fraim'),
  ],
  avatar_url: [
    'Avatar',
    'Server-independent avatar image',
    v.imageUrl(`${CDN}/embed/avatars/0.png`),
  ],
  is_bot: ['Is a bot', 'Yes for bot accounts', v.boolean(false)],
  created_at: ['Account created', 'When the account was made', v.datetime(Date.UTC(2020, 0, 1))],
  account_age: ['Account age', 'How long ago the account was made', v.duration(3 * 365 * DAY)],
};

const MEMBER: Record<MemberKey, Entry> = {
  nickname: ['Nickname', 'Server nickname; empty when none', v.text('Fraim')],
  joined_at: ['Joined server', 'When they joined', v.datetime(EXAMPLE_AT)],
  is_boosting: ['Is boosting', 'Yes while boosting', v.boolean(true)],
  boosting_since: ['Boosting since', 'When their boost began', v.datetime(EXAMPLE_AT)],
  role_mentions: [
    'Roles',
    "Their roles as mentions. In message text these ping each role whenever the message's mention settings allow role pings, which is the default.",
    v.list('mention', [v.role(EXAMPLE_ROLE, 'Mods'), v.role('100000000000000021', 'Level 5')]),
  ],
  role_count: ['Role count', 'How many roles they have', v.integer(3)],
};

export function userDefinitions(
  namespace: UserNamespace,
  options: { member: boolean },
): PlaceholderDefinitionInput[] {
  const group = GROUPS[namespace];
  const define = (
    key: string,
    [label, description, example]: Entry,
  ): PlaceholderDefinitionInput => ({
    key: `${namespace}.${key}`,
    label,
    description,
    group,
    type: typeOf(example),
    example,
  });

  return [
    ...ACCOUNT_KEYS.map((key) => define(key, ACCOUNT[key])),
    ...(options.member ? MEMBER_KEYS.map((key) => define(key, MEMBER[key])) : []),
  ];
}

const NO_PROFILE = "Proton could not read this member's profile";

const NO_NAME = "Proton has not read this member's name";

const NOT_AN_ID = 'the id Proton holds for this member is not a Discord id';

const NO_MEMBERSHIP_HERE = 'this event does not say what they have in this server';

const MEMBERSHIP_NOT_READ = 'Proton did not read their server membership';

function dateValue(raw: string | null | undefined, what: string): ResolvedValue {
  if (raw === undefined) return v.unavailable(`Proton did not read ${what}`);
  if (raw === null) return v.notSet();

  const at = Date.parse(raw);
  return Number.isFinite(at) ? v.datetime(at) : v.failed(`${what} is not a date Proton can read`);
}

function nicknameValue(nick: string | null | undefined): ResolvedValue {
  if (nick === undefined) return v.unavailable('Proton did not read their nickname');
  return nick === null || nick === '' ? v.notSet() : v.text(nick);
}

export function buildUserValues(
  ns: string,
  user: UserFacts | null,
  member: MemberFacts | null | 'unavailable',
  now: number,
): Record<string, ResolvedValue> {
  const values: Record<string, ResolvedValue> = {};
  const set = (key: AccountKey | MemberKey, value: ResolvedValue): void => {
    values[`${ns}.${key}`] = value;
  };

  const membership = member === null || member === 'unavailable' ? null : member;
  const nick =
    typeof membership?.nick === 'string' && membership.nick !== '' ? membership.nick : null;

  if (user === null) {
    for (const key of ACCOUNT_KEYS) set(key, v.failed(NO_PROFILE));
  } else {
    const account = user.globalName ?? user.username;
    const shown = nick ?? account;
    const created = snowflakeTime(user.id);
    const avatar = userAvatarUrl(user.id, user.avatarHash);

    set('id', v.text(user.id));
    set(
      'mention',
      isSnowflake(user.id) ? v.user(user.id, shown ?? undefined) : v.failed(NOT_AN_ID),
    );
    set('username', user.username === null ? v.unavailable(NO_NAME) : v.text(user.username));
    set('global_name', account === null ? v.unavailable(NO_NAME) : v.text(account));
    set('display_name', shown === null ? v.unavailable(NO_NAME) : v.text(shown));

    if (user.username === null && user.avatarHash === null) {
      set('avatar_url', v.unavailable(NO_PROFILE));
    } else {
      set('avatar_url', avatar === null ? v.failed(NOT_AN_ID) : v.imageUrl(avatar));
    }

    set('is_bot', v.boolean(user.bot === true));
    set('created_at', created === null ? v.failed(NOT_AN_ID) : v.datetime(created));
    set(
      'account_age',
      created === null ? v.failed(NOT_AN_ID) : v.duration(Math.max(0, Math.round(now) - created)),
    );
  }

  if (membership === null) {
    const reason = member === 'unavailable' ? NO_MEMBERSHIP_HERE : MEMBERSHIP_NOT_READ;
    for (const key of MEMBER_KEYS) set(key, v.unavailable(reason));
    return values;
  }

  set('nickname', nicknameValue(membership.nick));
  set('joined_at', dateValue(membership.joinedAt, 'when they joined'));
  set(
    'is_boosting',
    membership.premiumSince === undefined
      ? v.unavailable('Proton did not read whether they boost')
      : v.boolean(membership.premiumSince !== null),
  );
  set('boosting_since', dateValue(membership.premiumSince, 'when their boost began'));

  const roles = membership.roleIds;
  if (roles === undefined || roles === null) {
    set('role_mentions', v.unavailable('Proton did not read their roles'));
    set('role_count', v.unavailable('Proton did not read their roles'));
  } else {
    const ids = roles.filter(isSnowflake);
    set(
      'role_mentions',
      v.list(
        'mention',
        ids.map((id) => v.role(id)),
      ),
    );
    set('role_count', v.integer(ids.length));
  }

  return values;
}
