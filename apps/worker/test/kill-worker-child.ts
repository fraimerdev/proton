#!/usr/bin/env bun
/**
 * A worker that dies mid-event, on purpose.
 *
 * Spawned as a real OS process by redelivery.integration.test.ts so the Gate 0
 * criterion is proven by an actual kill — not by a mocked failure or a closed
 * subscription, either of which could pass while the real reclaim path is broken.
 *
 * It reads one event, records that it saw it, and exits before acknowledging or
 * performing any side effect.
 */
import { RedisStreamsEventBus } from '@proton/core';
import Redis from 'ioredis';

const url = process.env.REDIS_URL;
if (!url) throw new Error('REDIS_URL is required');

const redis = new Redis(url);
const bus = new RedisStreamsEventBus(redis, { blockMs: 100, claimIdleMs: 300 });

bus.subscribe('killgroup', ['interaction.command'], async (event) => {
  await redis.set('child:received', event.id);
  // Hard exit: no ack, no side effect, no cleanup. The stream entry stays
  // pending against this consumer until another one reclaims it.
  process.exit(9);
});
