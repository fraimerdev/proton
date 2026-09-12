import { type ReactElement, useState } from 'react';
import { Icon } from './icon.tsx';

export interface ChipMember {
  id: string;
  displayName: string;
  username: string;
  avatarUrl: string | null;
  bot?: boolean | undefined;
}

export type MemberIndex = ReadonlyMap<string, ChipMember>;

export function memberIndex(members: readonly ChipMember[]): MemberIndex {
  return new Map(members.map((member) => [member.id, member]));
}

function initials(name: string): string {
  const words = name.split(/\s+/).filter((word) => word.length > 0);
  const letters = words.slice(0, 2).map((word) => word[0] ?? '');

  return (letters.join('') || '?').toUpperCase();
}

export interface UserChipProps {
  id: string;

  // Absent or null means the lookup could not resolve this id — a member who has left the server is
  // the ordinary case. The id is then the whole answer, and no name is invented for it.
  member?: ChipMember | null | undefined;

  // What this person is on this row — 'moderator', 'target'. Names the copy button, which would
  // otherwise be one of three identical "Copy id" buttons on every row of the case log.
  as?: string | undefined;
}

/**
 * A member, rather than the eighteen digits of their snowflake. The case log, the leaderboard and
 * the blocked list all printed the raw id and then apologised for it in a lede — "Targets and
 * moderators are listed by ID, not by name" — which is the interface knowing it was wrong.
 */
export function UserChip({ id, member, as }: UserChipProps): ReactElement {
  const [copied, setCopied] = useState(false);

  const what = as === undefined ? 'user id' : `${as} id`;

  function copy(): void {
    // A clipboard the browser refuses is not an error worth a panel: the id is on the title and
    // selectable in the row, so saying "Copied" when nothing was is the only real failure.
    void navigator.clipboard?.writeText(id).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  }

  return (
    <span className="user-chip" data-unknown={member ? undefined : 'true'} title={id}>
      {member ? (
        <>
          <span className="user-chip-avatar" aria-hidden="true">
            {member.avatarUrl ? (
              <img src={member.avatarUrl} alt="" decoding="async" loading="lazy" />
            ) : (
              initials(member.displayName)
            )}
          </span>
          <span className="user-chip-name">{member.displayName}</span>
          {member.bot ? <span className="user-chip-bot">Bot</span> : null}
          <span className="user-chip-handle">@{member.username}</span>
        </>
      ) : (
        <span className="user-chip-id">{id}</span>
      )}

      <button
        type="button"
        className="user-chip-copy"
        aria-label={copied ? `Copied the ${what}` : `Copy the ${what} ${id}`}
        onBlur={() => setCopied(false)}
        onClick={copy}
      >
        <Icon name={copied ? 'check-circle' : 'copy'} />
      </button>
    </span>
  );
}
