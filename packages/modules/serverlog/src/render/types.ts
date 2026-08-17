import type { AuditEntry, CachedMessage } from '@proton/core';
import type { LogExecutor } from '../embed.ts';
import type { EmojiSet } from '../emoji.ts';

export interface RenderInput {
  guildId: string;

  entity: unknown;
  audit: AuditEntry | null;

  // The message as it was before this event, when Message logs is remembering recent text.
  cached?: CachedMessage | null | undefined;

  executor: LogExecutor | null;
  occurredAt: number;
  emojis: EmojiSet;
}

export interface RenderResult {
  embed: Record<string, unknown>;
}

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export function changeOf(
  audit: AuditEntry | null,
  key: string,
): { before?: string; after?: string } {
  const change = audit?.changes.find((candidate) => candidate.key === key);
  if (!change) return {};

  return {
    ...(change.old_value === undefined ? {} : { before: display(change.old_value) }),
    ...(change.new_value === undefined ? {} : { after: display(change.new_value) }),
  };
}

export function display(value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'string') return value.length > 0 ? value : 'none';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  return JSON.stringify(value);
}
