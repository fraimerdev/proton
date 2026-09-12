import { createContext, type ReactElement, type ReactNode, useContext, useMemo } from 'react';
import type { GuildEmoji } from '../../lib/discord.ts';

export interface EmojiCatalog {
  emojis: readonly GuildEmoji[];
  guildName: string;
  guildIcon: string | null;
}

const EMPTY: EmojiCatalog = { emojis: [], guildName: 'This server', guildIcon: null };

const CatalogContext = createContext<EmojiCatalog>(EMPTY);

/**
 * The server's own emoji, for every picker on the page. A context rather than a prop because the
 * control that needs it is a leaf — a button inside a select option inside a component row inside
 * the message builder — and threading a guild-wide read-only list through six layers to reach it
 * is six components that gain a prop they only pass on.
 *
 * The default is an empty catalog, so a picker rendered outside a module form still works and
 * simply offers unicode alone. There is nothing to throw about.
 */
export function EmojiCatalogProvider({
  emojis,
  guildName,
  guildIcon,
  children,
}: EmojiCatalog & { children: ReactNode }): ReactElement {
  const value = useMemo(() => ({ emojis, guildName, guildIcon }), [emojis, guildName, guildIcon]);

  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}

export function useEmojiCatalog(): EmojiCatalog {
  return useContext(CatalogContext);
}
