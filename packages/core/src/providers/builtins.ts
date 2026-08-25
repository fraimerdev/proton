import { z } from 'zod';
import { snowflakeSchema } from '../actions/payloads.ts';
import { protonFields, zodToDescriptors } from '../config/descriptor.ts';
import { durationStringSchema, formatDuration, tryParseDuration } from '../config/duration.ts';
import { ENTITLEMENT_TIERS, entitlementRank } from '../rules/facts.ts';
import type { ConditionProvider, ConditionResult, MemberContext } from './types.ts';

export const CORE_MODULE_ID = 'core';

const PASSED: ConditionResult = { passed: true };

function unknown(humanReason: string): ConditionResult {
  return { passed: false, indeterminate: { humanReason } };
}

const NO_MEMBER =
  'I could not read your server profile, so this could not be checked. That usually means the ' +
  'Server Members intent is not granted to the bot, or you are no longer in the server.';

const NO_BOOST_DATE =
  'Whether you are boosting this server could not be read from that event, so it could not be ' +
  'checked here.';

const NO_ROLES =
  'That did not carry your roles, so the role check could not run. If it keeps happening an ' +
  'admin should check the Server Members intent in the Discord developer portal.';

const NO_TIMEOUT_STATE =
  'That event did not carry whether you are timed out, so it could not be checked here.';

const NO_NAMES =
  'Your name could not be read from that event, so a name requirement could not be checked here.';

const roleMode = z.enum(['any', 'all']).default('any').register(protonFields, { label: 'Match' });

const roleIds = z
  .array(snowflakeSchema)
  .min(1)
  .max(25)
  .register(protonFields, { field: 'role-id', label: 'Roles' });

const hasRoleSchema = z.object({ roleIds, mode: roleMode });
const lacksRoleSchema = z.object({ roleIds, mode: roleMode });

const ageOperator = z
  .enum(['older-than', 'younger-than'])
  .default('older-than')
  .register(protonFields, { label: 'Comparison' });

const accountAgeSchema = z.object({
  operator: ageOperator,
  duration: durationStringSchema.clone().register(protonFields, {
    field: 'duration',
    label: 'Account age',
  }),
});

const memberAgeSchema = z.object({
  operator: ageOperator,
  duration: durationStringSchema.clone().register(protonFields, {
    field: 'duration',
    label: 'Time in this server',
  }),
});

const emptySchema = z.object({});

const isPremiumSchema = z.object({
  tier: z.enum(ENTITLEMENT_TIERS).default('plus').register(protonFields, {
    label: 'Required tier',
  }),
});

const roleCountSchema = z.object({
  min: z.number().int().min(0).max(250).default(1).register(protonFields, {
    label: 'Fewest roles',
  }),
});

const NAME_FIELDS = ['any', 'username', 'display-name', 'nickname'] as const;
const NAME_MODES = ['contains', 'starts-with', 'ends-with', 'equals'] as const;

const nameMatchesSchema = z.object({
  // Deliberately not a regex: a host-authored pattern run against every entrant at draw time is a
  // ReDoS vector inside the draw, and plain matching covers what hosts actually ask for.
  mode: z.enum(NAME_MODES).default('contains').register(protonFields, { label: 'Match' }),
  value: z.string().min(1).max(64).register(protonFields, { label: 'Text' }),
  field: z
    .enum(NAME_FIELDS)
    .default('any')
    .register(protonFields, {
      label: 'Which name',
      optionLabels: {
        any: 'Any of them',
        username: 'Username',
        'display-name': 'Display name',
        nickname: 'Server nickname',
      },
    }),
});

type RoleConfig = { roleIds: string[]; mode: 'any' | 'all' };
type AgeConfig = { operator: 'older-than' | 'younger-than'; duration: string };

// Discord retired discriminators, so identity is username (the handle), global_name (what most
// clients show) and the per-guild nickname. Null is "not carried", never "empty".
function namesOf(ctx: MemberContext, field: (typeof NAME_FIELDS)[number]): string[] | null {
  const username = ctx.user.username ?? null;
  const globalName = ctx.user.globalName ?? null;
  const nickname = ctx.member?.nickname ?? null;

  const picked =
    field === 'username'
      ? [username]
      : field === 'display-name'
        ? [globalName]
        : field === 'nickname'
          ? [nickname]
          : [username, globalName, nickname];

  const known = picked.filter((name): name is string => typeof name === 'string');
  return known.length === 0 ? null : known;
}

function nameMatches(name: string, mode: (typeof NAME_MODES)[number], value: string): boolean {
  const haystack = name.toLowerCase();
  const needle = value.toLowerCase();

  switch (mode) {
    case 'starts-with':
      return haystack.startsWith(needle);
    case 'ends-with':
      return haystack.endsWith(needle);
    case 'equals':
      return haystack === needle;
    default:
      return haystack.includes(needle);
  }
}

const MODE_WORDS: Record<(typeof NAME_MODES)[number], string> = {
  contains: 'contain',
  'starts-with': 'start with',
  'ends-with': 'end with',
  equals: 'be exactly',
};

const FIELD_WORDS: Record<(typeof NAME_FIELDS)[number], string> = {
  any: 'One of your names',
  username: 'Your username',
  'display-name': 'Your display name',
  nickname: 'Your nickname here',
};

function heldRoles(ctx: MemberContext): { held: Set<string> } | { blocked: ConditionResult } {
  if (ctx.member === null) return { blocked: unknown(NO_MEMBER) };
  if (ctx.member.roleIds === null) return { blocked: unknown(NO_ROLES) };
  return { held: new Set(ctx.member.roleIds) };
}

function matched(config: RoleConfig, held: Set<string>): boolean {
  const hits = config.roleIds.filter((id) => held.has(id));
  return config.mode === 'all' ? hits.length === config.roleIds.length : hits.length > 0;
}

function roleList(ids: readonly string[]): string {
  return ids.map((id) => `<@&${id}>`).join(', ');
}

function ageVerdict(ageMs: number, config: AgeConfig): ConditionResult {
  const threshold = tryParseDuration(config.duration);
  if (threshold === null) {
    return unknown(`'${config.duration}' is not a length of time I can read.`);
  }

  const passed = config.operator === 'younger-than' ? ageMs < threshold : ageMs > threshold;
  return { passed, progress: { current: ageMs, required: threshold, unit: 'ms' } };
}

export const hasRoleProvider: ConditionProvider<typeof hasRoleSchema> = {
  kind: 'condition',
  id: 'core.has_role',
  moduleId: CORE_MODULE_ID,
  label: 'Has a role',
  description: 'Must hold one of the chosen roles, or all of them.',
  emoji: '\u{1F3AD}',
  configSchema: hasRoleSchema,
  builder: zodToDescriptors(hasRoleSchema),
  cost: 'facts',

  async evaluate(ctx, config) {
    const roles = heldRoles(ctx);
    if ('blocked' in roles) return roles.blocked;

    return matched(config, roles.held) ? PASSED : { passed: false };
  },

  describe(config) {
    return config.mode === 'all'
      ? `Have every one of these roles: ${roleList(config.roleIds)}.`
      : `Have one of these roles: ${roleList(config.roleIds)}.`;
  },

  describeFailure(config, result) {
    if (result.indeterminate) return result.indeterminate.humanReason;

    return config.mode === 'all'
      ? `You need every one of these roles: ${roleList(config.roleIds)}.`
      : `You need one of these roles: ${roleList(config.roleIds)}.`;
  },
};

export const lacksRoleProvider: ConditionProvider<typeof lacksRoleSchema> = {
  kind: 'condition',
  id: 'core.lacks_role',
  moduleId: CORE_MODULE_ID,
  label: 'Does not have a role',
  description: 'Must not hold the chosen roles.',
  emoji: '\u{1F6AB}',
  configSchema: lacksRoleSchema,
  builder: zodToDescriptors(lacksRoleSchema),
  cost: 'facts',

  async evaluate(ctx, config) {
    const roles = heldRoles(ctx);
    if ('blocked' in roles) return roles.blocked;

    return matched(config, roles.held) ? { passed: false } : PASSED;
  },

  describe(config) {
    return config.mode === 'all'
      ? `Not have all of these roles: ${roleList(config.roleIds)}.`
      : `Not have any of these roles: ${roleList(config.roleIds)}.`;
  },

  describeFailure(config, result) {
    if (result.indeterminate) return result.indeterminate.humanReason;

    return config.mode === 'all'
      ? `You hold all of these roles, which this excludes: ${roleList(config.roleIds)}.`
      : `You hold one of these roles, which this excludes: ${roleList(config.roleIds)}.`;
  },
};

export const accountAgeProvider: ConditionProvider<typeof accountAgeSchema> = {
  kind: 'condition',
  id: 'core.account_age',
  moduleId: CORE_MODULE_ID,
  label: 'Account age',
  description: 'The Discord account itself must be older (or newer) than a given age.',
  emoji: '\u{1F4C5}',
  configSchema: accountAgeSchema,
  builder: zodToDescriptors(accountAgeSchema),
  cost: 'facts',

  async evaluate(ctx, config) {
    return ageVerdict(Math.max(0, ctx.now.getTime() - ctx.user.createdAt.getTime()), config);
  },

  describe(config) {
    return config.operator === 'older-than'
      ? `Have a Discord account older than ${config.duration}.`
      : `Have a Discord account newer than ${config.duration}.`;
  },

  describeFailure(config, result) {
    if (result.indeterminate) return result.indeterminate.humanReason;

    const age = result.progress ? formatDuration(result.progress.current) : 'an unknown age';
    return config.operator === 'older-than'
      ? `Your Discord account is ${age} old and has to be older than ${config.duration}.`
      : `Your Discord account is ${age} old and has to be newer than ${config.duration}.`;
  },
};

export const memberAgeProvider: ConditionProvider<typeof memberAgeSchema> = {
  kind: 'condition',
  id: 'core.member_age',
  moduleId: CORE_MODULE_ID,
  label: 'Time in this server',
  description: 'Must have joined this server longer (or more recently) than a given time ago.',
  emoji: '\u{1F6AA}',
  configSchema: memberAgeSchema,
  builder: zodToDescriptors(memberAgeSchema),
  cost: 'facts',

  async evaluate(ctx, config) {
    if (ctx.member === null) return unknown(NO_MEMBER);

    const joinedAt = ctx.member.joinedAt;
    if (joinedAt === null) {
      return unknown(
        'I could not read when you joined this server, so how long you have been here could ' +
          'not be checked.',
      );
    }

    return ageVerdict(Math.max(0, ctx.now.getTime() - joinedAt.getTime()), config);
  },

  describe(config) {
    return config.operator === 'older-than'
      ? `Have been in this server for more than ${config.duration}.`
      : `Have joined this server within the last ${config.duration}.`;
  },

  describeFailure(config, result) {
    if (result.indeterminate) return result.indeterminate.humanReason;

    const age = result.progress ? formatDuration(result.progress.current) : 'an unknown time';
    return config.operator === 'older-than'
      ? `You have been in this server for ${age} and need more than ${config.duration}.`
      : `You have been in this server for ${age}, which is longer than ${config.duration}.`;
  },
};

export const isBoosterProvider: ConditionProvider<typeof emptySchema> = {
  kind: 'condition',
  id: 'core.is_booster',
  moduleId: CORE_MODULE_ID,
  label: 'Server booster',
  description: 'Must currently be boosting this server.',
  emoji: '\u{1F48E}',
  configSchema: emptySchema,
  builder: [],
  cost: 'facts',

  async evaluate(ctx) {
    if (ctx.member === null) return unknown(NO_MEMBER);
    if (ctx.member.premiumSince !== null) return PASSED;

    // On a partial context "no boost date" only means the dispatch did not carry one, and
    // reporting that as "not boosting" would quietly exclude every booster.
    return ctx.partial === true ? unknown(NO_BOOST_DATE) : { passed: false };
  },

  describe() {
    return 'Be boosting this server.';
  },

  describeFailure(_config, result) {
    return result.indeterminate?.humanReason ?? 'You are not currently boosting this server.';
  },
};

export const hasAvatarProvider: ConditionProvider<typeof emptySchema> = {
  kind: 'condition',
  id: 'core.has_avatar',
  moduleId: CORE_MODULE_ID,
  label: 'Has an avatar',
  description: 'Must have set a profile picture. A cheap throwaway-account heuristic.',
  emoji: '\u{1F5BC}',
  configSchema: emptySchema,
  builder: [],
  cost: 'facts',

  async evaluate(ctx) {
    if (ctx.user.hasAvatar === null) {
      return unknown('I could not read your profile picture, so that could not be checked.');
    }
    return ctx.user.hasAvatar ? PASSED : { passed: false };
  },

  describe() {
    return 'Have a profile picture set.';
  },

  describeFailure(_config, result) {
    return (
      result.indeterminate?.humanReason ??
      'You need a profile picture on your Discord account to enter.'
    );
  },
};

export const isPremiumProvider: ConditionProvider<typeof isPremiumSchema> = {
  kind: 'condition',
  id: 'core.is_premium',
  moduleId: CORE_MODULE_ID,
  label: 'Server is on a paid plan',
  description: 'Only applies when this server is on the given Proton tier or higher.',
  emoji: '\u{2B50}',
  configSchema: isPremiumSchema,
  builder: zodToDescriptors(isPremiumSchema),
  cost: 'facts',

  async evaluate(ctx, config) {
    return entitlementRank(ctx.tier) >= entitlementRank(config.tier) ? PASSED : { passed: false };
  },

  describe(config) {
    return `This server must be on the ${config.tier} tier.`;
  },

  describeFailure(config, result) {
    return (
      result.indeterminate?.humanReason ??
      `This server is on a lower plan than ${config.tier}, so this does not apply.`
    );
  },
};

export const notBotProvider: ConditionProvider<typeof emptySchema> = {
  kind: 'condition',
  id: 'core.not_bot',
  moduleId: CORE_MODULE_ID,
  label: 'Not a bot',
  description: 'Excludes bot and webhook accounts.',
  emoji: '\u{1F916}',
  configSchema: emptySchema,
  builder: zodToDescriptors(emptySchema),
  cost: 'facts',

  async evaluate(ctx) {
    return ctx.user.bot ? { passed: false } : PASSED;
  },

  describe() {
    return 'Not be a bot account.';
  },

  describeFailure(_config, result) {
    return result.indeterminate?.humanReason ?? 'Bot accounts cannot take part.';
  },
};

export const notTimedOutProvider: ConditionProvider<typeof emptySchema> = {
  kind: 'condition',
  id: 'core.not_timed_out',
  moduleId: CORE_MODULE_ID,
  label: 'Not timed out',
  description: 'Excludes members who are currently in a Discord timeout.',
  emoji: '\u{1F507}',
  configSchema: emptySchema,
  builder: zodToDescriptors(emptySchema),
  cost: 'facts',

  async evaluate(ctx) {
    if (ctx.member === null) return unknown(NO_MEMBER);

    const until = ctx.member.communicationDisabledUntil;

    // A null date on a partial context means "not carried", not "not timed out" — reading it as
    // the latter lets a timed-out member through on any dispatch that omitted the field.
    if (until === null) return ctx.partial ? unknown(NO_TIMEOUT_STATE) : PASSED;

    return until.getTime() > ctx.now.getTime() ? { passed: false } : PASSED;
  },

  describe() {
    return 'Not be timed out.';
  },

  describeFailure(_config, result) {
    return (
      result.indeterminate?.humanReason ??
      'You are timed out at the moment, so you cannot take part until it expires.'
    );
  },
};

export const roleCountProvider: ConditionProvider<typeof roleCountSchema> = {
  kind: 'condition',
  id: 'core.role_count',
  moduleId: CORE_MODULE_ID,
  label: 'Number of roles',
  description: 'Must hold at least a given number of roles.',
  emoji: '\u{1F3F7}',
  configSchema: roleCountSchema,
  builder: zodToDescriptors(roleCountSchema),
  cost: 'facts',

  async evaluate(ctx, config) {
    const roles = heldRoles(ctx);
    if ('blocked' in roles) return roles.blocked;

    const held = roles.held.size;
    return {
      passed: held >= config.min,
      progress: { current: held, required: config.min, unit: 'roles' },
    };
  },

  describe(config) {
    return `Hold at least ${config.min} role${config.min === 1 ? '' : 's'}.`;
  },

  describeFailure(config, result) {
    if (result.indeterminate) return result.indeterminate.humanReason;

    const held = result.progress?.current ?? 0;
    return `You hold ${held} role${held === 1 ? '' : 's'} and need at least ${config.min}.`;
  },
};

export const nameMatchesProvider: ConditionProvider<typeof nameMatchesSchema> = {
  kind: 'condition',
  id: 'core.name_matches',
  moduleId: CORE_MODULE_ID,
  label: 'Name',
  description: 'Username, display name or nickname must match some text.',
  emoji: '\u{1F58A}',
  configSchema: nameMatchesSchema,
  builder: zodToDescriptors(nameMatchesSchema),
  cost: 'facts',

  async evaluate(ctx, config) {
    const names = namesOf(ctx, config.field);
    if (names === null) return unknown(NO_NAMES);

    return { passed: names.some((name) => nameMatches(name, config.mode, config.value)) };
  },

  describe(config) {
    return `${FIELD_WORDS[config.field]} must ${MODE_WORDS[config.mode]} “${config.value}”.`;
  },

  describeFailure(config, result) {
    return (
      result.indeterminate?.humanReason ??
      `${FIELD_WORDS[config.field]} has to ${MODE_WORDS[config.mode]} “${config.value}”.`
    );
  },
};

export const CORE_PROVIDERS: readonly ConditionProvider[] = [
  hasRoleProvider,
  lacksRoleProvider,
  accountAgeProvider,
  memberAgeProvider,
  isBoosterProvider,
  hasAvatarProvider,
  isPremiumProvider,
  notBotProvider,
  notTimedOutProvider,
  roleCountProvider,
  nameMatchesProvider,
] as unknown as readonly ConditionProvider[];

export const CORE_PROVIDER_IDS: readonly string[] = CORE_PROVIDERS.map((provider) => provider.id);
