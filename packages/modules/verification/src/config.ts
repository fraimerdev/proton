import { durationStringSchema, protonFields, snowflakeSchema } from '@proton/core';
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

export const PANEL_TITLE_MAX = 256;
export const PANEL_BODY_MAX = 1800;
export const BUTTON_LABEL_MAX = 80;

export const CAPTCHA_LENGTH_MIN = 4;
export const CAPTCHA_LENGTH_MAX = 8;
export const CAPTCHA_ATTEMPTS_MAX = 5;

const captchaOnly = { path: 'mode', equals: ['captcha'] };

export const verificationConfigSchema = z.object({
  enabled: z.boolean().default(false).register(protonFields, { label: 'Enabled' }),

  mode: z
    .enum(VERIFICATION_MODES)
    .default('button')
    .register(protonFields, {
      label: 'How members verify',
      optionLabels: {
        button: 'Press a button',
        captcha: 'Solve a captcha',
        website: 'Sign in on Proton’s website',
      },
    }),

  panelChannelId: snowflakeSchema.optional().register(protonFields, {
    field: 'channel-id',
    label: 'Panel channel',
    description: 'Where Proton posts the message new members press',

    channelTypes: [0, 5],
  }),

  panelTitle: z
    .string()
    .max(PANEL_TITLE_MAX)
    .default('Verify to get access')
    .register(protonFields, { label: 'Panel heading' }),

  panelBody: z
    .string()
    .max(PANEL_BODY_MAX)
    .default('Press the button below to unlock the rest of the server.')
    .register(protonFields, { label: 'Panel text' }),

  panelButtonLabel: z
    .string()
    .min(1)
    .max(BUTTON_LABEL_MAX)
    .default('Verify')
    .register(protonFields, { label: 'Button label' }),

  unverifiedRoleId: snowflakeSchema.optional().register(protonFields, {
    field: 'role-id',
    label: 'Unverified role',
    description: 'New members are briefly ungated until Proton applies it',
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
      label: 'Send the captcha',
      description: 'A member with DMs closed is always answered in the channel instead',

      optionLabels: {
        channel: 'In the channel, where only they can see it',
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
    label: 'Captcha expires after',
    showWhen: captchaOnly,
  }),

  failureAction: z
    .enum(VERIFICATION_FAILURE_ACTIONS)
    .default('none')
    .register(protonFields, {
      label: 'When a member runs out of attempts',

      optionLabels: {
        none: 'Nothing — let them try again',
        kick: 'Kick them',
        ban: 'Ban them',
        timeout: 'Time them out',
        quarantine: 'Give them the quarantine role',
      },
      showWhen: captchaOnly,
    }),

  failureTimeout: durationStringSchema.default('1h').register(protonFields, {
    field: 'duration',
    label: 'Timeout length',
    description: 'Discord caps timeouts at 28 days',

    showWhen: { path: 'failureAction', equals: ['timeout'] },
  }),

  quarantineRoleId: snowflakeSchema.optional().register(protonFields, {
    field: 'role-id',
    label: 'Quarantine role',
  }),
});

export type VerificationConfig = z.infer<typeof verificationConfigSchema>;

export const verificationDefaultConfig: VerificationConfig = {
  enabled: false,
  mode: 'button',
  panelTitle: 'Verify to get access',
  panelBody: 'Press the button below to unlock the rest of the server.',
  panelButtonLabel: 'Verify',
  applyUnverifiedOnJoin: true,
  captchaDelivery: 'channel',
  captchaLength: 6,
  captchaAttempts: 3,
  captchaExpiry: '5m',
  failureAction: 'none',
  failureTimeout: '1h',
};

// Every v1 key kept its name and meaning, so a stored v1 config parses unchanged and needs no lift.
export const VERIFICATION_SCHEMA_VERSION = 2;
