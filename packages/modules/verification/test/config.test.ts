import { describe, expect, test } from 'bun:test';
import { type FieldDescriptor, zodToDescriptors } from '@proton/core';
import {
  DEFAULT_PANEL,
  liftStoredConfig,
  VERIFICATION_FAILURE_ACTIONS,
  VERIFICATION_MODES,
  verificationConfigSchema,
  verificationDefaultConfig,
  verificationFormSchema,
  verificationPanelSchema,
} from '../src/config.ts';

// The form schema, not the config: `panel` is an authored message the generator cannot render, and
// the manifest declares it the same way.
const DESCRIPTORS = zodToDescriptors(verificationFormSchema);

function descriptor(path: string): FieldDescriptor {
  const found = DESCRIPTORS.find((candidate) => candidate.path === path);
  if (!found) throw new Error(`verification has no '${path}' field`);

  return found;
}

const CAPTCHA_ONLY = [
  'captchaDelivery',
  'captchaLength',
  'captchaAttempts',
  'captchaExpiry',
  'failureAction',
];

const ALWAYS_SHOWN = [
  'mode',
  'panelChannelId',
  'panelButtonLabel',
  'panelButtonEmoji',
  'panelButtonStyle',
  'unverifiedRoleId',
  'verifiedRoleId',
  'applyUnverifiedOnJoin',
  'quarantineRoleId',
];

describe('what the dashboard shows for each mode', () => {
  test.each(CAPTCHA_ONLY)('%s appears only while the mode is captcha', (path) => {
    expect(descriptor(path).showWhen).toEqual({ path: 'mode', equals: ['captcha'] });
  });

  test.each(ALWAYS_SHOWN)('%s is shown whatever the mode is', (path) => {
    expect(descriptor(path).showWhen).toBeUndefined();
  });

  test('the timeout length appears only once a timeout is the thing that happens', () => {
    expect(descriptor('failureTimeout').showWhen).toEqual({
      path: 'failureAction',
      equals: ['timeout'],
    });
  });

  // zodToDescriptors refuses a showWhen naming a value the target enum does not have, so this is
  // what stops a renamed mode leaving a field hidden in every mode and uneditable.
  test.each([...CAPTCHA_ONLY, 'failureTimeout'])('%s names a value its controller has', (path) => {
    const when = descriptor(path).showWhen;
    if (!when) throw new Error(`${path} lost its showWhen`);

    const controller = descriptor(when.path);
    if (controller.kind !== 'enum') throw new Error(`${when.path} is not an enum`);

    for (const value of when.equals) expect(controller.options).toContain(value);
  });
});

describe('what an admin reads rather than what the schema stores', () => {
  test('every mode is offered in words, not as its schema string', () => {
    const mode = descriptor('mode');
    if (mode.kind !== 'enum') throw new Error('mode is not an enum');

    expect(Object.keys(mode.optionLabels ?? {}).sort()).toEqual([...VERIFICATION_MODES].sort());
    expect(mode.optionLabels?.website).not.toBe('website');
  });

  test('every failure action is offered in words', () => {
    const action = descriptor('failureAction');
    if (action.kind !== 'enum') throw new Error('failureAction is not an enum');

    expect(Object.keys(action.optionLabels ?? {}).sort()).toEqual(
      [...VERIFICATION_FAILURE_ACTIONS].sort(),
    );
  });
});

describe('the shipped defaults', () => {
  test('gate nobody, challenge nobody and punish nobody', () => {
    expect(verificationDefaultConfig.enabled).toBe(false);
    expect(verificationDefaultConfig.mode).toBe('button');
    expect(verificationDefaultConfig.failureAction).toBe('none');
    expect(verificationDefaultConfig.panelChannelId).toBeUndefined();
  });

  test('parse against the schema that will read them back', () => {
    expect(verificationConfigSchema.safeParse(verificationDefaultConfig).success).toBe(true);
  });
});

/**
 * v1 kept the panel as `panelTitle` and `panelBody`. Zod strips unknown keys, so without a lift the
 * next switch toggle — which sends no config at all — would persist the stripped object and every
 * guild's panel copy would be gone with nothing on screen to say it had happened.
 */
describe('reading a panel saved before it was an authored message', () => {
  test('carries the old heading and text into the message, worded as it was posted', () => {
    const lifted = verificationConfigSchema.parse(
      liftStoredConfig({
        enabled: true,
        panelTitle: 'Members only',
        panelBody: 'Press below.',
        panelButtonLabel: 'Let me in',
      }),
    );

    expect(lifted.panel.content).toBe('## Members only\n\nPress below.');
    expect(lifted.panelButtonLabel).toBe('Let me in');
  });

  test('leaves a config that has already been migrated alone', () => {
    const already = { panel: { content: 'Already a message' }, panelTitle: 'ignored' };

    expect((liftStoredConfig(already) as { panel: { content: string } }).panel.content).toBe(
      'Already a message',
    );
  });

  test('falls back to the shipped panel when there was nothing to carry', () => {
    const lifted = verificationConfigSchema.parse(liftStoredConfig({ enabled: true }));

    expect(lifted.panel).toEqual(DEFAULT_PANEL);
  });

  test('is not confused by something that is not a config object', () => {
    expect(liftStoredConfig(null)).toBeNull();
    expect(liftStoredConfig('nonsense')).toBe('nonsense');
    expect(liftStoredConfig([1, 2])).toEqual([1, 2]);
  });
});

describe('what the panel may carry', () => {
  // Proton attaches the verify button itself, and Discord allows a message one set of components.
  test('refuses a panel that brings its own button rows', () => {
    const parsed = verificationPanelSchema.safeParse({
      content: 'Verify',
      components: [
        {
          kind: 'buttons',
          buttons: [
            {
              key: 'x',
              style: 'primary',
              label: 'Press',
              action: { kind: 'reply', content: 'hi' },
            },
          ],
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  test('refuses a components layout, which cannot carry an action row', () => {
    const parsed = verificationPanelSchema.safeParse({ v2: [{ kind: 'text', content: 'Verify' }] });

    expect(parsed.success).toBe(false);
  });

  test('takes text and embeds, which is what the builder offers here', () => {
    const parsed = verificationPanelSchema.safeParse({
      content: 'Read the rules.',
      embeds: [{ title: 'Members only', description: 'Press below.', color: 0x5865f2 }],
    });

    expect(parsed.success).toBe(true);
  });
});
