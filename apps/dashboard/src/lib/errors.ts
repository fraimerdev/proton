// Matched by name and by message: a ForbiddenError thrown inside a server function reaches the
// browser as a plain deserialised Error, so only its message survives the RPC boundary.
const ACCESS_DENIED = /forbidden|not signed in|do not administer|lack the required permission/i;

export function isAccessError(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === 'ForbiddenError' || ACCESS_DENIED.test(error.message))
  );
}

const SIGNED_OUT = /not signed in/i;
const REVOKED = /forbidden|do not administer|lack the required permission/i;
const DISCORD_REFUSED = /discord (?:refused|answered)/i;
const UNREACHABLE =
  /api returned|fetch failed|failed to fetch|load failed|networkerror|econnrefused|timed out/i;

export type FailureKind = 'signed-out' | 'revoked' | 'discord-refused' | 'unreachable' | 'unknown';

/**
 * Four things actually go wrong across these surfaces, and an admin can do something different
 * about each. Every one of them used to reach the page as `${attempt}: ${error.message}`, which
 * turns a revoked session into "Could not save: not signed in" — a fragment with no recovery in it.
 */
export function failureKind(error: unknown): FailureKind {
  if (!(error instanceof Error)) return 'unknown';
  if (SIGNED_OUT.test(error.message)) return 'signed-out';
  if (error.name === 'ForbiddenError' || REVOKED.test(error.message)) return 'revoked';
  if (DISCORD_REFUSED.test(error.message)) return 'discord-refused';
  if (UNREACHABLE.test(error.message)) return 'unreachable';

  return 'unknown';
}

// The raw text, for a title attribute and nowhere else: an admin quoting the failure into a bug
// report still needs "Discord refused with 403", and an admin reading the page does not.
export function failureDetail(error: unknown): string | undefined {
  return error instanceof Error && error.message !== '' ? error.message : undefined;
}

export function saveFailure(error: Error, attempt: string): string {
  switch (failureKind(error)) {
    case 'signed-out':
      return (
        `${attempt} — your Discord sign-in has expired. Sign in again in another tab and try once ` +
        `more. Nothing you typed has been lost.`
      );

    case 'revoked':
      return (
        `${attempt} — your access to this server was revoked, or you no longer hold Manage Server ` +
        `in it. Nothing you typed has been lost, but Proton cannot write it until that is back.`
      );

    case 'discord-refused':
      return (
        `${attempt} — Discord refused the request. Check Proton’s own role in Server Settings → ` +
        `Roles → Proton, then try again.`
      );

    case 'unreachable':
      return (
        `${attempt} — Proton’s own service did not answer. Nothing you typed has been lost; try ` +
        `again in a moment.`
      );

    default:
      return `${attempt}, and Proton did not say why. Try again in a moment.`;
  }
}

// fetchGuildRoles and fetchGuildChannels already answer a refusal with a written sentence naming
// the missing permission and where to grant it, so replacing those would lose the best copy in the
// product. Only the bare engine fragments are rewritten.
const AUTHORED = /^Proton [a-z]/;

/**
 * A refused read, for the surfaces that show rows rather than a form. The same four failures,
 * without "nothing you typed has been lost" — which is true of a save and meaningless about a list.
 */
export function readFailure(error: unknown, what: string): string {
  if (error instanceof Error && AUTHORED.test(error.message)) return error.message;

  switch (failureKind(error)) {
    case 'signed-out':
      return `Proton could not read ${what}: your Discord sign-in has expired. Sign in again in another tab.`;

    case 'revoked':
      return (
        `Proton could not read ${what}: your access to this server was revoked, or you no longer ` +
        `hold Manage Server in it.`
      );

    case 'discord-refused':
      return (
        `Proton could not read ${what}: Discord refused the request. Check Proton’s own role in ` +
        `Server Settings → Roles → Proton.`
      );

    case 'unreachable':
      return `Proton could not read ${what}: Proton’s own service did not answer. Try again in a moment.`;

    default:
      return `Proton could not read ${what}, and did not say why. Try again in a moment.`;
  }
}

// Discord refusing a read is not a blip: fetchGuildChannels and fetchGuildRoles say which
// permission is missing, and asking again a second later gets the same 403.
const REFUSED = /discord refused with 4\d\d/i;

export function isPermanentFailure(error: unknown): boolean {
  return isAccessError(error) || (error instanceof Error && REFUSED.test(error.message));
}
