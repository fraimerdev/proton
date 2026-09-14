export const CHANNEL_NAME_MAX = 100;

export const COUNT_PLACEHOLDER = '{count}';

export const COUNTER_SOURCES = ['members', 'roles', 'channels'] as const;

export type CounterSource = (typeof COUNTER_SOURCES)[number];
