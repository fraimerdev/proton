import type { ActionRow, MessageButton } from '@proton/core';
import {
  ACTION_ROWS_MAX,
  BUTTON_LABEL_MAX,
  BUTTON_URL_MAX,
  BUTTONS_PER_ROW_MAX,
} from '@proton/core';
import type { ReactElement } from 'react';
import { EmojiPicker } from '../../components/discord/emoji-picker.tsx';
import { Button, IconButton, TextInput } from '../../components/ui/controls.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';

const BUTTONS_INTRO =
  'Only link buttons work here. Proton does not respond to presses on level-up messages, so any ' +
  'other button would do nothing.';

function takenKeys(rows: readonly ActionRow[]): Set<string> {
  const keys = new Set<string>();

  for (const row of rows) {
    if (row.kind === 'buttons') for (const button of row.buttons) keys.add(button.key);
    else keys.add(row.select.key);
  }

  return keys;
}

function newLinkButton(taken: ReadonlySet<string>): MessageButton {
  let index = 1;
  while (taken.has(`link${index}`)) index += 1;

  return { key: `link${index}`, style: 'link', label: 'Open', url: '' };
}

function LinkButton({
  guildId,
  button,
  position,
  labelError,
  urlError,
  styleError,
  onChange,
  onRemove,
}: {
  guildId: string;
  button: MessageButton;
  position: number;
  labelError: string | undefined;
  urlError: string | undefined;
  styleError: string | undefined;
  onChange: (next: MessageButton) => void;
  onRemove: () => void;
}): ReactElement {
  return (
    <div className="stack stack-8">
      <div className="inline inline-8 inline-wrap">
        <EmojiPicker
          guildId={guildId}
          label={`Button ${position} emoji`}
          value={button.emoji ?? null}
          onChange={(emoji) => onChange({ ...button, emoji: emoji ?? undefined })}
        />
        <TextInput
          aria-label={`Button ${position} label`}
          className="control-w-md"
          placeholder="Label"
          maxLength={BUTTON_LABEL_MAX}
          invalid={labelError !== undefined}
          value={button.label ?? ''}
          onChange={(event) =>
            onChange({ ...button, label: event.currentTarget.value || undefined })
          }
        />
        <span className="push-right">
          <IconButton
            icon="trash"
            tone="ghost"
            size="sm"
            label={`Remove button ${position}`}
            onClick={onRemove}
          />
        </span>
      </div>

      <TextInput
        aria-label={`Button ${position} link`}
        placeholder="https://…"
        maxLength={BUTTON_URL_MAX}
        invalid={urlError !== undefined}
        value={button.url ?? ''}
        onChange={(event) => onChange({ ...button, url: event.currentTarget.value || undefined })}
      />

      {labelError !== undefined ? <p className="row-error">{labelError}</p> : null}
      {urlError !== undefined ? <p className="row-error">{urlError}</p> : null}

      {button.style === 'link' ? null : (
        <>
          {styleError !== undefined ? <p className="row-error">{styleError}</p> : null}
          <Button
            size="sm"
            className="ladder-add"
            onClick={() => onChange({ ...button, style: 'link', action: undefined, url: '' })}
          >
            Change to link button
          </Button>
        </>
      )}
    </div>
  );
}

export function LinkButtonRows({
  guildId,
  rows,
  onChange,
  errorAt,
  sectionError,
}: {
  guildId: string;
  rows: readonly ActionRow[];
  onChange: (next: ActionRow[]) => void;
  errorAt: (path: string) => string | undefined;
  sectionError: string | undefined;
}): ReactElement {
  const taken = takenKeys(rows);

  const replace = (index: number, next: ActionRow): void =>
    onChange(rows.map((current, at) => (at === index ? next : current)));

  const drop = (index: number): void => onChange(rows.filter((_, at) => at !== index));

  return (
    <Section
      label="Link buttons"
      intro={BUTTONS_INTRO}
      note={`${rows.length} / ${ACTION_ROWS_MAX} rows`}
      actions={
        <Button
          size="sm"
          icon="plus"
          disabled={rows.length >= ACTION_ROWS_MAX}
          onClick={() => onChange([...rows, { kind: 'buttons', buttons: [newLinkButton(taken)] }])}
        >
          Add row
        </Button>
      }
    >
      {sectionError !== undefined ? (
        <p className="row-error" role="alert">
          {sectionError}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="section-intro">No link buttons.</p>
      ) : (
        <div className="stack stack-10">
          {rows.map((row, index) =>
            row.kind === 'buttons' ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: a row's position is its identity
              <div className="panel-sunken stack stack-12" key={index}>
                {row.buttons.map((button, at) => (
                  <LinkButton
                    key={button.key}
                    guildId={guildId}
                    button={button}
                    position={at + 1}
                    labelError={errorAt(`levelUpMessage.components.${index}.buttons.${at}.label`)}
                    urlError={errorAt(`levelUpMessage.components.${index}.buttons.${at}.url`)}
                    styleError={errorAt(`levelUpMessage.components.${index}.buttons.${at}.style`)}
                    onChange={(next) =>
                      replace(index, {
                        kind: 'buttons',
                        buttons: row.buttons.map((current, position) =>
                          position === at ? next : current,
                        ),
                      })
                    }
                    onRemove={() =>
                      row.buttons.length === 1
                        ? drop(index)
                        : replace(index, {
                            kind: 'buttons',
                            buttons: row.buttons.filter((_, position) => position !== at),
                          })
                    }
                  />
                ))}

                <div className="inline inline-8">
                  <Button
                    size="sm"
                    icon="plus"
                    disabled={row.buttons.length >= BUTTONS_PER_ROW_MAX}
                    onClick={() =>
                      replace(index, {
                        kind: 'buttons',
                        buttons: [...row.buttons, newLinkButton(taken)],
                      })
                    }
                  >
                    Add button
                  </Button>
                  <span className="text-xs text-muted">
                    {row.buttons.length} / {BUTTONS_PER_ROW_MAX}
                  </span>
                  <span className="push-right">
                    <Button tone="ghost" size="sm" icon="trash" onClick={() => drop(index)}>
                      Remove row
                    </Button>
                  </span>
                </div>
              </div>
            ) : (
              <Rows key={`select-${row.select.key}`}>
                <SettingRow
                  title="Dropdown on this message"
                  description="Level-up messages can only carry link buttons, so this message will not save until the dropdown is removed."
                >
                  <Button tone="danger-quiet" size="sm" icon="trash" onClick={() => drop(index)}>
                    Remove dropdown
                  </Button>
                </SettingRow>
              </Rows>
            ),
          )}
        </div>
      )}
    </Section>
  );
}
