import { describe, expect, test } from 'bun:test';
import { type FieldDescriptor, zodToDescriptors } from '@proton/core';
import {
  VERIFICATION_FAILURE_ACTIONS,
  VERIFICATION_MODES,
  verificationConfigSchema,
  verificationDefaultConfig,
} from '../src/config.ts';

const DESCRIPTORS = zodToDescriptors(verificationConfigSchema);

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
  'panelTitle',
  'panelBody',
  'panelButtonLabel',
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
