import { describe, expect, test } from 'bun:test';
import { zodToDescriptors } from '@proton/core';
import {
  LOGGING_SCHEMA_VERSION,
  loggingConfigSchema,
  loggingDefaultConfig,
  MESSAGE_LOG_RETENTION_DAYS,
} from '../src/config.ts';

describe('logging config', () => {
  test('is disabled by default — the Gate 1 opt-in requirement', () => {
    expect(loggingDefaultConfig.enabled).toBe(false);
    expect(loggingConfigSchema.parse({}).enabled).toBe(false);
  });

  test('collects nothing extra by default', () => {
    expect(loggingDefaultConfig.ignoredChannels).toEqual([]);
  });

  test('the declared default satisfies the schema', () => {
    expect(loggingConfigSchema.safeParse(loggingDefaultConfig).success).toBe(true);
  });

  test('parsing fills every field, so a stored config can never be half-shaped (I5)', () => {
    expect(loggingConfigSchema.parse({})).toEqual(loggingDefaultConfig);
  });

  test('rejects an ignore list long enough to be a mistake', () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => String(100000000000000000n + BigInt(i)));
    expect(loggingConfigSchema.safeParse({ ignoredChannels: tooMany }).success).toBe(false);
  });

  test('retention is the owner-recorded 30 days', () => {
    expect(MESSAGE_LOG_RETENTION_DAYS).toBe(30);
  });

  test('has a schema version to migrate from', () => {
    expect(LOGGING_SCHEMA_VERSION).toBe(1);
  });
});

describe('dashboard descriptors', () => {
  const descriptors = zodToDescriptors(loggingConfigSchema);
  const byPath = new Map(descriptors.map((d) => [d.path, d]));

  test('every field is renderable by the v1 form generator (§9)', () => {
    expect([...byPath.keys()]).toEqual(['enabled', 'logEdits', 'logDeletes', 'ignoredChannels']);
  });

  test('the opt-in toggle carries a description naming what is stored', () => {
    const enabled = byPath.get('enabled');
    expect(enabled?.kind).toBe('boolean');
    expect(enabled?.defaultValue).toBe(false);
    expect(enabled?.description).toContain('personal data');
  });

  test('ignored channels render as a repeated channel picker, not a text box', () => {
    const ignored = byPath.get('ignoredChannels');
    expect(ignored?.kind).toBe('channel-id');
    expect(ignored?.array).toBe(true);
  });
});
