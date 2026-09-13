import type { ActionRow, ContainerChild, V2Component } from '@proton/core';
import { ACTION_ROWS_MAX, MESSAGE_CONTENT_MAX } from '@proton/core';
import { type GreetingMessage, WELCOME_PLACEHOLDERS } from '@proton/module-welcome/config';
import type { ReactElement } from 'react';
import { useRef, useState } from 'react';
import { useRecent } from '../../components/ui/collection.tsx';
import {
  Button,
  IconButton,
  SegmentedControl,
  type SegmentedOption,
  Switch,
  TextArea,
} from '../../components/ui/controls.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { ConfirmDialog } from '../../components/ui/overlay.tsx';
import { LinkButtonRowEditor, newLinkButton, takenKeys } from './buttons.tsx';
import { EmbedsSection } from './embeds.tsx';
import type { ConfigErrors } from './errors.ts';
import { LayoutBuilder } from './layout.tsx';

const PLACEHOLDER_MEANING: Record<string, string> = {
  '{user}': 'Mentions the member',
  '{username}': 'The member’s display name',
  '{server}': 'The server’s name',
  '{memberCount}': 'The server’s member count',
};

const MODES: readonly SegmentedOption<'text' | 'layout'>[] = [
  { value: 'text', label: 'Text and embeds' },
  { value: 'layout', label: 'Layout' },
];

const TOKEN = /\{([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\}/g;
const KNOWN = new Set(WELCOME_PLACEHOLDERS.map((token) => token.slice(1, -1)));

const TRUNCATION_WARNING_AT = 1900;

function collectUnknown(value: unknown, found: Set<string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(TOKEN)) {
      const name = match[1];
      if (name !== undefined && !KNOWN.has(name)) found.add(name);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectUnknown(item, found);
    return;
  }

  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectUnknown(item, found);
  }
}

function allKeys(message: GreetingMessage): Set<string> {
  const keys = takenKeys(message.components);

  const fromChild = (child: ContainerChild): void => {
    if (child.kind === 'row') for (const key of takenKeys([child.row])) keys.add(key);
    else if (child.kind === 'section' && child.accessory.kind === 'button') {
      keys.add(child.accessory.button.key);
    }
  };

  for (const component of message.v2) {
    if (component.kind === 'container') for (const child of component.children) fromChild(child);
    else fromChild(component);
  }

  return keys;
}

function textIn(components: readonly V2Component[]): string[] {
  const lines: string[] = [];

  const fromChild = (child: V2Component): void => {
    if (child.kind === 'text') lines.push(child.content);
    if (child.kind === 'section') lines.push(...child.text);
  };

  for (const component of components) {
    if (component.kind === 'container') for (const child of component.children) fromChild(child);
    else fromChild(component);
  }

  return lines.filter((line) => line.trim() !== '');
}

export function GreetingMessageEditor({
  guildId,
  kind,
  value,
  onChange,
  errors,
  prefix,
  cardAttached,
}: {
  guildId: string;
  kind: 'welcome' | 'goodbye';
  value: GreetingMessage;
  onChange: (next: GreetingMessage) => void;
  errors: ConfigErrors;
  prefix: 'welcomeMessage' | 'goodbyeMessage';
  cardAttached: boolean;
}): ReactElement {
  const field = useRef<HTMLTextAreaElement>(null);
  const [building, setBuilding] = useState(false);
  const [confirmDrop, setConfirmDrop] = useState(false);
  const recent = useRecent();

  const content = value.content ?? '';
  const hasLayout = value.v2.length > 0;
  const layout = hasLayout || building;
  const silent =
    content.trim() === '' &&
    value.embeds.length === 0 &&
    value.components.length === 0 &&
    value.v2.length === 0;

  const unknown = new Set<string>();
  collectUnknown(value, unknown);

  const taken = allKeys(value);
  const contentError = errors.at(`${prefix}.content`);
  const layoutError = errors.at(`${prefix}.v2`);
  const rowsError = errors.at(`${prefix}.components`);

  const insert = (token: string): void => {
    const target = field.current;
    const at = target?.selectionStart ?? content.length;

    onChange({ ...value, content: `${content.slice(0, at)}${token}${content.slice(at)}` });
    queueMicrotask(() => {
      target?.focus();
      target?.setSelectionRange(at + token.length, at + token.length);
    });
  };

  const dropLayout = (): void => {
    const carried = textIn(value.v2).join('\n\n');
    const joined = content.trim() === '' ? carried : `${content}\n\n${carried}`;

    onChange({ ...value, content: joined.trim() === '' ? undefined : joined, v2: [] });
    setBuilding(false);
    setConfirmDrop(false);
  };

  const switchMode = (next: 'text' | 'layout'): void => {
    if (next === 'layout') {
      setBuilding(true);
      if (!hasLayout && content.trim() !== '') {
        onChange({ ...value, content: undefined, v2: [{ kind: 'text', content: content.trim() }] });
      }
      return;
    }

    if (!hasLayout) {
      setBuilding(false);
      return;
    }

    // Only text survives the move back, so anything else in the layout has to be confirmed away.
    if (value.v2.every((component) => component.kind === 'text')) dropLayout();
    else setConfirmDrop(true);
  };

  const notes: string[] = [];
  if (content.length > TRUNCATION_WARNING_AT) {
    notes.push('Once placeholders are filled in, anything past 2000 characters is cut off.');
  }
  for (const name of unknown) {
    notes.push(`Proton does not recognise {${name}}. It is posted as written.`);
  }

  const setRows = (rows: ActionRow[]): void => onChange({ ...value, components: rows });

  return (
    <>
      <Section
        label="Message"
        note={layout ? undefined : `${content.length} / ${MESSAGE_CONTENT_MAX}`}
        intro={
          silent
            ? cardAttached
              ? 'This message is empty, so only the card is posted.'
              : 'This message is empty, so nothing is posted.'
            : undefined
        }
        actions={
          <SegmentedControl
            label="Message format"
            value={layout ? 'layout' : 'text'}
            options={MODES}
            onChange={switchMode}
          />
        }
      >
        {layout ? (
          <>
            {layoutError !== undefined ? <p className="row-error">{layoutError}</p> : null}
            <LayoutBuilder
              guildId={guildId}
              value={value.v2}
              taken={taken}
              prefix={`${prefix}.v2`}
              errors={errors}
              onChange={(next) => onChange({ ...value, v2: next })}
            />
          </>
        ) : (
          <Rows>
            <SettingRow
              title="Text"
              description="Supports Discord markdown. Placeholders also work in embeds and buttons."
              stacked
              error={contentError}
              note={
                notes.length === 0
                  ? undefined
                  : notes.map((line) => (
                      <span key={line} style={{ display: 'block' }}>
                        {line}
                      </span>
                    ))
              }
            >
              <div className="welcome-stacked stack stack-8">
                <div className="chip-list">
                  {WELCOME_PLACEHOLDERS.map((token) => (
                    <button
                      key={token}
                      type="button"
                      className="chip welcome-token"
                      title={PLACEHOLDER_MEANING[token]}
                      onClick={() => insert(token)}
                    >
                      {token}
                    </button>
                  ))}
                </div>
                <TextArea
                  ref={field}
                  aria-label={kind === 'welcome' ? 'Welcome message' : 'Goodbye message'}
                  rows={5}
                  maxLength={MESSAGE_CONTENT_MAX}
                  invalid={contentError !== undefined}
                  value={content}
                  onChange={(event) =>
                    onChange({ ...value, content: event.currentTarget.value || undefined })
                  }
                />
              </div>
            </SettingRow>
          </Rows>
        )}
      </Section>

      {layout && value.embeds.length === 0 ? null : (
        <EmbedsSection
          value={value.embeds}
          prefix={`${prefix}.embeds`}
          errors={errors}
          onChange={(embeds) => onChange({ ...value, embeds })}
        />
      )}

      {layout && value.components.length === 0 ? null : (
        <Section
          label="Link buttons"
          note={`${value.components.length} / ${ACTION_ROWS_MAX} rows`}
          actions={
            <Button
              size="sm"
              icon="plus"
              disabled={value.components.length >= ACTION_ROWS_MAX}
              onClick={() => {
                recent.mark(value.components.length);
                setRows([
                  ...value.components,
                  { kind: 'buttons', buttons: [newLinkButton(taken)] },
                ]);
              }}
            >
              Add row
            </Button>
          }
        >
          {rowsError !== undefined ? <p className="row-error">{rowsError}</p> : null}

          {value.components.length === 0 ? (
            <p className="section-intro">
              No link buttons. This message can carry link buttons only, because Proton does not
              respond to presses on it.
            </p>
          ) : (
            <div className="stack stack-10">
              {value.components.map((row, index) =>
                row.kind === 'buttons' ? (
                  <LinkButtonRowEditor
                    // biome-ignore lint/suspicious/noArrayIndexKey: a row's position is its identity
                    key={index}
                    className={recent.enter(index, 'part')}
                    guildId={guildId}
                    row={row}
                    taken={taken}
                    prefix={`${prefix}.components.${index}.buttons`}
                    errorAt={errors.at}
                    onChange={(next) =>
                      setRows(
                        value.components.map((current, at) => (at === index ? next : current)),
                      )
                    }
                    onRemove={() => setRows(value.components.filter((_, at) => at !== index))}
                  />
                ) : (
                  <div
                    className="panel-sunken inline inline-8"
                    // biome-ignore lint/suspicious/noArrayIndexKey: a row's position is its identity
                    key={index}
                  >
                    <span className="text-sm text-danger">
                      {errors.at(`${prefix}.components.${index}`) ??
                        'This row is a dropdown, which this message cannot carry.'}
                    </span>
                    <span className="push-right">
                      <IconButton
                        icon="trash"
                        tone="ghost"
                        size="sm"
                        label={`Remove row ${index + 1}`}
                        onClick={() => setRows(value.components.filter((_, at) => at !== index))}
                      />
                    </span>
                  </div>
                ),
              )}
            </div>
          )}
        </Section>
      )}

      <Section
        label="Mentions"
        intro="Choose who this message can ping. Mentions that are off still show but do not notify anyone."
      >
        <Rows>
          <SettingRow title="@everyone and @here">
            <Switch
              label="Ping @everyone and @here"
              checked={value.mentions.everyone}
              onChange={(next) =>
                onChange({ ...value, mentions: { ...value.mentions, everyone: next } })
              }
            />
          </SettingRow>
          <SettingRow title="Roles">
            <Switch
              label="Ping roles"
              checked={value.mentions.roles}
              onChange={(next) =>
                onChange({ ...value, mentions: { ...value.mentions, roles: next } })
              }
            />
          </SettingRow>
          <SettingRow title="Members">
            <Switch
              label="Ping members"
              checked={value.mentions.users}
              onChange={(next) =>
                onChange({ ...value, mentions: { ...value.mentions, users: next } })
              }
            />
          </SettingRow>
        </Rows>
      </Section>

      <ConfirmDialog
        open={confirmDrop}
        danger
        title="Remove layout?"
        confirmLabel="Remove"
        onClose={() => setConfirmDrop(false)}
        onConfirm={dropLayout}
      >
        Text from the layout moves into the message. The {value.v2.length} component
        {value.v2.length === 1 ? '' : 's'} in the layout will be removed, including any dividers,
        images and link buttons.
      </ConfirmDialog>
    </>
  );
}
