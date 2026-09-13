import type { ReactElement } from 'react';
import { useMemo } from 'react';
import { EMOJI_GROUPS } from './emoji-set.gen.ts';

export default function UnicodeTable({
  query,
  onPick,
}: {
  query: string;
  onPick: (char: string, name: string) => void;
}): ReactElement {
  const groups = useMemo(() => {
    if (query === '') return EMOJI_GROUPS;

    return EMOJI_GROUPS.map((group) => ({
      ...group,
      emojis: group.emojis.filter((emoji) => emoji.name.toLowerCase().includes(query)),
    })).filter((group) => group.emojis.length > 0);
  }, [query]);

  if (groups.length === 0) return <p className="picker-note">No matching emoji</p>;

  return (
    <>
      {groups.map((group) => (
        <div key={group.id}>
          <p className="picker-category">{group.label}</p>
          <div className="emoji-grid">
            {group.emojis.map((emoji) => (
              <button
                key={emoji.char}
                type="button"
                className="emoji-cell"
                title={emoji.name}
                onClick={() => onPick(emoji.char, emoji.name)}
              >
                {emoji.char}
              </button>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
