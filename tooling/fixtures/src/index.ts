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

export interface RawDispatch {
  t: string;
  s: number;
  op: number;
  d: Record<string, unknown>;
}

export const dispatches = {
  ready: ready as unknown as RawDispatch,
  guildCreate: guildCreate as unknown as RawDispatch,
  guildMemberAdd: guildMemberAdd as unknown as RawDispatch,
  messageCreate: messageCreate as unknown as RawDispatch,

  messageUpdate: messageUpdate as unknown as RawDispatch,
  messageDelete: messageDelete as unknown as RawDispatch,

  messageDeleteBulk: messageDeleteBulk as unknown as RawDispatch,
  interactionCreatePing: interactionCreatePing as unknown as RawDispatch,

  interactionCreateComponent: interactionCreateComponent as unknown as RawDispatch,
  channelObfuscated: channelObfuscated as unknown as RawDispatch,
  auditLogChannelDelete: auditLogChannelDelete as unknown as RawDispatch,

  guildMemberUpdate: guildMemberUpdate as unknown as RawDispatch,

  messageReactionAdd: messageReactionAdd as unknown as RawDispatch,
  messageReactionRemove: messageReactionRemove as unknown as RawDispatch,
  voiceStateJoin: voiceStateJoin as unknown as RawDispatch,

  voiceStateLeave: voiceStateLeave as unknown as RawDispatch,
} as const;

export type DispatchName = keyof typeof dispatches;

export const dispatchSequences = {
  auditLogChannelDeleteBurst: auditLogChannelDeleteBurst.dispatches as unknown as RawDispatch[],
} as const;

export type DispatchSequenceName = keyof typeof dispatchSequences;

export function dispatch(name: DispatchName): RawDispatch {
  return structuredClone(dispatches[name]);
}

export function dispatchSequence(name: DispatchSequenceName): RawDispatch[] {
  return structuredClone(dispatchSequences[name]) as RawDispatch[];
}

export async function replay(
  names: readonly DispatchName[],
  handle: (raw: RawDispatch) => void | Promise<void>,
): Promise<void> {
  for (const name of names) {
    await handle(dispatch(name));
  }
}
