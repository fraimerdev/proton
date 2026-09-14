import type { ActionRow, MessageButton } from '@proton/core';
import { BUTTON_LABEL_MAX, BUTTON_URL_MAX, BUTTONS_PER_ROW_MAX } from '@proton/core';
import type { ReactElement } from 'react';
import {
  blank,
  type ConfigErrors,
  MessageField,
  type PlaceholderSlot,
  sentence,
} from '../../components/discord/embed-editor.tsx';
import { EmojiPicker } from '../../components/discord/emoji-picker.tsx';
import { newLinkButton } from '../../components/discord/layout-builder.tsx';
import { PresenceList, useRecent } from '../../components/ui/collection.tsx';
import { Button, cx, IconButton } from '../../components/ui/controls.tsx';

type ButtonRow = Extract<ActionRow, { kind: 'buttons' }>;

export function takenKeys(rows: readonly ActionRow[]): Set<string> {
  const keys = new Set<string>();

  for (const row of rows) {
    if (row.kind === 'buttons') for (const button of row.buttons) keys.add(button.key);
    else keys.add(row.select.key);
  }

  return keys;
}

export function LinkButtonRowEditor({
  guildId,
  row,
  taken,
  onChange,
  onRemove,
  errors,
  placeholders,
  prefix,
  className,
}: {
  guildId: string;
  row: ButtonRow;
  taken: ReadonlySet<string>;
  onChange: (next: ButtonRow) => void;
  onRemove: () => void;
  errors: ConfigErrors;
  placeholders: PlaceholderSlot | undefined;
  prefix: string;
  className?: string | undefined;
}): ReactElement {
  const recent = useRecent();

  const set = (index: number, next: MessageButton): void =>
    onChange({
      kind: 'buttons',
      buttons: row.buttons.map((button, at) => (at === index ? next : button)),
    });

  const drop = (index: number): void =>
    onChange({ kind: 'buttons', buttons: row.buttons.filter((_, at) => at !== index) });

  return (
    <div className={cx('panel-sunken stack stack-12', className)}>
      <PresenceList>
        {row.buttons.map((button, index) => {
          const at = `${prefix}.${index}`;
          const styleError = errors.at(`${at}.style`) ?? errors.at(`${at}.action`);

          return (
            <div className={cx('stack stack-8', recent.enter(button.key, 'part'))} key={button.key}>
              <div className="inline inline-8 inline-wrap message-field-row">
                <EmojiPicker
                  guildId={guildId}
                  label={`Button ${index + 1} emoji`}
                  value={button.emoji ?? null}
                  onChange={(emoji) => set(index, { ...button, emoji: emoji ?? undefined })}
                />
                <MessageField
                  placeholders={placeholders}
                  path={`${at}.label`}
                  label={`Button ${index + 1} label`}
                  placeholder="Label"
                  width="md"
                  maxLength={BUTTON_LABEL_MAX}
                  value={button.label ?? ''}
                  error={errors.at(`${at}.label`)}
                  onChange={(next) => set(index, { ...button, label: blank(next) })}
                />
                <span className="push-right">
                  <IconButton
                    icon="trash"
                    tone="ghost"
                    size="sm"
                    label={`Remove button ${index + 1}`}
                    onClick={() => drop(index)}
                  />
                </span>
              </div>

              <MessageField
                placeholders={placeholders}
                path={`${at}.url`}
                label={`Button ${index + 1} link`}
                link
                placeholder="https://…"
                maxLength={BUTTON_URL_MAX}
                value={button.url ?? ''}
                error={errors.at(`${at}.url`)}
                onChange={(next) => set(index, { ...button, url: blank(next) })}
              />

              {button.style === 'link' ? null : (
                <>
                  {styleError !== undefined ? (
                    <p className="row-error">{sentence(styleError)}</p>
                  ) : null}
                  <Button
                    size="sm"
                    className="ladder-add"
                    onClick={() => set(index, { ...button, style: 'link', action: undefined })}
                  >
                    Change to link button
                  </Button>
                </>
              )}
            </div>
          );
        })}
      </PresenceList>

      <div className="inline inline-8">
        <Button
          size="sm"
          icon="plus"
          disabled={row.buttons.length >= BUTTONS_PER_ROW_MAX}
          onClick={() => {
            const button = newLinkButton(taken);
            recent.mark(button.key);
            onChange({ kind: 'buttons', buttons: [...row.buttons, button] });
          }}
        >
          Add button
        </Button>
        <span className="text-xs text-muted">
          {row.buttons.length} / {BUTTONS_PER_ROW_MAX}
        </span>
        <span className="push-right">
          <Button tone="ghost" size="sm" icon="trash" onClick={onRemove}>
            Remove row
          </Button>
        </span>
      </div>
    </div>
  );
}
