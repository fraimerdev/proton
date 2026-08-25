export interface BotInvite {
  clientId: string;
  permissions: string;
}

// applications.commands rides along with bot: without it Proton joins the server and registers no
// slash commands, which reads in Discord as a bot that did nothing.
export function botInviteUrl(invite: BotInvite, guildId?: string): string {
  const params = new URLSearchParams({
    client_id: invite.clientId,
    scope: 'bot applications.commands',
    permissions: invite.permissions,
  });

  if (guildId) {
    params.set('guild_id', guildId);
    params.set('disable_guild_select', 'true');
  }

  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}
