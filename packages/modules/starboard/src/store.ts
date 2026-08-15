/**
 * One board post, as `starboard_posts` holds it.
 *
 * The primary key is `(guild_id, source_message_id)`: the question the module
 * asks on every reaction is "have I already posted *this message*", and a
 * message id is only unique per channel by Discord's own guarantee, so the guild
 * scopes it. `board_message_id` is not the key — it is the answer.
 */
export interface StarboardPost {
  guildId: string;
  sourceMessageId: string;
  boardMessageId: string;
  /** The count the board post currently displays, so an unchanged count costs no edit. */
  starCount: number;
  createdAt: Date;
}

/**
 * Where board posts are remembered.
 *
 * A port declared by the module rather than by `packages/core`, because §7 gives
 * a module its own tables but `ModuleContext` has no way to hand it a database.
 * Until that gap is closed the store is constructed by whoever wires the module
 * up (see `createStarboardModule`), which keeps the dependency explicit and the
 * state machine testable without Postgres.
 */
export interface StarboardStore {
  get(guildId: string, sourceMessageId: string): Promise<StarboardPost | null>;

  /**
   * Remember a board post, ignoring one that is already remembered.
   *
   * Returns whether a row was actually written. Two reactions landing together
   * can both reach the create branch — the executor's idempotency key means only
   * one of them posts, but both then try to record it — so this insert has to be
   * a no-op for the loser rather than a unique-violation.
   */
  record(post: StarboardPost): Promise<boolean>;

  /** Update the displayed count after an edit. */
  setCount(guildId: string, sourceMessageId: string, starCount: number): Promise<void>;

  /** Forget a board post after deleting it. Idempotent. */
  remove(guildId: string, sourceMessageId: string): Promise<void>;
}
