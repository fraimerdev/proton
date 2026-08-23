export interface MessagesDeps {
  applicationId?: string;
}

export interface BoundFollowUpDeps {
  applicationId: string;
}

export type BindResult<T> = { deps: T } | { unbound: string[] };

const PORT_HINTS: Record<string, string> = {
  applicationId: "applicationId: the application's own id, from READY",
};

export function bindFollowUp(deps: MessagesDeps): BindResult<BoundFollowUpDeps> {
  return deps.applicationId
    ? { deps: { applicationId: deps.applicationId } }
    : { unbound: ['applicationId'] };
}

export function describeUnbound(what: string, unbound: readonly string[]): string {
  return (
    `${what} — the embeds module was built without ${unbound.join(', ')}. The process running ` +
    `modules must call createMessagesModule({ ${unbound
      .map((port) => PORT_HINTS[port] ?? port)
      .join(', ')} }).`
  );
}
