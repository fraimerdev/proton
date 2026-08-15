#!/usr/bin/env bun

import { RedisStreamsEventBus } from '@proton/core';
import Redis from 'ioredis';

const url = process.env.REDIS_URL;
if (!url) throw new Error('REDIS_URL is required');

const redis = new Redis(url);
const bus = new RedisStreamsEventBus(redis, { blockMs: 100, claimIdleMs: 300 });

bus.subscribe('killgroup', ['interaction.command'], async (event) => {
  await redis.set('child:received', event.id);

  process.exit(9);
});
