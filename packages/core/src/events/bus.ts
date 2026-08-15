import type { EventType, ProtonEvent } from './types.ts';

export interface Subscription {
  readonly group: string;

  readonly ready?: Promise<void>;

  close(): Promise<void>;
}

export type GroupStartId = '0' | '$';

export interface SubscribeOptions {
  startId?: GroupStartId;
}

export interface EventBus {
  publish(e: ProtonEvent): Promise<void>;
  subscribe(
    group: string,
    types: EventType[],
    handler: (e: ProtonEvent) => Promise<void>,
    options?: SubscribeOptions,
  ): Subscription;
}
