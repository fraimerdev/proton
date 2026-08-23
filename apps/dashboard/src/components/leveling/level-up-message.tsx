import type { ProtonMessage } from '@proton/core';
import { LEVEL_UP_PLACEHOLDERS, liftLevelUpMessage } from '@proton/module-leveling/config';
import type { ReactElement } from 'react';
import type { DiscordChannel, DiscordRole } from '../form/fields.tsx';
import { MessageBuilder } from '../message/builder.tsx';
import { messageFrom } from '../message/normalise.ts';
import { MessagePreview } from '../message/preview.tsx';

export interface LevelUpMessageEditorProps {
  message: unknown;
  onChange: (message: ProtonMessage) => void;
  channels: readonly DiscordChannel[];
  roles: readonly DiscordRole[];
}

export function LevelUpMessageEditor({
  message,
  onChange,
  channels,
  roles,
}: LevelUpMessageEditorProps): ReactElement {
  const value = messageFrom(liftLevelUpMessage(message));

  return (
    <div className="saved-messages panel-wide">
      <p className="field-description">
        Posted when a member levels up, in the level-up channel above or — with none set — in the
        channel they were talking in. Leave it completely empty to level members up silently.
      </p>

      <p className="field-description">
        <code>{LEVEL_UP_PLACEHOLDERS.join(' ')}</code> are substituted everywhere in the message:
        the text, every embed title, description and field, and every button label.
      </p>

      <div className="saved-body">
        <div className="saved-edit">
          <MessageBuilder channels={channels} message={value} onChange={onChange} roles={roles} />
        </div>

        <div className="saved-preview">
          <MessagePreview channels={channels} message={value} roles={roles} />
        </div>
      </div>
    </div>
  );
}
