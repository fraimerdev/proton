/**
 * What `ModuleContext` cannot supply (§7).
 *
 * A module is handed a guild id, its config, an executor and a logger and
 * nothing else — in particular, no answer to "who am I". Both ports below are
 * that same question asked for two different reasons, and each is declared
 * separately so a half-wired deployment names the piece it is missing rather
 * than disabling both paths over one. Optional, so the manifest still registers,
 * renders in the dashboard and typechecks with nothing bound, exactly as
 * `createPhishingModule({ botUserId })` and `createAntinukeModule` do.
 */
export interface RolemenuDeps {
  /**
   * The application's own id, for `interaction_followup`.
   *
   * A follow-up goes to `/webhooks/{applicationId}/{token}`, and the application
   * id is not derivable from anything a module holds. Discord does put
   * `application_id` on the interaction dispatch, and reading it from there would
   * work — it is declared as a port instead so that one answer serves every path
   * that needs it and so an unwired deployment says so by name at the moment a
   * member presses a button, rather than producing a 404 nobody can read.
   */
  applicationId?: string;

  /**
   * Proton's own user id.
   *
   * Load-bearing for reaction menus specifically. `/rolemenu` seeds a reaction
   * menu by reacting to the message itself, and those reactions come back as
   * MESSAGE_REACTION_ADD like anybody else's. Without a way to recognise its own
   * reaction, Proton would treat seeding a menu as a member choosing every option
   * on it and try to grant itself the lot.
   */
  botUserId?: string;
}

export interface BoundComponentDeps {
  applicationId: string;
}

export interface BoundReactionDeps {
  botUserId: string;
}

export type BindResult<T> = { deps: T } | { unbound: string[] };

const PORT_HINTS: Record<string, string> = {
  applicationId: "applicationId: the application's own id, from READY",
  botUserId: "botUserId: the application's own user id, from READY",
};

/** What a button or dropdown press needs: somewhere to send the follow-up. */
export function bindComponentDeps(deps: RolemenuDeps): BindResult<BoundComponentDeps> {
  return deps.applicationId
    ? { deps: { applicationId: deps.applicationId } }
    : { unbound: ['applicationId'] };
}

/** What a reaction needs: the ability to tell Proton's own reactions from a member's. */
export function bindReactionDeps(deps: RolemenuDeps): BindResult<BoundReactionDeps> {
  return deps.botUserId ? { deps: { botUserId: deps.botUserId } } : { unbound: ['botUserId'] };
}

/**
 * What to say when the module was asked to do something it was never given the
 * means to do.
 *
 * Names the ports and the exact construction. "The role menu did nothing" has to
 * be a sentence somebody can act on, not a silence (§1, §7).
 */
export function describeUnbound(what: string, unbound: readonly string[]): string {
  return (
    `${what} — the rolemenu module was built without ${unbound.join(', ')}. ` +
    'The process running modules must call createRolemenuModule({ ' +
    `${unbound.map((port) => PORT_HINTS[port] ?? port).join(', ')} }).`
  );
}
