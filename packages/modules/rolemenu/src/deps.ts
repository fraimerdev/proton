export interface RolemenuDeps {
  applicationId?: string;

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

export function bindComponentDeps(deps: RolemenuDeps): BindResult<BoundComponentDeps> {
  return deps.applicationId
    ? { deps: { applicationId: deps.applicationId } }
    : { unbound: ['applicationId'] };
}

export function bindReactionDeps(deps: RolemenuDeps): BindResult<BoundReactionDeps> {
  return deps.botUserId ? { deps: { botUserId: deps.botUserId } } : { unbound: ['botUserId'] };
}

export function describeUnbound(what: string, unbound: readonly string[]): string {
  return (
    `${what} — the rolemenu module was built without ${unbound.join(', ')}. ` +
    'The process running modules must call createRolemenuModule({ ' +
    `${unbound.map((port) => PORT_HINTS[port] ?? port).join(', ')} }).`
  );
}
