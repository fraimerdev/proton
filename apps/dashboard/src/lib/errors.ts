// Matched by name and by message: a ForbiddenError thrown inside a server function reaches the
// browser as a plain deserialised Error, so only its message survives the RPC boundary.
const ACCESS_DENIED = /forbidden|not signed in|do not administer|lack the required permission/i;

export function isAccessError(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === 'ForbiddenError' || ACCESS_DENIED.test(error.message))
  );
}

// Both mutation surfaces print `${attempt}: ${message}`, which turns a revoked session into
// "Could not save: not signed in" — a fragment with nothing to do about it.
export function saveFailure(error: Error, attempt: string): string {
  return isAccessError(error)
    ? `${attempt} — your Discord sign-in has expired, or your access to this server was revoked. ` +
        `Sign in again in another tab and try once more. Nothing you typed has been lost.`
    : `${attempt}: ${error.message}`;
}

// Discord refusing a read is not a blip: fetchGuildChannels and fetchGuildRoles say which
// permission is missing, and asking again a second later gets the same 403.
const REFUSED = /discord refused with 4\d\d/i;

export function isPermanentFailure(error: unknown): boolean {
  return isAccessError(error) || (error instanceof Error && REFUSED.test(error.message));
}
