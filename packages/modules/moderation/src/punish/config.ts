import {
  type ConfigWriteIssue,
  durationStringSchema,
  interactiveKeys,
  liftLegacyMessage,
  messageObjectSchema,
  refineMessage,
  snowflakeSchema,
  tryParseDuration,
} from '@proton/core';
import { z } from 'zod';

export const PUNISH_KINDS = ['warn', 'timeout', 'kick', 'ban'] as const;
export const UNPUNISH_KINDS = ['unwarn', 'untimeout', 'unban'] as const;

export type PunishKind = (typeof PUNISH_KINDS)[number];
export type UnpunishKind = (typeof UNPUNISH_KINDS)[number];

export const PUNISH_DIRECTIONS = [
  'ban',
  'unban',
  'kick',
  'timeout',
  'untimeout',
  'warn',
  'unwarn',
] as const satisfies ReadonlyArray<PunishKind | UnpunishKind>;

export type PunishDirection = (typeof PUNISH_DIRECTIONS)[number];

export const AUDITED_DIRECTIONS = ['ban', 'unban', 'kick', 'timeout', 'untimeout'] as const;

export const DEFAULT_AUDIT_REASON = '{punishment.reason:fallback("No reason given")}';

export const AUDIT_REASON_EQUIVALENTS: Readonly<Record<string, string>> = {
  authorid: '{moderator.id}',
  authortag: '{moderator.username}',
  duration: '{punishment.duration}',
  reason: '{punishment.reason}',
  currentdate: '{today}',
};

export const IMMUNITY_AUTOMATIC_NOTE =
  'Automatic punishments (report automation and warn escalation) always respect these roles, ' +
  'even when role hierarchy decides who moderators can punish.';

export const TIMEOUT_CAP_MS = 28 * 86_400_000;
export const PUNISH_DURATION_MAX_MS = 365 * 86_400_000;

type MessageShape = z.infer<typeof messageObjectSchema>;

export function refuseInteractive(message: MessageShape, ctx: z.RefinementCtx, copy: string): void {
  for (const [row, component] of message.components.entries()) {
    if (component.kind !== 'buttons') {
      ctx.addIssue({ code: 'custom', path: ['components', row], message: copy });
      continue;
    }

    for (const [index, button] of component.buttons.entries()) {
      if (button.style === 'link') continue;

      ctx.addIssue({
        code: 'custom',
        path: ['components', row, 'buttons', index, 'style'],
        message: copy,
      });
    }
  }

  if (interactiveKeys({ components: [], v2: message.v2 }).length > 0) {
    ctx.addIssue({ code: 'custom', path: ['v2'], message: copy });
  }
}

const DM_ONLY_LINKS =
  'a DM can only have link buttons. Other buttons and menus do nothing in a DM, so make it a ' +
  'link button or remove it.';

export const dmMessageSchema = z.preprocess(
  liftLegacyMessage,
  messageObjectSchema.superRefine((message, ctx) => {
    refineMessage(message, ctx);
    refuseInteractive(message, ctx, DM_ONLY_LINKS);
  }),
);

export type DmMessage = z.infer<typeof dmMessageSchema>;

const SILENT = { everyone: false, roles: false, users: false };
const REASON = '{punishment.reason:fallback("No reason given")}';

function dm(title: string, fields: Array<{ name: string; value: string }> = []): DmMessage {
  return dmMessageSchema.parse({
    mentions: SILENT,
    embeds: [
      {
        title,
        description: REASON,
        ...(fields.length > 0
          ? { fields: fields.map((field) => ({ ...field, inline: true })) }
          : {}),
      },
    ],
  });
}

export const DM_DEFAULTS: Readonly<Record<PunishDirection, DmMessage>> = {
  ban: dm('You were banned from {server.name}', [
    { name: 'Duration', value: '{punishment.duration:fallback("Permanent")}' },
  ]),
  unban: dm('Your ban from {server.name} was lifted'),
  kick: dm('You were kicked from {server.name}'),
  timeout: dm('You were timed out in {server.name}', [
    { name: 'Until', value: '{punishment.expires_at:full}' },
  ]),
  untimeout: dm('Your timeout in {server.name} has ended'),
  warn: dm('You were warned in {server.name}'),
  unwarn: dm('A warning in {server.name} was withdrawn'),
};

const reasonText = z.string().max(512);
const roleIdList = z.array(snowflakeSchema);
const roleIds = roleIdList.max(25).default([]);

const onPunishActions = z.object({
  addRoleIds: roleIds,
  removeRoleIds: roleIds,
  disconnectVoice: z.boolean().default(false),
});

const onLiftActions = z.object({ addRoleIds: roleIds, removeRoleIds: roleIds });

const base = { defaultReason: reasonText.default(''), forceReason: z.boolean().default(false) };
const audited = { auditReason: reasonText.default(DEFAULT_AUDIT_REASON) };
const reviewed = {
  alwaysReview: z.boolean().default(false),
  deleteProof: z.boolean().default(false),
};

export const punishTypesSchema = z.object({
  ban: z
    .object({
      ...base,
      ...audited,
      ...reviewed,
      defaultDuration: durationStringSchema.nullable().default(null),
      deleteMessageDays: z.number().int().min(0).max(7).default(0),
    })
    .prefault({}),
  unban: z.object({ ...base, ...audited }).prefault({}),
  kick: z.object({ ...base, ...audited, ...reviewed }).prefault({}),
  timeout: z
    .object({
      ...base,
      ...audited,
      ...reviewed,
      defaultDuration: durationStringSchema.default('1h'),
      allowMultiple: z.boolean().default(false),
      actions: onPunishActions.prefault({}),
    })
    .prefault({}),
  untimeout: z.object({ ...base, ...audited, actions: onLiftActions.prefault({}) }).prefault({}),
  warn: z.object({ ...base, ...reviewed, actions: onPunishActions.prefault({}) }).prefault({}),
  unwarn: z.object({ ...base, actions: onLiftActions.prefault({}) }).prefault({}),
});

export type PunishTypes = z.infer<typeof punishTypesSchema>;

export const predefinedReasonSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,16}$/),
  reason: z.string().trim().min(1).max(512),
  aliases: z
    .array(z.string().regex(/^[a-z0-9_-]{1,16}$/))
    .max(20)
    .default([]),
});

export type PredefinedReason = z.infer<typeof predefinedReasonSchema>;

export const punishConfigSchema = z.object({
  types: punishTypesSchema.prefault({}),
  extendTimeouts: z.boolean().default(false),
  punishFromMessage: z.boolean().default(true),
  confirmRecentCase: z
    .object({ enabled: z.boolean().default(false), window: durationStringSchema.default('5m') })
    .prefault({}),
  logExpiredWhenAbsent: z.boolean().default(true),
  messageHistory: z.boolean().default(false),
  immunity: z
    .object({
      useHierarchy: z.boolean().default(false),
      global: roleIds,
      ban: roleIds,
      kick: roleIds,
      timeout: roleIds,
      warn: roleIds,
    })
    .prefault({}),
  notifications: z
    .object({
      onPunish: z.boolean().default(false),
      onUnpunish: z.boolean().default(false),
      onPunishByOthers: z.boolean().default(false),
      onUnpunishByOthers: z.boolean().default(false),
      messages: z
        .object({
          ban: dmMessageSchema.default(DM_DEFAULTS.ban),
          kick: dmMessageSchema.default(DM_DEFAULTS.kick),
          timeout: dmMessageSchema.default(DM_DEFAULTS.timeout),
          warn: dmMessageSchema.default(DM_DEFAULTS.warn),
          unban: dmMessageSchema.default(DM_DEFAULTS.unban),
          untimeout: dmMessageSchema.default(DM_DEFAULTS.untimeout),
          unwarn: dmMessageSchema.default(DM_DEFAULTS.unwarn),
        })
        .prefault({}),
    })
    .prefault({}),
  reasons: z.array(predefinedReasonSchema).max(50).default([]),
});

export type PunishConfig = z.infer<typeof punishConfigSchema>;

const NO_REASON = { defaultReason: '', forceReason: false };
const NO_REVIEW = { alwaysReview: false, deleteProof: false };
const AUDIT = { auditReason: DEFAULT_AUDIT_REASON };

export const PUNISH_DEFAULTS: PunishConfig = {
  types: {
    ban: { ...NO_REASON, ...AUDIT, ...NO_REVIEW, defaultDuration: null, deleteMessageDays: 0 },
    unban: { ...NO_REASON, ...AUDIT },
    kick: { ...NO_REASON, ...AUDIT, ...NO_REVIEW },
    timeout: {
      ...NO_REASON,
      ...AUDIT,
      ...NO_REVIEW,
      defaultDuration: '1h',
      allowMultiple: false,
      actions: { addRoleIds: [], removeRoleIds: [], disconnectVoice: false },
    },
    untimeout: { ...NO_REASON, ...AUDIT, actions: { addRoleIds: [], removeRoleIds: [] } },
    warn: {
      ...NO_REASON,
      ...NO_REVIEW,
      actions: { addRoleIds: [], removeRoleIds: [], disconnectVoice: false },
    },
    unwarn: { ...NO_REASON, actions: { addRoleIds: [], removeRoleIds: [] } },
  },
  extendTimeouts: false,
  punishFromMessage: true,
  confirmRecentCase: { enabled: false, window: '5m' },
  logExpiredWhenAbsent: true,
  messageHistory: false,
  immunity: { useHierarchy: false, global: [], ban: [], kick: [], timeout: [], warn: [] },
  notifications: {
    onPunish: false,
    onUnpunish: false,
    onPunishByOthers: false,
    onUnpunishByOthers: false,
    messages: {
      ban: DM_DEFAULTS.ban,
      kick: DM_DEFAULTS.kick,
      timeout: DM_DEFAULTS.timeout,
      warn: DM_DEFAULTS.warn,
      unban: DM_DEFAULTS.unban,
      untimeout: DM_DEFAULTS.untimeout,
      unwarn: DM_DEFAULTS.unwarn,
    },
  },
  reasons: [],
};

const SAPPHIRE_VARIABLE = /\$\{([^}]*)\}?/g;

function auditReasonIssue(text: string): string | null {
  if (!text.includes('${')) return null;

  const swaps = [...text.matchAll(SAPPHIRE_VARIABLE)].flatMap((match) => {
    const name = (match[1] ?? '').trim().toLowerCase();
    if (!Object.hasOwn(AUDIT_REASON_EQUIVALENTS, name)) return [];
    return [`${AUDIT_REASON_EQUIVALENTS[name]} for \${${name}}`];
  });

  const hint = swaps.length > 0 ? ` Write ${[...new Set(swaps)].join(', ')}.` : '';

  return `Proton placeholders are written {like.this}, without the $.${hint}`;
}

function durationIssues(path: string, value: string | null, label: string): ConfigWriteIssue[] {
  if (value === null) return [];

  const ms = tryParseDuration(value);
  if (ms === null) return [];

  if (ms <= 0) return [{ path, message: `${label} needs to be longer than zero.` }];
  if (ms > PUNISH_DURATION_MAX_MS) {
    return [{ path, message: `${label} can be at most 365 days.` }];
  }

  return [];
}

function overlapIssues(
  path: string,
  actions: { addRoleIds: string[]; removeRoleIds: string[] },
): ConfigWriteIssue[] {
  const added = new Set(actions.addRoleIds);
  if (!actions.removeRoleIds.some((roleId) => added.has(roleId))) return [];

  return [
    {
      path: `${path}.removeRoleIds`,
      message: 'A role can’t be both added and removed. Take it out of one of the two lists.',
    },
  ];
}

function reasonIssues(reasons: readonly PredefinedReason[]): ConfigWriteIssue[] {
  const issues: ConfigWriteIssue[] = [];
  const ids = new Map<string, number>();

  for (const [index, reason] of reasons.entries()) {
    const id = reason.id.toLowerCase();
    const first = ids.get(id);

    if (first !== undefined) {
      issues.push({
        path: `punish.reasons.${index}.id`,
        message: `Reason ${first + 1} already uses the ID '${reason.id}'.`,
      });
      continue;
    }
    ids.set(id, index);
  }

  const aliases = new Map<string, number>();

  for (const [index, reason] of reasons.entries()) {
    for (const [position, alias] of reason.aliases.entries()) {
      const token = alias.toLowerCase();
      const path = `punish.reasons.${index}.aliases.${position}`;
      const owner = ids.get(token);

      if (owner !== undefined && owner !== index) {
        issues.push({ path, message: `'${alias}' is already the ID of reason ${owner + 1}.` });
        continue;
      }

      const taken = aliases.get(token);
      if (taken !== undefined) {
        issues.push({
          path,
          message:
            taken === index
              ? `'${alias}' is listed twice.`
              : `Reason ${taken + 1} already uses the alias '${alias}'.`,
        });
        continue;
      }

      aliases.set(token, index);
    }
  }

  return issues;
}

export function refinePunishWrite(punish: PunishConfig): ConfigWriteIssue[] {
  const { types } = punish;
  const issues: ConfigWriteIssue[] = [];

  for (const kind of AUDITED_DIRECTIONS) {
    const message = auditReasonIssue(types[kind].auditReason);
    if (message) issues.push({ path: `punish.types.${kind}.auditReason`, message });
  }

  const timeoutPath = 'punish.types.timeout.defaultDuration';
  issues.push(...durationIssues(timeoutPath, types.timeout.defaultDuration, 'A default timeout'));

  const timeoutMs = tryParseDuration(types.timeout.defaultDuration);
  if (
    timeoutMs !== null &&
    timeoutMs > TIMEOUT_CAP_MS &&
    timeoutMs <= PUNISH_DURATION_MAX_MS &&
    !punish.extendTimeouts
  ) {
    issues.push({
      path: timeoutPath,
      message:
        'Discord ends every timeout after 28 days. Turn on Extend timeouts to use a longer ' +
        'default, or shorten it.',
    });
  }

  issues.push(
    ...durationIssues(
      'punish.types.ban.defaultDuration',
      types.ban.defaultDuration,
      'A default ban length',
    ),
    ...overlapIssues('punish.types.timeout.actions', types.timeout.actions),
    ...overlapIssues('punish.types.untimeout.actions', types.untimeout.actions),
    ...overlapIssues('punish.types.warn.actions', types.warn.actions),
    ...overlapIssues('punish.types.unwarn.actions', types.unwarn.actions),
    ...reasonIssues(punish.reasons),
  );

  return issues;
}
