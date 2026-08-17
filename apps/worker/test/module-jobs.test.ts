import { describe, expect, test } from 'bun:test';
import { type Logger, type ModuleManifest, ModuleRegistry, Permissions } from '@proton/core';
import { createModuleRegistry } from '@proton/modules';
import { z } from 'zod';
import {
  assertHandlersCoverJobs,
  declaredJobs,
  jobKey,
  UnhandledModuleJobError,
} from '../src/module-jobs.ts';

const configSchema = z.object({ enabled: z.boolean() });

function moduleWithJobs(id: string, jobIds: string[]): ModuleManifest {
  return {
    id,
    name: id,
    category: 'utility',
    configSchema,
    defaultConfig: { enabled: false },
    schemaVersion: 1,
    requiredIntents: [],
    requiredPermissions: [Permissions.ViewChannel],
    jobs: jobIds.map((jobId) => ({ id: jobId, cron: '0 * * * *' })),
  } as unknown as ModuleManifest;
}

function silentLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      info: () => undefined,
      warn: (message) => warnings.push(message),
      error: () => undefined,
    },
  };
}

describe('the boot-time totality check', () => {
  test('refuses to start when a declared job has no handler', () => {
    const registry = new ModuleRegistry();
    registry.register(moduleWithJobs('alpha', ['refresh']));

    expect(() => assertHandlersCoverJobs(registry, {}, silentLogger().logger)).toThrow(
      UnhandledModuleJobError,
    );
  });

  test('the refusal names every unhandled job and the key it needs', () => {
    const registry = new ModuleRegistry();
    registry.register(moduleWithJobs('alpha', ['refresh', 'sweep']));
    registry.register(moduleWithJobs('beta', ['rotate']));

    try {
      assertHandlersCoverJobs(
        registry,
        { 'alpha:refresh': async () => undefined },
        silentLogger().logger,
      );
      throw new Error('expected a rejection');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('alpha:sweep');
      expect(message).toContain('beta:rotate');
      expect(message).not.toContain('alpha:refresh');
    }
  });

  test('a module declaring no jobs needs no handler', () => {
    const registry = new ModuleRegistry();
    registry.register(moduleWithJobs('alpha', []));

    expect(() => assertHandlersCoverJobs(registry, {}, silentLogger().logger)).not.toThrow();
  });

  test('warns about a handler no module declares', () => {
    const registry = new ModuleRegistry();
    registry.register(moduleWithJobs('alpha', ['refresh']));
    const { logger, warnings } = silentLogger();

    assertHandlersCoverJobs(
      registry,
      { 'alpha:refresh': async () => undefined, 'alpha:renamed': async () => undefined },
      logger,
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('alpha:renamed');
  });

  test('jobs are keyed by module and id, so two modules may share a job name', () => {
    expect(jobKey('phishing', 'refresh-blocklist')).toBe('phishing:refresh-blocklist');
    expect(jobKey('logging', 'refresh-blocklist')).not.toBe(
      jobKey('phishing', 'refresh-blocklist'),
    );
  });
});

describe('the shipped registry', () => {
  test('declares exactly the jobs the worker has handlers for', () => {
    const declared = declaredJobs(createModuleRegistry())
      .map(({ key }) => key)
      .sort();

    expect(declared).toEqual(['logging:partition-maintenance', 'phishing:refresh-blocklist']);
  });

  test('every declared job carries a cron expression', () => {
    for (const manifest of createModuleRegistry().all()) {
      for (const job of manifest.jobs ?? []) {
        expect({ module: manifest.id, job: job.id, cron: job.cron }).toEqual({
          module: manifest.id,
          job: job.id,
          cron: expect.stringMatching(/^\S+( \S+){4}$/),
        });
      }
    }
  });
});
