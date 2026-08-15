import type { SourceMessage } from './source.ts';
import type { StarboardStore } from './store.ts';

/**
 * What to read, and how much of it.
 *
 * `withReactors` exists because Discord's reaction object names nobody: it
 * carries `count`, `count_details`, `me`, `me_burst`, `emoji` and `burst_colors`
 * (verified against the message resource reference), so "did the author star
 * their own message" is a second endpoint —
 * `GET /channels/{c}/messages/{m}/reactions/{emoji}` — and a second round trip.
 * Only a guild with `selfStarAllowed` off needs it, so the module says when it
 * needs it rather than making every guild pay for the strictest one's setting.
 */
export interface SourceMessageRequest {
  channelId: string;
  messageId: string;
  /** The configured emoji, in Discord's URL form: `⭐`, or `name:id` for a custom one. */
  emoji: string;
  /** Resolve `SourceMessage.starredBy` as well as the counts. */
  withReactors: boolean;
}

/** What `resolveBoardPost` is asked to find. */
export interface BoardPostQuery {
  boardChannelId: string;
  sourceMessageId: string;
  /** The `https://discord.com/channels/...` link the board post's embed carries. */
  jumpUrl: string;
}

/**
 * Everything this module needs that `ModuleContext` cannot give it (§7).
 *
 * A module gets a guild id, its config, an executor and a logger — no database
 * and no REST client, and it must not construct one (I2). So the ports are
 * declared here and bound by whatever process runs modules, exactly as
 * `createBackupModule({ readLayout })` binds its view of the guild. All three
 * are optional so the manifest still registers, renders in the dashboard and
 * typechecks with nothing bound; what must never happen is a guild enabling the
 * starboard and getting silence, which `describeUnbound` exists to prevent.
 */
export interface StarboardDeps {
  /** Where board posts are remembered. `DrizzleStarboardStore` from this package. */
  store?: StarboardStore;

  /**
   * Read the message a reaction is about.
   *
   * The load-bearing port. Reactions carry no id of their own, so the module
   * never counts events — it re-reads the message and counts the reactions on
   * it, which is what makes a RESUME redelivery and a genuine
   * react → unreact → react indistinguishable *and harmless*.
   *
   * `GET /channels/{c}/messages/{m}`, which needs VIEW_CHANNEL and
   * READ_MESSAGE_HISTORY (verified). Null when the message is gone or
   * unreadable; the caller says so rather than treating it as zero stars, which
   * would delete a board post whose original merely could not be fetched.
   */
  readMessage?(request: SourceMessageRequest): Promise<SourceMessage | null>;

  /**
   * Find the id Discord assigned to a board post Proton sent.
   *
   * A framework gap rather than a design choice, and the one thing about this
   * module that is uglier than it should be. `ActionResult` reports a status and
   * a case id and nothing else — the executor discards Discord's response body —
   * so a module cannot learn the id of a message it just sent, and
   * `packages/core` is not this module's to widen. Until it is, the id is
   * recovered by looking: read the board channel's recent messages and take the
   * one whose embed `url` is the source message's jump link. `boardPostMatches`
   * in this package is that test, so the rule for recognising a board post stays
   * next to the code that builds one.
   *
   * `GET /channels/{c}/messages?limit=n`, same permissions as above. Null when
   * no such post is there; the listener leaves the row unwritten and repairs it
   * on the next reaction rather than recording an id it guessed.
   */
  resolveBoardPost?(query: BoardPostQuery): Promise<string | null>;
}

export interface BoundStarboardDeps {
  store: StarboardStore;
  readMessage(request: SourceMessageRequest): Promise<SourceMessage | null>;
  resolveBoardPost(query: BoardPostQuery): Promise<string | null>;
}

export type BindResult = { deps: BoundStarboardDeps } | { unbound: string[] };

const PORT_HINTS: Record<string, string> = {
  store: 'store: new DrizzleStarboardStore(dbHandle)',
  readMessage: 'readMessage: GET /channels/{channelId}/messages/{messageId} via the REST proxy',
  resolveBoardPost:
    'resolveBoardPost: GET /channels/{boardChannelId}/messages?limit=50, matched with ' +
    'boardPostMatches(message, query.jumpUrl)',
};

export function bindDeps(deps: StarboardDeps): BindResult {
  const { store, readMessage, resolveBoardPost } = deps;

  const unbound: string[] = [];
  if (!store) unbound.push('store');
  if (!readMessage) unbound.push('readMessage');
  if (!resolveBoardPost) unbound.push('resolveBoardPost');

  if (!store || !readMessage || !resolveBoardPost) return { unbound };
  return { deps: { store, readMessage, resolveBoardPost } };
}

/**
 * What to say when a guild has the starboard on, someone starred a message, and
 * nothing was bound.
 *
 * Names the ports and the exact construction. Members can see each other
 * reacting, so "nothing appeared on the board" is a failure a whole server
 * notices at once and nobody can diagnose — the outcome §1 and §7 exist to
 * eliminate.
 */
export function describeUnbound(unbound: readonly string[]): string {
  return (
    'The starboard is enabled in this server but is NOT running: the module was built ' +
    `without ${unbound.join(', ')}. Stars are being counted by nobody and no board post will ` +
    'ever appear. The process running modules must call createStarboardModule({ ' +
    `${unbound.map((port) => PORT_HINTS[port] ?? port).join(', ')} }).`
  );
}
