import { describe, expect, test } from 'bun:test';
import { caseQuerySchema } from '@proton/core';
import { z } from 'zod';

function chain(validators: readonly z.ZodType[], input: unknown): unknown {
  return validators.reduce<unknown>((data, validator) => validator.parse(data), input);
}

const guildAccessValidator = z.looseObject({ guildId: z.string().min(1) });

describe('server-function middleware validators', () => {
  test('a guild-scoped middleware passes through fields it does not read', () => {
    const getModuleConfig = z.object({
      guildId: z.string().min(1),
      moduleId: z.string().min(1),
    });

    expect(
      chain([guildAccessValidator, getModuleConfig], {
        guildId: '1400000000000000001',
        moduleId: 'cases',
      }),
    ).toEqual({ guildId: '1400000000000000001', moduleId: 'cases' });
  });

  test('case-search filters survive the middleware instead of being silently dropped', () => {
    const searchCases = caseQuerySchema.extend({ guildId: z.string().min(1) });

    const result = chain([guildAccessValidator, searchCases], {
      guildId: '1400000000000000001',
      type: 'ban',
      page: 3,
      sort: 'createdAt',
      direction: 'asc',
    }) as Record<string, unknown>;

    expect(result.type).toBe('ban');
    expect(result.page).toBe(3);
    expect(result.direction).toBe('asc');
  });

  test('the update mutation keeps its config payload', () => {
    const updateModuleConfig = z.object({
      guildId: z.string().min(1),
      moduleId: z.string().min(1),
      enabled: z.boolean().optional(),
      config: z.record(z.string(), z.unknown()).optional(),
    });

    expect(
      chain([guildAccessValidator, updateModuleConfig], {
        guildId: '1400000000000000001',
        moduleId: 'antinuke',
        enabled: true,
        config: { channelDeleteLimit: 3 },
      }),
    ).toEqual({
      guildId: '1400000000000000001',
      moduleId: 'antinuke',
      enabled: true,
      config: { channelDeleteLimit: 3 },
    });
  });

  test('the middleware still rejects a missing or empty guild id', () => {
    expect(() => guildAccessValidator.parse({ moduleId: 'cases' })).toThrow();
    expect(() => guildAccessValidator.parse({ guildId: '', moduleId: 'cases' })).toThrow();
  });

  test('a stripping object would delete the field, which is what broke the page', () => {
    const stripping = z.object({ guildId: z.string().min(1) });

    expect(stripping.parse({ guildId: 'g', moduleId: 'cases' })).toEqual({ guildId: 'g' });
  });
});
