import auditLogChannelDelete from '../gateway/audit-log-channel-delete.json' with { type: 'json' };
import auditLogChannelDeleteBurst from '../gateway/audit-log-channel-delete-burst.json' with {
  type: 'json',
};
import automodExecution from '../gateway/automod-execution.json' with { type: 'json' };
import automodExecutionBlocked from '../gateway/automod-execution-blocked.json' with {
  type: 'json',
};
import channelCreate from '../gateway/channel-create.json' with { type: 'json' };
import channelDelete from '../gateway/channel-delete.json' with { type: 'json' };
import channelObfuscated from '../gateway/channel-obfuscated.json' with { type: 'json' };
import channelPinsUpdate from '../gateway/channel-pins-update.json' with { type: 'json' };
import channelUpdate from '../gateway/channel-update.json' with { type: 'json' };
import guildBanAdd from '../gateway/guild-ban-add.json' with { type: 'json' };
import guildBanRemove from '../gateway/guild-ban-remove.json' with { type: 'json' };
import guildCreate from '../gateway/guild-create.json' with { type: 'json' };
import guildMemberAdd from '../gateway/guild-member-add.json' with { type: 'json' };
import guildMemberAddBot from '../gateway/guild-member-add-bot.json' with { type: 'json' };
import guildMemberAddPending from '../gateway/guild-member-add-pending.json' with { type: 'json' };
import guildMemberUpdate from '../gateway/guild-member-update.json' with { type: 'json' };
import guildMemberUpdateScreened from '../gateway/guild-member-update-screened.json' with {
  type: 'json',
};
import guildRoleCreate from '../gateway/guild-role-create.json' with { type: 'json' };
import guildRoleDelete from '../gateway/guild-role-delete.json' with { type: 'json' };
import guildRoleUpdate from '../gateway/guild-role-update.json' with { type: 'json' };
import guildUpdate from '../gateway/guild-update.json' with { type: 'json' };
import interactionCreateComponent from '../gateway/interaction-create-component.json' with {
  type: 'json',
};
import interactionCreatePing from '../gateway/interaction-create-ping.json' with { type: 'json' };
import inviteCreate from '../gateway/invite-create.json' with { type: 'json' };
import inviteDelete from '../gateway/invite-delete.json' with { type: 'json' };
import messageCreate from '../gateway/message-create.json' with { type: 'json' };
import messageDelete from '../gateway/message-delete.json' with { type: 'json' };
import messageDeleteBulk from '../gateway/message-delete-bulk.json' with { type: 'json' };
import messageReactionAdd from '../gateway/message-reaction-add.json' with { type: 'json' };
import messageReactionRemove from '../gateway/message-reaction-remove.json' with { type: 'json' };
import messageUpdate from '../gateway/message-update.json' with { type: 'json' };
import ready from '../gateway/ready.json' with { type: 'json' };
import threadCreate from '../gateway/thread-create.json' with { type: 'json' };
import threadDelete from '../gateway/thread-delete.json' with { type: 'json' };
import threadUpdate from '../gateway/thread-update.json' with { type: 'json' };
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
  guildMemberAddBot: guildMemberAddBot as unknown as RawDispatch,
  guildMemberAddPending: guildMemberAddPending as unknown as RawDispatch,
  messageCreate: messageCreate as unknown as RawDispatch,

  messageUpdate: messageUpdate as unknown as RawDispatch,
  messageDelete: messageDelete as unknown as RawDispatch,

  messageDeleteBulk: messageDeleteBulk as unknown as RawDispatch,
  interactionCreatePing: interactionCreatePing as unknown as RawDispatch,

  interactionCreateComponent: interactionCreateComponent as unknown as RawDispatch,
  channelObfuscated: channelObfuscated as unknown as RawDispatch,
  auditLogChannelDelete: auditLogChannelDelete as unknown as RawDispatch,

  guildMemberUpdate: guildMemberUpdate as unknown as RawDispatch,
  guildMemberUpdateScreened: guildMemberUpdateScreened as unknown as RawDispatch,

  messageReactionAdd: messageReactionAdd as unknown as RawDispatch,
  messageReactionRemove: messageReactionRemove as unknown as RawDispatch,
  voiceStateJoin: voiceStateJoin as unknown as RawDispatch,

  automodExecution: automodExecution as unknown as RawDispatch,
  automodExecutionBlocked: automodExecutionBlocked as unknown as RawDispatch,

  voiceStateLeave: voiceStateLeave as unknown as RawDispatch,

  guildUpdate: guildUpdate as unknown as RawDispatch,
  channelCreate: channelCreate as unknown as RawDispatch,
  channelUpdate: channelUpdate as unknown as RawDispatch,
  channelDelete: channelDelete as unknown as RawDispatch,
  channelPinsUpdate: channelPinsUpdate as unknown as RawDispatch,
  threadCreate: threadCreate as unknown as RawDispatch,
  threadUpdate: threadUpdate as unknown as RawDispatch,
  threadDelete: threadDelete as unknown as RawDispatch,
  guildRoleCreate: guildRoleCreate as unknown as RawDispatch,
  guildRoleUpdate: guildRoleUpdate as unknown as RawDispatch,
  guildRoleDelete: guildRoleDelete as unknown as RawDispatch,
  guildBanAdd: guildBanAdd as unknown as RawDispatch,
  guildBanRemove: guildBanRemove as unknown as RawDispatch,
  inviteCreate: inviteCreate as unknown as RawDispatch,
  inviteDelete: inviteDelete as unknown as RawDispatch,
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
