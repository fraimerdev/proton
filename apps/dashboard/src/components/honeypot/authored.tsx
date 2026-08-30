import type { EntitlementTier, ProtonMessage } from '@proton/core';
import type { ReactElement } from 'react';
import type { DiscordChannel, DiscordRole } from '../form/fields.tsx';
import { MessageBuilder } from '../message/builder.tsx';
import { messageFrom } from '../message/normalise.ts';
import { MessagePreview } from '../message/preview.tsx';
import { Icon } from '../shell/icon.tsx';

export interface AuthoredLayoutProps {
  message: unknown;
  onChange: (message: ProtonMessage) => void;

  channels: readonly DiscordChannel[];
  roles: readonly DiscordRole[];

  tier: EntitlementTier;

  description: string;
  placeholders: readonly string[];
  adds: string;
}

export function AuthoredLayout({
  message,
  onChange,
  channels,
  roles,
  tier,
  description,
  placeholders,
  adds,
}: AuthoredLayoutProps): ReactElement {
  const value = messageFrom(message);

  // Stored, not substituted. What a free server actually posts is the built-in layout, but the
  // editor binds to what this server has saved — rendering the default here would make the next
  // Save on any unrelated toggle overwrite work an admin did while they were paying.
  const locked = tier === 'free';

  return (
    <div className="saved-messages panel-wide">
      <p className="field-description">{description}</p>

      {locked ? (
        <p className="gap-card gap-card-warn" role="note">
          <Icon name="lightning-slash" />
          <span>
            This server posts Proton’s built-in message. What you write here is saved and kept, and
            it starts being posted the moment this server moves to a paid plan.
          </span>
        </p>
      ) : null}

      <p className="field-description">
        <code>{placeholders.join(' ')}</code> are substituted everywhere in the message. {adds}
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
