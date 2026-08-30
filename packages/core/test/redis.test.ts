import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Redis } from 'ioredis';
import type { Logger } from '../src/modules/manifest.ts';
import { attachRedisLogging, describeRedisError, redactRedisUrl } from '../src/redis.ts';

function recorder(): { logger: Logger; errors: string[]; infos: string[] } {
  const errors: string[] = [];
  const infos: string[] = [];

  return {
    errors,
    infos,
    logger: {
      info: (message) => void infos.push(message),
      warn: (message) => void errors.push(message),
      error: (message) => void errors.push(message),
    },
  };
}

function fakeClient(): { client: Redis; emitter: EventEmitter } {
  const emitter = new EventEmitter();

  return { emitter, client: emitter as unknown as Redis };
}

describe('redactRedisUrl', () => {
  test('hides the password, which the deploy runbook puts in REDIS_URL', () => {
    expect(redactRedisUrl('redis://:hunter2@127.0.0.1:6379')).not.toContain('hunter2');
    expect(redactRedisUrl('redis://:hunter2@127.0.0.1:6379')).toBe('redis://:***@127.0.0.1:6379');
  });

  test('leaves a password-less url readable, so the log still names the port', () => {
    expect(redactRedisUrl('redis://localhost:6381')).toBe('redis://localhost:6381');
  });

  test('returns an unparseable url unchanged rather than throwing inside a log handler', () => {
    expect(redactRedisUrl('not a url')).toBe('not a url');
  });
});

describe('describeRedisError', () => {
  test('unwraps the aggregate node raises when every resolved address refuses', () => {
    const aggregate = new AggregateError([
      new Error('connect ECONNREFUSED ::1:6381'),
      new Error('connect ECONNREFUSED 127.0.0.1:6381'),
    ]);

    expect(describeRedisError(aggregate)).toBe(
      'connect ECONNREFUSED ::1:6381; connect ECONNREFUSED 127.0.0.1:6381',
    );
  });

  test('unwraps a bare object with an errors array, which is what bun raises', () => {
    expect(describeRedisError({ message: '', errors: [new Error('connect ECONNREFUSED')] })).toBe(
      'connect ECONNREFUSED',
    );
  });

  test('collapses one repeated cause into a single clause', () => {
    const aggregate = new AggregateError([new Error('same'), new Error('same')]);

    expect(describeRedisError(aggregate)).toBe('same');
  });

  test('falls back to the name when an error carries no message', () => {
    expect(describeRedisError(new TypeError())).toBe('TypeError');
  });
});

describe('attachRedisLogging', () => {
  test('reports the first failure and names the label and the host', () => {
    const { logger, errors } = recorder();
    const { client, emitter } = fakeClient();

    attachRedisLogging(client, { label: 'worker/bus', url: 'redis://localhost:6381', logger });
    emitter.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:6381'));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('worker/bus');
    expect(errors[0]).toContain('redis://localhost:6381');
    expect(errors[0]).toContain('connect ECONNREFUSED 127.0.0.1:6381');
  });

  test('stays silent while the same outage keeps retrying', () => {
    const { logger, errors } = recorder();
    const { client, emitter } = fakeClient();

    attachRedisLogging(client, { label: 'worker/bus', url: 'redis://localhost:6381', logger });
    for (let i = 0; i < 20; i += 1) emitter.emit('error', new Error('connect ECONNREFUSED'));

    expect(errors).toHaveLength(1);
  });

  test('counts the suppressed attempts in the recovery line', () => {
    const { logger, infos } = recorder();
    const { client, emitter } = fakeClient();

    attachRedisLogging(client, { label: 'worker/bus', url: 'redis://localhost:6381', logger });
    for (let i = 0; i < 3; i += 1) emitter.emit('error', new Error('connect ECONNREFUSED'));
    emitter.emit('ready');

    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain('3 failed attempt(s)');
  });

  test('says nothing on a first connect, so a healthy boot stays quiet', () => {
    const { logger, errors, infos } = recorder();
    const { client, emitter } = fakeClient();

    attachRedisLogging(client, { label: 'worker/bus', url: 'redis://localhost:6381', logger });
    emitter.emit('ready');

    expect(errors).toHaveLength(0);
    expect(infos).toHaveLength(0);
  });

  test('reports a second outage after a recovery', () => {
    const { logger, errors } = recorder();
    const { client, emitter } = fakeClient();

    attachRedisLogging(client, { label: 'worker/bus', url: 'redis://localhost:6381', logger });
    emitter.emit('error', new Error('connect ECONNREFUSED'));
    emitter.emit('ready');
    emitter.emit('error', new Error('connect ECONNREFUSED'));

    expect(errors).toHaveLength(2);
  });

  test('keeps the password out of the log line', () => {
    const { logger, errors } = recorder();
    const { client, emitter } = fakeClient();

    attachRedisLogging(client, {
      label: 'worker/bus',
      url: 'redis://:hunter2@127.0.0.1:6379',
      logger,
    });
    emitter.emit('error', new Error('connect ECONNREFUSED'));

    expect(errors[0]).not.toContain('hunter2');
  });
});
