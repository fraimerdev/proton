import type { ProtonMessage } from '@proton/core';
import { liftLegacyGreeting, WELCOME_PLACEHOLDERS } from '@proton/module-welcome/config';
import type { ReactElement } from 'react';
import type { DiscordChannel, DiscordRole } from '../form/fields.tsx';
import { MessageBuilder } from '../message/builder.tsx';
import { messageFrom } from '../message/normalise.ts';
import { MessagePreview } from '../message/preview.tsx';

export interface GreetingEditorProps {
  message: unknown;
  onChange: (message: ProtonMessage) => void;
  channels: readonly DiscordChannel[];
  roles: readonly DiscordRole[];
  description: string;
}

export function GreetingEditor({
  message,
  onChange,
  channels,
  roles,
  description,
}: GreetingEditorProps): ReactElement {
  const value = messageFrom(liftLegacyGreeting(message));

  return (
    <div className="saved-messages panel-wide">
      <p className="field-description">
        {description} Leave it completely empty to say nothing at all — the card, if one is
        attached, is still posted.
      </p>

      <p className="field-description">
        <code>{WELCOME_PLACEHOLDERS.join(' ')}</code> are substituted everywhere in the message: the
        text, every embed title, description and field, and every button label.
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
