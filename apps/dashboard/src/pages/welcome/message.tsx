import type { ActionRow, V2Component } from '@proton/core';
import { ACTION_ROWS_MAX, MESSAGE_CONTENT_MAX } from '@proton/core';
import type { PlaceholderSurface, SurfaceDiagnostic } from '@proton/core/placeholders';
import type { GreetingMessage } from '@proton/module-welcome/config';
import {
  type GreetingPlaceholderFacts,
  WELCOME_BOOST_SURFACE,
  WELCOME_JOIN_SURFACE,
  WELCOME_LEAVE_SURFACE,
} from '@proton/module-welcome/placeholders';
import type { ReactElement } from 'react';
import { useState } from 'react';
import {
  blank,
  type ConfigErrors,
  EmbedEditor,
  MessageField,
} from '../../components/discord/embed-editor.tsx';
import {
  LayoutBuilder,
  takenKeys as layoutKeys,
  newLinkButton,
} from '../../components/discord/layout-builder.tsx';
import { placeholderSlot } from '../../components/discord/message-editor.tsx';
import { useRecent } from '../../components/ui/collection.tsx';
import {
  Button,
  IconButton,
  SegmentedControl,
  type SegmentedOption,
  Switch,
} from '../../components/ui/controls.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { ConfirmDialog } from '../../components/ui/overlay.tsx';
import { LinkButtonRowEditor, takenKeys as rowKeys } from './buttons.tsx';

export type GreetingKind = 'welcome' | 'goodbye' | 'boost';

export type GreetingMessageKey = 'welcomeMessage' | 'goodbyeMessage' | 'boostMessage';

export type DiagnosticsAt = (path: string) => readonly SurfaceDiagnostic[];

export const GREETING_SURFACES: Readonly<
  Record<GreetingKind, PlaceholderSurface<GreetingPlaceholderFacts>>
> = {
  welcome: WELCOME_JOIN_SURFACE,
  goodbye: WELCOME_LEAVE_SURFACE,
  boost: WELCOME_BOOST_SURFACE,
};

const MESSAGE_LABEL: Record<GreetingKind, string> = {
  welcome: 'Welcome message',
  goodbye: 'Goodbye message',
  boost: 'Boost message',
};

const MODES: readonly SegmentedOption<'text' | 'layout'>[] = [
  { value: 'text', label: 'Text and embeds' },
  { value: 'layout', label: 'Layout' },
];

const TRUNCATION_WARNING_AT = 1900;

const TRUNCATION_NOTE =
  'Once placeholders are filled in, anything past 2000 characters is cut off.';

function allKeys(message: GreetingMessage): Set<string> {
  return new Set([...rowKeys(message.components), ...layoutKeys(message.v2)]);
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
  diagnosticsAt,
  prefix,
  cardAttached,
}: {
  guildId: string;
  kind: GreetingKind;
  value: GreetingMessage;
  onChange: (next: GreetingMessage) => void;
  errors: ConfigErrors;
  diagnosticsAt: DiagnosticsAt;
  prefix: GreetingMessageKey;
  cardAttached: boolean;
}): ReactElement {
  const [building, setBuilding] = useState(false);
  const [confirmDrop, setConfirmDrop] = useState(false);
  const recent = useRecent();

  const placeholders = placeholderSlot(GREETING_SURFACES[kind], diagnosticsAt);

  const content = value.content ?? '';
  const hasLayout = value.v2.length > 0;
  const layout = hasLayout || building;
  const silent =
    content.trim() === '' &&
    value.embeds.length === 0 &&
    value.components.length === 0 &&
    value.v2.length === 0;

  const taken = allKeys(value);
  const layoutError = errors.at(`${prefix}.v2`);
  const rowsError = errors.at(`${prefix}.components`);

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
              placeholders={placeholders}
              onChange={(next) => onChange({ ...value, v2: next })}
            />
          </>
        ) : (
          <Rows>
            <SettingRow
              title="Text"
              stacked
            >
              <MessageField
                placeholders={placeholders}
                path={`${prefix}.content`}
                label={MESSAGE_LABEL[kind]}
                rows={5}
                layout="wide"
                maxLength={MESSAGE_CONTENT_MAX}
                value={content}
                error={errors.at(`${prefix}.content`)}
                note={content.length > TRUNCATION_WARNING_AT ? TRUNCATION_NOTE : undefined}
                onChange={(next) => onChange({ ...value, content: blank(next) })}
              />
            </SettingRow>
          </Rows>
        )}
      </Section>

      {layout && value.embeds.length === 0 ? null : (
        <EmbedEditor
          value={value.embeds}
          prefix={`${prefix}.embeds`}
          errors={errors}
          placeholders={placeholders}
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
                    errors={errors}
                    placeholders={placeholders}
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
