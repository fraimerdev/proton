import auditLogChannelDelete from '../gateway/audit-log-channel-delete.json' with { type: 'json' };
import auditLogChannelDeleteBurst from '../gateway/audit-log-channel-delete-burst.json' with {
  type: 'json',
};
import channelObfuscated from '../gateway/channel-obfuscated.json' with { type: 'json' };
import guildCreate from '../gateway/guild-create.json' with { type: 'json' };
import guildMemberAdd from '../gateway/guild-member-add.json' with { type: 'json' };
import guildMemberUpdate from '../gateway/guild-member-update.json' with { type: 'json' };
import interactionCreateComponent from '../gateway/interaction-create-component.json' with {
  type: 'json',
};
import interactionCreatePing from '../gateway/interaction-create-ping.json' with { type: 'json' };
import messageCreate from '../gateway/message-create.json' with { type: 'json' };
import messageDelete from '../gateway/message-delete.json' with { type: 'json' };
import messageDeleteBulk from '../gateway/message-delete-bulk.json' with { type: 'json' };
import messageReactionAdd from '../gateway/message-reaction-add.json' with { type: 'json' };
import messageReactionRemove from '../gateway/message-reaction-remove.json' with { type: 'json' };
import messageUpdate from '../gateway/message-update.json' with { type: 'json' };
import ready from '../gateway/ready.json' with { type: 'json' };
import voiceStateJoin from '../gateway/voice-state-join.json' with { type: 'json' };
import voiceStateLeave from '../gateway/voice-state-leave.json' with { type: 'json' };

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
  /** The same message as `messageCreate`, edited to add a link. */
  messageUpdate: messageUpdate as unknown as RawDispatch,
  messageDelete: messageDelete as unknown as RawDispatch,
  /** Deliberately unsorted `ids`, so a key built from the raw array is caught. */
  messageDeleteBulk: messageDeleteBulk as unknown as RawDispatch,
  interactionCreatePing: interactionCreatePing as unknown as RawDispatch,
  /** A button press — INTERACTION_CREATE type 3, not type 2. */
  interactionCreateComponent: interactionCreateComponent as unknown as RawDispatch,
  channelObfuscated: channelObfuscated as unknown as RawDispatch,
  auditLogChannelDelete: auditLogChannelDelete as unknown as RawDispatch,

  /** Phase 3 (§8 engagement). */
  guildMemberUpdate: guildMemberUpdate as unknown as RawDispatch,
  /** A ⭐ on `messageCreate`'s message, by a different user than its author. */
  messageReactionAdd: messageReactionAdd as unknown as RawDispatch,
  messageReactionRemove: messageReactionRemove as unknown as RawDispatch,
  voiceStateJoin: voiceStateJoin as unknown as RawDispatch,
  /** The same session leaving — `channel_id: null`, which is the disconnect. */
  voiceStateLeave: voiceStateLeave as unknown as RawDispatch,
} as const;

export type DispatchName = keyof typeof dispatches;

/**
 * Recorded *bursts* — several dispatches that only mean anything together.
 *
 * Separate from `dispatches` because the unit of replay is different: a burst is
 * an ordered list whose value is the rate it describes, and flattening it into
 * twenty individually named fixtures would let a test quietly replay nineteen.
 */
export const dispatchSequences = {
  /** PLAN.md §12 Gate 2: 20 channel deletions by one actor inside 5 seconds. */
  auditLogChannelDeleteBurst: auditLogChannelDeleteBurst.dispatches as unknown as RawDispatch[],
} as const;

export type DispatchSequenceName = keyof typeof dispatchSequences;

/** Deep clone, so a test mutating a fixture cannot leak into the next test. */
export function dispatch(name: DispatchName): RawDispatch {
  return structuredClone(dispatches[name]);
}

/** Deep clone of a whole burst, for the same reason. */
export function dispatchSequence(name: DispatchSequenceName): RawDispatch[] {
  return structuredClone(dispatchSequences[name]) as RawDispatch[];
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
