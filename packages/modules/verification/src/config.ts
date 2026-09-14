import {
  durationStringSchema,
  liftLegacyMessage,
  messageObjectSchema,
  protonFields,
  refineMessage,
  snowflakeSchema,
} from '@proton/core';
import { z } from 'zod';

export const VERIFICATION_MODES = ['button', 'captcha', 'website'] as const;
export type VerificationMode = (typeof VERIFICATION_MODES)[number];

export const CAPTCHA_DELIVERIES = ['channel', 'dm'] as const;
export type CaptchaDelivery = (typeof CAPTCHA_DELIVERIES)[number];

export const VERIFICATION_FAILURE_ACTIONS = [
  'none',
  'kick',
  'ban',
  'timeout',
  'quarantine',
] as const;
export type VerificationFailureAction = (typeof VERIFICATION_FAILURE_ACTIONS)[number];

export const BUTTON_LABEL_MAX = 80;
export const BUTTON_EMOJI_MAX = 64;

// Every button style except link. A link button carries no custom_id, so it never comes back to
// Proton — picking it would post a panel whose button cannot verify anybody.
export const PANEL_BUTTON_STYLES = ['primary', 'secondary', 'success', 'danger'] as const;
export type PanelButtonStyle = (typeof PANEL_BUTTON_STYLES)[number];

export const CAPTCHA_LENGTH_MIN = 4;
export const CAPTCHA_LENGTH_MAX = 8;
export const CAPTCHA_ATTEMPTS_MAX = 5;

const captchaOnly = { path: 'mode', equals: ['captcha'] };

/**
 * Proton attaches the verify button to whatever this message is, so the panel authors the text and
 * the embeds and Proton owns the one row. Rejecting the two it cannot carry here rather than
 * dropping them silently: a save that quietly deleted an admin's button row would look like the
 * builder losing work.
 */
export function refineVerificationPanel(
  message: { components: unknown[]; v2?: unknown[] | undefined },
  ctx: z.RefinementCtx,
): void {
  if ((message.v2?.length ?? 0) > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['v2'],
      message:
        'the verification panel is posted with Proton’s own verify button attached, and Discord ' +
        'will not put a button row on a components layout. Build this panel from text and embeds.',
    });
  }

  if (message.components.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['components'],
      message:
        'Proton adds the verify button to this panel itself, so it cannot carry button rows of ' +
        'its own — a second row would be posted under a button nobody configured.',
    });
  }
}

export const verificationPanelSchema = z.preprocess(
  liftLegacyMessage,
  messageObjectSchema.superRefine((message, ctx) => {
    refineMessage(message, ctx);
    refineVerificationPanel(message, ctx);
  }),
);

export type VerificationPanel = z.infer<typeof verificationPanelSchema>;

// Parsed at import, so a malformed default is a boot failure everywhere rather than something one
// guild's save discovers. The wording is what buildPanelMessage used to compose from panelTitle and
// panelBody, so a server that never touches this sees the panel it already had.
export const DEFAULT_PANEL: VerificationPanel = verificationPanelSchema.parse({
  content: '## Verify to get access\n\nPress the button below to unlock the rest of the server.',
});

/**
 * v1 kept the panel as `panelTitle` and `panelBody`, two strings this composed into one line of
 * markdown at send time. Zod would strip both and the next switch toggle — which sends no config —
 * would persist the stripped object, so the panel text has to be carried over here rather than
 * left to be silently dropped.
 */
export function liftStoredConfig(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;

  const source = raw as Record<string, unknown>;
  if (Object.hasOwn(source, 'panel')) return raw;

  const { panelTitle, panelBody, ...rest } = source;
  const title = typeof panelTitle === 'string' ? panelTitle : '';
  const body = typeof panelBody === 'string' ? panelBody : '';

  if (title === '' && body === '') return rest;

  return { ...rest, panel: { content: `## ${title}\n\n${body}` } };
}

export const verificationConfigSchema = z.object({
  enabled: z.boolean().default(false).register(protonFields, { label: 'Enabled' }),

  mode: z
    .enum(VERIFICATION_MODES)
    .default('button')
    .register(protonFields, {
      label: 'Verification method',
      optionLabels: {
        button: 'Press a button',
        captcha: 'Solve a captcha',
        website: 'Sign in on Proton’s website',
      },
    }),

  panelChannelId: snowflakeSchema.optional().register(protonFields, {
    field: 'channel-id',
    label: 'Panel channel',
    description: 'Where Proton posts the panel members use to verify.',

    channelTypes: [0, 5],
  }),

  panel: verificationPanelSchema
    .default(() => DEFAULT_PANEL)
    .register(protonFields, { label: 'Panel message' }),

  panelButtonLabel: z
    .string()
    .min(1)
    .max(BUTTON_LABEL_MAX)
    .default('Verify')
    .register(protonFields, { label: 'Button label' }),

  panelButtonEmoji: z
    .string()
    .max(BUTTON_EMOJI_MAX)
    .optional()
    .register(protonFields, { label: 'Button emoji' }),

  // Green by default because that is the colour every panel Proton has already posted is wearing:
  // this field arrived after them, and a different default would have repainted all of them on the
  // next save.
  panelButtonStyle: z
    .enum(PANEL_BUTTON_STYLES)
    .default('success')
    .register(protonFields, {
      label: 'Button colour',
      optionLabels: {
        primary: 'Blurple',
        secondary: 'Grey',
        success: 'Green',
        danger: 'Red',
      },
    }),

  unverifiedRoleId: snowflakeSchema.optional().register(protonFields, {
    field: 'role-id',
    label: 'Unverified role',
    description:
      'Removed when a member verifies. Until Proton adds it, new members briefly have full access.',
  }),

  verifiedRoleId: snowflakeSchema
    .optional()
    .register(protonFields, { field: 'role-id', label: 'Member role' }),

  applyUnverifiedOnJoin: z
    .boolean()
    .default(true)
    .register(protonFields, { label: 'Apply the unverified role on join' }),

  captchaDelivery: z
    .enum(CAPTCHA_DELIVERIES)
    .default('channel')
    .register(protonFields, {
      label: 'Send captcha',
      description: 'Members with DMs closed always get it in the channel.',

      optionLabels: {
        channel: 'Privately in the channel',
        dm: 'By direct message',
      },
      showWhen: captchaOnly,
    }),

  captchaLength: z
    .number()
    .int()
    .min(CAPTCHA_LENGTH_MIN)
    .max(CAPTCHA_LENGTH_MAX)
    .default(6)
    .register(protonFields, { label: 'Characters', showWhen: captchaOnly }),

  captchaAttempts: z
    .number()
    .int()
    .min(1)
    .max(CAPTCHA_ATTEMPTS_MAX)
    .default(3)
    .register(protonFields, { label: 'Attempts allowed', showWhen: captchaOnly }),

  captchaExpiry: durationStringSchema.default('5m').register(protonFields, {
    field: 'duration',
    label: 'Expires after',
    showWhen: captchaOnly,
  }),

  failureAction: z
    .enum(VERIFICATION_FAILURE_ACTIONS)
    .default('none')
    .register(protonFields, {
      label: 'Action',
      description: 'What Proton does when a member runs out of attempts.',

      optionLabels: {
        none: 'Nothing — let them try again',
        kick: 'Kick',
        ban: 'Ban',
        timeout: 'Timeout',
        quarantine: 'Add quarantine role',
      },
      showWhen: captchaOnly,
    }),

  failureTimeout: durationStringSchema.default('1h').register(protonFields, {
    field: 'duration',
    label: 'Timeout duration',
    description: 'Discord caps timeouts at 28 days.',

    showWhen: { path: 'failureAction', equals: ['timeout'] },
  }),

  quarantineRoleId: snowflakeSchema.optional().register(protonFields, {
    field: 'role-id',
    label: 'Quarantine role',
  }),
});

// The one field the generated descriptors cannot render: an authored message is a whole builder,
// not a form row. The dashboard's verification route draws it with MessageBuilder instead.
export const verificationFormSchema = verificationConfigSchema.omit({ panel: true });

export type VerificationConfig = z.infer<typeof verificationConfigSchema>;

export const verificationDefaultConfig: VerificationConfig = {
  enabled: false,
  mode: 'button',

  panel: DEFAULT_PANEL,
  panelButtonLabel: 'Verify',
  panelButtonStyle: 'success',
  applyUnverifiedOnJoin: true,
  captchaDelivery: 'channel',
  captchaLength: 6,
  captchaAttempts: 3,
  captchaExpiry: '5m',
  failureAction: 'none',
  failureTimeout: '1h',
};

// Every v1 key kept its name and meaning, so a stored v1 config parses unchanged and needs no lift.
export const VERIFICATION_SCHEMA_VERSION = 3;
