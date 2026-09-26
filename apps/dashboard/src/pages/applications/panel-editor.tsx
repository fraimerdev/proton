import type { PanelConfig } from '@proton/module-applications/config';
import { PANEL_FORMS_MAX } from '@proton/module-applications/constants';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { ChannelPicker } from '../../components/discord/channel-picker.tsx';
import { EmojiGlyph } from '../../components/discord/emoji-picker.tsx';
import { ColourPicker } from '../../components/discord/inputs.tsx';
import { DiscordPreview } from '../../components/discord/message-preview.tsx';
import { TestMessage } from '../../components/module/test-message.tsx';
import {
  Badge,
  Button,
  IconButton,
  SegmentedControl,
  Select,
  Switch,
  TextArea,
  TextInput,
} from '../../components/ui/controls.tsx';
import { EmptyState } from '../../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { channelsQuery } from '../../lib/queries.ts';
import {
  type ApplicationsForm,
  formTitle,
  moveInList,
  PANEL_ACCENT,
  PANEL_STYLE_OPTIONS,
  panelFormLimit,
  panelForms,
  panelPreview,
  updatePanelAt,
  withOptional,
} from './shape.ts';

const NAME_MAX = 80;
const TITLE_MAX = 256;
const BODY_MAX = 2000;
const PANEL_CHANNEL_TYPES = [0, 5] as const;

const POSTS_A_NEW_MESSAGE =
  'Post it from the Panels list. Each post adds a new message rather than replacing the last one.';

const NO_CHANNEL = 'Choose a channel. A panel without one can’t be posted.';

function hex(colour: number): string {
  return `#${colour.toString(16).padStart(6, '0')}`;
}

export function PanelEditor({
  form,
  guildId,
  index,
}: {
  form: ApplicationsForm;
  guildId: string;
  index: number;
}): ReactElement | null {
  const channels = useQuery(channelsQuery(guildId));
  const config = form.value;
  const panel = config.panels[index];
  if (panel === undefined) return null;

  const path = `panels.${index}`;
  const listed = panelForms(config, panel);
  const limit = panelFormLimit(panel.style);
  const unlisted = config.forms.filter((entry) => !panel.formIds.includes(entry.id));
  const channel = (channels.data ?? []).find((candidate) => candidate.id === panel.channelId);

  const patch = (change: (value: PanelConfig) => PanelConfig): void =>
    updatePanelAt(form, index, change);

  const formsError =
    panel.formIds.length === 0
      ? 'Add at least one form. A panel with no forms can’t be saved.'
      : panel.formIds.length > limit
        ? panel.style === 'buttons'
          ? `A panel with buttons can list up to ${limit} forms. Remove some or switch to a dropdown.`
          : `A dropdown can list up to ${limit} forms.`
        : (form.errorAt(`${path}.formIds`) ?? form.errorAt(`${path}.style`));

  return (
    <div className="editor">
      <div className="editor-main">
        <Section label="Posting">
          <Rows>
            <SettingRow
              title="Channel"
              error={panel.channelId === undefined ? NO_CHANNEL : form.errorAt(`${path}.channelId`)}
              note={POSTS_A_NEW_MESSAGE}
            >
              <ChannelPicker
                guildId={guildId}
                label="Channel"
                types={PANEL_CHANNEL_TYPES}
                invalid={panel.channelId === undefined}
                value={panel.channelId ?? null}
                onChange={(next) =>
                  patch((value) => withOptional(value, 'channelId', next ?? undefined))
                }
              />
            </SettingRow>
          </Rows>
        </Section>

        <Section label="Message">
          <Rows>
            <SettingRow
              title="Name"
              description="Only you see this, in the dashboard."
              error={
                panel.name.trim() === '' ? 'A panel needs a name.' : form.errorAt(`${path}.name`)
              }
            >
              <TextInput
                width="md"
                aria-label="Name"
                maxLength={NAME_MAX}
                invalid={panel.name.trim() === ''}
                value={panel.name}
                onChange={(event) =>
                  patch((value) => ({ ...value, name: event.currentTarget.value }))
                }
              />
            </SettingRow>

            <SettingRow title="Heading" error={form.errorAt(`${path}.title`)}>
              <TextInput
                width="md"
                aria-label="Heading"
                maxLength={TITLE_MAX}
                value={panel.title}
                onChange={(event) =>
                  patch((value) => ({ ...value, title: event.currentTarget.value }))
                }
              />
            </SettingRow>

            <SettingRow stacked title="Text" error={form.errorAt(`${path}.body`)}>
              <TextArea
                rows={4}
                aria-label="Text"
                maxLength={BODY_MAX}
                value={panel.body}
                onChange={(event) =>
                  patch((value) => ({ ...value, body: event.currentTarget.value }))
                }
              />
            </SettingRow>

            <SettingRow
              title="Accent colour"
              description={`Leave unset to use Proton’s blue, ${hex(PANEL_ACCENT)}.`}
              error={form.errorAt(`${path}.colour`)}
            >
              {panel.colour === undefined ? (
                <Button
                  size="sm"
                  onClick={() => patch((value) => ({ ...value, colour: PANEL_ACCENT }))}
                >
                  Choose colour
                </Button>
              ) : (
                <span className="inline inline-6">
                  <ColourPicker
                    label="Accent colour"
                    value={panel.colour}
                    onChange={(colour) => patch((value) => ({ ...value, colour }))}
                  />
                  <IconButton
                    icon="x"
                    tone="ghost"
                    size="sm"
                    label="Use the default colour"
                    onClick={() => patch((value) => withOptional(value, 'colour', undefined))}
                  />
                </span>
              )}
            </SettingRow>
          </Rows>
        </Section>

        <Section label="Forms">
          <Rows>
            <SettingRow
              title="Style"
              description={`Buttons show up to 10 forms. A dropdown shows up to ${PANEL_FORMS_MAX}.`}
            >
              <SegmentedControl
                label="Style"
                options={PANEL_STYLE_OPTIONS}
                value={panel.style}
                onChange={(style) => patch((value) => ({ ...value, style }))}
              />
            </SettingRow>

            <SettingRow
              title="My applications button"
              description="Lets members check on what they’ve sent without a command."
            >
              <Switch
                label="My applications button"
                checked={panel.showMine}
                onChange={(showMine) => patch((value) => ({ ...value, showMine }))}
              />
            </SettingRow>

            <SettingRow
              stacked
              title={`Forms on this panel (${panel.formIds.length} / ${limit})`}
              helpLabel="Forms on this panel"
              help="Closed and archived forms stay on the panel. Members who pick one see why it isn’t taking applications."
              error={formsError}
            >
              <div className="stack stack-8">
                {panel.formIds.length > 0 ? (
                  <ul className="applications-panel-forms">
                    {panel.formIds.map((formId, at) => {
                      const entry = config.forms.find((candidate) => candidate.id === formId);
                      const name = entry === undefined ? formId : formTitle(entry);
                      return (
                        <li key={formId} className="applications-panel-form">
                          <span className="applications-panel-form-main">
                            {entry?.emoji !== undefined ? (
                              <EmojiGlyph emoji={entry.emoji} size={16} />
                            ) : null}
                            {entry === undefined ? (
                              <span className="text-danger">
                                No form has the ID <span className="mono">{formId}</span>. Remove
                                it.
                              </span>
                            ) : (
                              <span className="truncate">{name}</span>
                            )}
                            {entry?.archived ? <Badge>Archived</Badge> : null}
                          </span>
                          <IconButton
                            icon="caret-up"
                            tone="ghost"
                            size="sm"
                            label={`Move ${name} up`}
                            disabled={at === 0}
                            onClick={() =>
                              patch((value) => ({
                                ...value,
                                formIds: moveInList(value.formIds, at, at - 1),
                              }))
                            }
                          />
                          <IconButton
                            icon="caret-down"
                            tone="ghost"
                            size="sm"
                            label={`Move ${name} down`}
                            disabled={at === panel.formIds.length - 1}
                            onClick={() =>
                              patch((value) => ({
                                ...value,
                                formIds: moveInList(value.formIds, at, at + 1),
                              }))
                            }
                          />
                          <IconButton
                            icon="x"
                            tone="ghost"
                            size="sm"
                            label={`Take ${name} off this panel`}
                            onClick={() =>
                              patch((value) => ({
                                ...value,
                                formIds: value.formIds.filter((_, spot) => spot !== at),
                              }))
                            }
                          />
                        </li>
                      );
                    })}
                  </ul>
                ) : null}

                {unlisted.length > 0 && panel.formIds.length < limit ? (
                  <Select
                    width="lg"
                    aria-label="Add a form"
                    placeholder="Add a form…"
                    value=""
                    options={unlisted.map((entry) => ({
                      value: entry.id,
                      label: formTitle(entry),
                    }))}
                    onChange={(next) => {
                      if (next === '') return;
                      patch((value) => ({ ...value, formIds: [...value.formIds, next] }));
                    }}
                  />
                ) : null}
              </div>
            </SettingRow>
          </Rows>
        </Section>
      </div>

      <div className="editor-preview">
        <div className="editor-preview-head">
          <span className="editor-preview-title">Preview</span>
          <TestMessage
            guildId={guildId}
            moduleId="applications"
            simulations={form.view.simulations}
            simulationId="applications.panel"
            draft={config as unknown as Record<string, unknown>}
            dirty={form.dirty}
            fixed={{ panelIndex: index }}
            configuredChannelId={panel.channelId ?? null}
            refusal={listed.length === 0 ? 'Add a form first.' : undefined}
          />
        </div>

        {listed.length === 0 ? (
          <EmptyState icon="megaphone" title="Nothing to post" inset>
            Add a form to this panel to see it.
          </EmptyState>
        ) : (
          <DiscordPreview
            message={{ v2: panelPreview(panel, listed) }}
            channelName={channel?.name}
          />
        )}
      </div>
    </div>
  );
}
