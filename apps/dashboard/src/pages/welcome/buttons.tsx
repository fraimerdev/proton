import type { ActionRow, MessageButton } from '@proton/core';
import { BUTTON_LABEL_MAX, BUTTON_URL_MAX, BUTTONS_PER_ROW_MAX } from '@proton/core';
import type { ReactElement } from 'react';
import { EmojiPicker } from '../../components/discord/emoji-picker.tsx';
import { PresenceList, useRecent } from '../../components/ui/collection.tsx';
import { Button, cx, IconButton, TextInput } from '../../components/ui/controls.tsx';

export type ButtonRow = Extract<ActionRow, { kind: 'buttons' }>;

export function takenKeys(rows: readonly ActionRow[]): Set<string> {
  const keys = new Set<string>();

  for (const row of rows) {
    if (row.kind === 'buttons') for (const button of row.buttons) keys.add(button.key);
    else keys.add(row.select.key);
  }

  return keys;
}

export function newLinkButton(taken: ReadonlySet<string>): MessageButton {
  let index = 1;
  while (taken.has(`link${index}`)) index += 1;

  return { key: `link${index}`, style: 'link', label: 'Open', url: '' };
}

export function LinkButtonRowEditor({
  guildId,
  row,
  taken,
  onChange,
  onRemove,
  errorAt,
  prefix,
  className,
}: {
  guildId: string;
  row: ButtonRow;
  taken: ReadonlySet<string>;
  onChange: (next: ButtonRow) => void;
  onRemove: () => void;
  errorAt: (path: string) => string | undefined;
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
          const urlError = errorAt(`${prefix}.${index}.url`);
          const labelError = errorAt(`${prefix}.${index}.label`);
          const styleError = errorAt(`${prefix}.${index}.style`);

          return (
            <div className={cx('stack stack-8', recent.enter(button.key, 'part'))} key={button.key}>
              <div className="inline inline-8 inline-wrap">
                <EmojiPicker
                  guildId={guildId}
                  label={`Button ${index + 1} emoji`}
                  value={button.emoji ?? null}
                  onChange={(emoji) => set(index, { ...button, emoji: emoji ?? undefined })}
                />
                <TextInput
                  aria-label={`Button ${index + 1} label`}
                  className="control-w-md"
                  placeholder="Label"
                  maxLength={BUTTON_LABEL_MAX}
                  invalid={labelError !== undefined}
                  value={button.label ?? ''}
                  onChange={(event) =>
                    set(index, { ...button, label: event.currentTarget.value || undefined })
                  }
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

              <TextInput
                aria-label={`Button ${index + 1} link`}
                placeholder="https://…"
                maxLength={BUTTON_URL_MAX}
                invalid={urlError !== undefined}
                value={button.url ?? ''}
                onChange={(event) =>
                  set(index, { ...button, url: event.currentTarget.value || undefined })
                }
              />

              {labelError !== undefined ? <p className="row-error">{labelError}</p> : null}
              {urlError !== undefined ? <p className="row-error">{urlError}</p> : null}

              {button.style === 'link' ? null : (
                <>
                  {styleError !== undefined ? <p className="row-error">{styleError}</p> : null}
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
