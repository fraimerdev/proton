import channelObfuscated from '../gateway/channel-obfuscated.json' with { type: 'json' };
import guildCreate from '../gateway/guild-create.json' with { type: 'json' };
import guildMemberAdd from '../gateway/guild-member-add.json' with { type: 'json' };
import interactionCreatePing from '../gateway/interaction-create-ping.json' with { type: 'json' };
import messageCreate from '../gateway/message-create.json' with { type: 'json' };
import ready from '../gateway/ready.json' with { type: 'json' };

/** A raw gateway dispatch as it arrives on the wire. */
export interface RawDispatch {
  t: string;
  s: number;
  op: number;
  d: Record<string, unknown>;
}

/**
 * Recorded gateway payloads (PLAN.md §11, I11).
 *
 * Tests replay these instead of calling Discord, so CI is deterministic and the
 * real bot token never appears in a test run.
 */
export const dispatches = {
  ready: ready as unknown as RawDispatch,
  guildCreate: guildCreate as unknown as RawDispatch,
  guildMemberAdd: guildMemberAdd as unknown as RawDispatch,
  messageCreate: messageCreate as unknown as RawDispatch,
  interactionCreatePing: interactionCreatePing as unknown as RawDispatch,
  channelObfuscated: channelObfuscated as unknown as RawDispatch,
} as const;

export type DispatchName = keyof typeof dispatches;

/** Deep clone, so a test mutating a fixture cannot leak into the next test. */
export function dispatch(name: DispatchName): RawDispatch {
  return structuredClone(dispatches[name]);
}

/** Feed a sequence of dispatches through a normaliser or handler. */
export async function replay(
  names: readonly DispatchName[],
  handle: (raw: RawDispatch) => void | Promise<void>,
): Promise<void> {
  for (const name of names) {
    await handle(dispatch(name));
  }
}
