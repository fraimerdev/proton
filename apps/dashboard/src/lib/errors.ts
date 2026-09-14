// By message too: a ForbiddenError from a server function reaches the browser as a plain Error.
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

export function failureKind(error: unknown): FailureKind {
  if (!(error instanceof Error)) return 'unknown';
  if (SIGNED_OUT.test(error.message)) return 'signed-out';
  if (error.name === 'ForbiddenError' || REVOKED.test(error.message)) return 'revoked';
  if (DISCORD_REFUSED.test(error.message)) return 'discord-refused';
  if (UNREACHABLE.test(error.message)) return 'unreachable';

  return 'unknown';
}

export function saveFailure(error: Error, attempt: string): string {
  switch (failureKind(error)) {
    case 'signed-out':
      return (
        `${attempt} — your Discord sign-in has expired. Sign in again in another tab, then try ` +
        `again. Nothing you entered was lost.`
      );

    case 'revoked':
      return (
        `${attempt} — your access to this server was revoked, or you no longer have Manage Server ` +
        `in it. Nothing you entered was lost, but Proton cannot save it until access is back.`
      );

    case 'discord-refused':
      return (
        `${attempt} — Discord refused the request. Check Proton’s role in Server Settings → ` +
        `Roles → Proton, then try again.`
      );

    case 'unreachable':
      return (
        `${attempt} — Proton’s service did not respond. Nothing you entered was lost. Try again ` +
        `in a moment.`
      );

    default:
      return `${attempt}, and Proton did not say why. Try again in a moment.`;
  }
}

// fetchGuildRoles and fetchGuildChannels already write a sentence naming the missing permission.
const AUTHORED = /^Proton [a-z]/;

export function readFailure(error: unknown, what: string): string {
  if (error instanceof Error && AUTHORED.test(error.message)) return error.message;

  switch (failureKind(error)) {
    case 'signed-out':
      return `Proton could not read ${what}: your Discord sign-in has expired. Sign in again in another tab, then try again.`;

    case 'revoked':
      return (
        `Proton could not read ${what}: your access to this server was revoked, or you no longer ` +
        `have Manage Server in it.`
      );

    case 'discord-refused':
      return (
        `Proton could not read ${what}: Discord refused the request. Check Proton’s role in ` +
        `Server Settings → Roles → Proton, then try again.`
      );

    case 'unreachable':
      return `Proton could not read ${what}: Proton’s service did not respond. Try again in a moment.`;

    default:
      return `Proton could not read ${what}, and did not say why. Try again in a moment.`;
  }
}

// A Discord refusal is not a blip: asking again a second later gets the same 403.
const REFUSED = /discord refused with 4\d\d/i;

export function isPermanentFailure(error: unknown): boolean {
  return isAccessError(error) || (error instanceof Error && REFUSED.test(error.message));
}
