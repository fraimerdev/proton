// By message too: a ForbiddenError from a server function reaches the browser as a plain Error.
const ACCESS_DENIED =
  /forbidden|not signed in|no longer accepts your sign-in|do not administer|lack the required permission/i;

export function isAccessError(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === 'ForbiddenError' || ACCESS_DENIED.test(error.message))
  );
}

const SIGNED_OUT = /not signed in|no longer accepts your sign-in/i;
const NOT_MEMBER = /not a member of that server/i;
const REVOKED = /forbidden|do not administer|lack the required permission/i;
const DISCORD_REFUSED = /discord (?:refused|answered)/i;
const UNREACHABLE =
  /api returned|api did not answer|fetch failed|failed to fetch|load failed|networkerror|econnrefused|timed out/i;

export type FailureKind =
  | 'signed-out'
  | 'not-member'
  | 'revoked'
  | 'discord-refused'
  | 'unreachable'
  | 'unknown';

export function failureKind(error: unknown): FailureKind {
  if (!(error instanceof Error)) return 'unknown';
  if (SIGNED_OUT.test(error.message)) return 'signed-out';
  if (NOT_MEMBER.test(error.message)) return 'not-member';
  if (error.name === 'ForbiddenError' || REVOKED.test(error.message)) return 'revoked';
  if (DISCORD_REFUSED.test(error.message)) return 'discord-refused';
  if (UNREACHABLE.test(error.message)) return 'unreachable';

  return 'unknown';
}

// The api answers a refused write by naming each field it refused, and form.ts marks them; that
// shape is checked before failureKind, which would read a field's own wording as the reason.
const REFUSED_SETTINGS = /settings were not saved:\s*\S/;

export function saveFailure(error: Error, attempt: string): string {
  if (REFUSED_SETTINGS.test(error.message)) {
    return `${attempt}. Fix the marked settings, then save again.`;
  }

  switch (failureKind(error)) {
    case 'signed-out':
      return (
        `${attempt}. Your Discord sign-in expired. Sign in again in another tab, then try again. ` +
        `Nothing you entered was lost.`
      );

    case 'not-member':
      return `${attempt}. You’re no longer a member of this server.`;

    case 'revoked':
      return `${attempt}. You no longer have Manage Server in this server.`;

    case 'discord-refused':
      return (
        `${attempt}. Discord refused the request. Check Proton’s role in Server Settings → ` +
        `Roles → Proton, then try again.`
      );

    case 'unreachable':
      return `${attempt}. Proton didn’t respond. Try again in a moment.`;

    default:
      return `${attempt}. Something went wrong. Try again in a moment.`;
  }
}

// lib/discord.ts writes these as whole sentences, and a generic one would replace the reason.
const AUTHORED = /^Proton [a-z]/;

export function readFailure(error: unknown, what: string): string {
  if (error instanceof Error && AUTHORED.test(error.message)) return error.message;

  switch (failureKind(error)) {
    case 'signed-out':
      return (
        `Couldn’t load ${what}. Your Discord sign-in expired. Sign in again in another tab, then ` +
        `try again.`
      );

    case 'not-member':
      return `Couldn’t load ${what}. You’re no longer a member of this server.`;

    case 'revoked':
      return `Couldn’t load ${what}. You no longer have Manage Server in this server.`;

    case 'discord-refused':
      return (
        `Couldn’t load ${what}. Discord refused the request. Check Proton’s role in Server ` +
        `Settings → Roles → Proton, then try again.`
      );

    case 'unreachable':
      return `Couldn’t load ${what}. Proton didn’t respond. Try again in a moment.`;

    default:
      return `Couldn’t load ${what}. Something went wrong. Try again in a moment.`;
  }
}

export const COMMAND_CHANGED =
  'This command changed while you were editing. Your edits are kept. Check them, then save again.';

export function isCommandChanged(error: unknown): boolean {
  return error instanceof Error && error.message === COMMAND_CHANGED;
}

// A Discord 4xx is not a blip, asking again gets the same answer; a 429 is the one that clears.
const REFUSED = /discord (?:refused with|answered) 4(?!29)\d\d/i;

export function isPermanentFailure(error: unknown): boolean {
  return isAccessError(error) || (error instanceof Error && REFUSED.test(error.message));
}
