import type { CommandSyncState } from '@proton/core';

export const COMMANDS_POLL_MS = 3_000;
export const COMMANDS_POLL_WINDOW_MS = 120_000;

export function commandsPollInterval(
  state: CommandSyncState | undefined,
  pendingSince: number,
  now: number,
): number | false {
  if (state !== 'pending') return false;
  return now - pendingSince < COMMANDS_POLL_WINDOW_MS ? COMMANDS_POLL_MS : false;
}
