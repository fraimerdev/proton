import { parseComponentEmoji } from '@proton/core';
import {
  TEXT_CHANNEL_TYPE,
  type TicketPanel,
  typeFor,
  typesOf,
} from '@proton/module-tickets/config';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { ChannelPicker } from '../../components/discord/channel-picker.tsx';
import { EmojiGlyph } from '../../components/discord/emoji-picker.tsx';
import { ColourPicker } from '../../components/discord/inputs.tsx';
import { DiscordPreview } from '../../components/discord/message-preview.tsx';
import {
  Button,
  Chip,
  IconButton,
  SegmentedControl,
  Select,
  TextArea,
  TextInput,
} from '../../components/ui/controls.tsx';
import { EmptyState } from '../../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { channelsQuery } from '../../lib/queries.ts';
import {
  BUTTONS_SHOWN_MAX,
  DEFAULT_SELECT_PLACEHOLDER,
  noTypesReason,
  panelPreview,
} from './panel-preview.ts';
import {
  hexOf,
  moveInList,
  PANEL_STYLE_OPTIONS,
  TICKET_ACCENT,
  type TicketsForm,
  updatePanelAt,
} from './shape.ts';

const NAME_MAX = 64;
const TITLE_MAX = 256;
const BODY_MAX = 2000;
const AUTHOR_MAX = 256;
const FOOTER_MAX = 2048;
const URL_MAX = 2000;
const PLACEHOLDER_MAX = 150;
const TYPE_IDS_MAX = 25;

const NO_CHANNEL = 'Choose a channel. A panel without one cannot be posted.';

const BAD_URL = 'Use a full link starting with http:// or https://.';

const POSTS_A_NEW_MESSAGE =
  'Post it from the Panels list. Each post adds a new message rather than replacing the last one.';

function urlError(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  return /^https?:\/\//i.test(value) && URL.canParse(value) ? undefined : BAD_URL;
}

export function PanelEditor({
  form,
  guildId,
  panel,
  index,
}: {
  form: TicketsForm;
  guildId: string;
  panel: TicketPanel;
  index: number;
}): ReactElement {
  const config = form.value;
  const path = `panels.${index}`;

  const { data: channels } = useQuery(channelsQuery(guildId));
  const channel = (channels ?? []).find((candidate) => candidate.id === panel.channelId);

  const carried = typesOf(config, panel);
  const patch = (change: Partial<TicketPanel>): void => updatePanelAt(form, index, change);

  const thumbnailError = urlError(panel.thumbnailUrl) ?? form.errorAt(`${path}.thumbnailUrl`);
  const imageError = urlError(panel.imageUrl) ?? form.errorAt(`${path}.imageUrl`);

  const overflow =
    panel.style === 'buttons' && carried.length > BUTTONS_SHOWN_MAX
      ? carried.length - BUTTONS_SHOWN_MAX
      : 0;

  const unattached = config.types.filter((type) => !panel.typeIds.includes(type.id));

  return (
    <div className="editor">
      <div className="editor-main">
        <Section label="Posting">
          <Rows>
            <SettingRow
              title="Channel"
              description="Where Proton posts this panel."
              error={panel.channelId === '' ? NO_CHANNEL : form.errorAt(`${path}.channelId`)}
              note={POSTS_A_NEW_MESSAGE}
            >
              <ChannelPicker
                guildId={guildId}
                label="Channel"
                allowNone={false}
                types={[TEXT_CHANNEL_TYPE]}
                invalid={panel.channelId === ''}
                value={panel.channelId === '' ? null : panel.channelId}
                onChange={(next) => patch({ channelId: next ?? '' })}
              />
            </SettingRow>
          </Rows>
        </Section>

        <Section label="Message">
          <Rows>
            <SettingRow
              title="Name"
              description="Shown as the heading when none is set, and in /ticket panel."
              error={form.errorAt(`${path}.name`)}
            >
              <TextInput
                width="md"
                aria-label="Name"
                maxLength={NAME_MAX}
                invalid={form.errorAt(`${path}.name`) !== undefined}
                value={panel.name}
                onChange={(event) => patch({ name: event.currentTarget.value })}
              />
            </SettingRow>

            <SettingRow title="Heading" error={form.errorAt(`${path}.title`)}>
              <TextInput
                width="md"
                aria-label="Heading"
                placeholder={panel.name}
                maxLength={TITLE_MAX}
                value={panel.title ?? ''}
                onChange={(event) =>
                  patch({
                    title: event.currentTarget.value === '' ? undefined : event.currentTarget.value,
                  })
                }
              />
            </SettingRow>

            <SettingRow title="Body" error={form.errorAt(`${path}.panelText`)} stacked>
              <TextArea
                aria-label="Body"
                rows={6}
                maxLength={BODY_MAX}
                invalid={form.errorAt(`${path}.panelText`) !== undefined}
                value={panel.panelText}
                onChange={(event) => patch({ panelText: event.currentTarget.value })}
              />
            </SettingRow>

            <SettingRow title="Text above heading" error={form.errorAt(`${path}.authorName`)}>
              <TextInput
                width="md"
                aria-label="Text above heading"
                maxLength={AUTHOR_MAX}
                value={panel.authorName ?? ''}
                onChange={(event) =>
                  patch({
                    authorName:
                      event.currentTarget.value === '' ? undefined : event.currentTarget.value,
                  })
                }
              />
            </SettingRow>

            <SettingRow title="Footer" error={form.errorAt(`${path}.footerText`)}>
              <TextInput
                width="md"
                aria-label="Footer"
                maxLength={FOOTER_MAX}
                value={panel.footerText ?? ''}
                onChange={(event) =>
                  patch({
                    footerText:
                      event.currentTarget.value === '' ? undefined : event.currentTarget.value,
                  })
                }
              />
            </SettingRow>

            <SettingRow
              title="Accent colour"
              description={`Leave unset to use the default colour, ${hexOf(TICKET_ACCENT)}.`}
              error={form.errorAt(`${path}.colour`)}
            >
              {panel.colour === undefined ? (
                <Button size="sm" onClick={() => patch({ colour: TICKET_ACCENT })}>
                  Choose colour
                </Button>
              ) : (
                <span className="inline inline-6">
                  <ColourPicker
                    label="Accent colour"
                    value={panel.colour}
                    onChange={(next) => patch({ colour: next })}
                  />
                  <IconButton
                    icon="x"
                    tone="ghost"
                    size="sm"
                    label="Use default colour"
                    onClick={() => patch({ colour: undefined })}
                  />
                </span>
              )}
            </SettingRow>

            <SettingRow title="Thumbnail URL" error={thumbnailError} stacked>
              <TextInput
                type="url"
                width="full"
                aria-label="Thumbnail URL"
                spellCheck={false}
                maxLength={URL_MAX}
                invalid={thumbnailError !== undefined}
                value={panel.thumbnailUrl ?? ''}
                onChange={(event) =>
                  patch({
                    thumbnailUrl:
                      event.currentTarget.value === '' ? undefined : event.currentTarget.value,
                  })
                }
              />
            </SettingRow>

            <SettingRow title="Image URL" error={imageError} stacked>
              <TextInput
                type="url"
                width="full"
                aria-label="Image URL"
                spellCheck={false}
                maxLength={URL_MAX}
                invalid={imageError !== undefined}
                value={panel.imageUrl ?? ''}
                onChange={(event) =>
                  patch({
                    imageUrl:
                      event.currentTarget.value === '' ? undefined : event.currentTarget.value,
                  })
                }
              />
            </SettingRow>
          </Rows>
        </Section>

        <Section label="Ticket types">
          <Rows>
            <SettingRow
              title="Style"
              description="Buttons show up to 15 ticket types. A dropdown shows up to 25."
            >
              <SegmentedControl
                label="Style"
                options={PANEL_STYLE_OPTIONS}
                value={panel.style}
                onChange={(next) => patch({ style: next })}
              />
            </SettingRow>

            {panel.style === 'select' ? (
              <SettingRow
                title="Dropdown placeholder"
                error={form.errorAt(`${path}.selectPlaceholder`)}
              >
                <TextInput
                  width="md"
                  aria-label="Dropdown placeholder"
                  placeholder={DEFAULT_SELECT_PLACEHOLDER}
                  maxLength={PLACEHOLDER_MAX}
                  value={panel.selectPlaceholder ?? ''}
                  onChange={(event) =>
                    patch({
                      selectPlaceholder:
                        event.currentTarget.value === '' ? undefined : event.currentTarget.value,
                    })
                  }
                />
              </SettingRow>
            ) : null}
          </Rows>

          <div className="tickets-typeids">
            <div className="inline inline-8">
              <span className="row-detail-label">Ticket types on this panel</span>
              <span className="text-xs text-muted">
                {panel.typeIds.length} / {TYPE_IDS_MAX}
              </span>
            </div>

            {panel.typeIds.length === 0 ? (
              <p className="row-error">{noTypesReason(panel)}</p>
            ) : (
              <Rows>
                {panel.typeIds.map((typeId, at) => {
                  const type = typeFor(config, typeId);
                  const emoji = parseComponentEmoji(type?.emoji);

                  // Counts only ids that still resolve: a deleted type's entry uses no button slot.
                  const resolvedAt = panel.typeIds
                    .slice(0, at)
                    .filter((id) => typeFor(config, id) !== undefined).length;

                  const dropped =
                    panel.style === 'buttons' &&
                    type !== undefined &&
                    resolvedAt >= BUTTONS_SHOWN_MAX;

                  return (
                    <div className="tickets-typeid-row" key={typeId}>
                      <span className="tickets-typeid-main">
                        {emoji ? <EmojiGlyph emoji={emoji} size={16} /> : null}
                        {type === undefined ? (
                          <span className="text-danger">
                            No ticket type has the ID <span className="mono">{typeId}</span>. It was
                            deleted, so this entry opens nothing.
                          </span>
                        ) : (
                          <>
                            <span className="truncate">{type.name}</span>
                            <Chip className="mono">{type.id}</Chip>
                          </>
                        )}
                        {dropped ? <span className="text-warning text-xs">Not shown</span> : null}
                      </span>

                      <IconButton
                        icon="caret-up"
                        tone="ghost"
                        size="sm"
                        label={`Move ${type?.name ?? typeId} up`}
                        disabled={at === 0}
                        onClick={() => patch({ typeIds: moveInList(panel.typeIds, at, at - 1) })}
                      />
                      <IconButton
                        icon="caret-down"
                        tone="ghost"
                        size="sm"
                        label={`Move ${type?.name ?? typeId} down`}
                        disabled={at === panel.typeIds.length - 1}
                        onClick={() => patch({ typeIds: moveInList(panel.typeIds, at, at + 1) })}
                      />
                      <IconButton
                        icon="x"
                        tone="ghost"
                        size="sm"
                        label={`Remove ${type?.name ?? typeId}`}
                        onClick={() =>
                          patch({
                            typeIds: panel.typeIds.filter((_, position) => position !== at),
                          })
                        }
                      />
                    </div>
                  );
                })}
              </Rows>
            )}

            {overflow > 0 ? (
              <p className="row-note">
                Only the first {BUTTONS_SHOWN_MAX} are shown as buttons. Use the dropdown style to
                offer all {carried.length}.
              </p>
            ) : null}

            {unattached.length > 0 && panel.typeIds.length < TYPE_IDS_MAX ? (
              <Select
                width="lg"
                aria-label="Add ticket type"
                placeholder="Add ticket type…"
                value=""
                options={unattached.map((type) => ({ value: type.id, label: type.name }))}
                onChange={(next) => {
                  if (next !== '') patch({ typeIds: [...panel.typeIds, next] });
                }}
              />
            ) : null}
          </div>
        </Section>
      </div>

      <div className="editor-preview">
        <div className="editor-preview-head">
          <span className="editor-preview-title">Preview</span>
        </div>

        {carried.length === 0 ? (
          <EmptyState icon="megaphone" title="Nothing to post" inset>
            {noTypesReason(panel)}
          </EmptyState>
        ) : (
          <DiscordPreview
            message={{ v2: panelPreview(panel, carried) }}
            channelName={channel?.name}
          />
        )}

        {panel.style === 'select' && carried.length > 0 ? (
          <div className="tickets-preview-options">
            <span className="text-xs text-muted">In the dropdown, in order:</span>
            <span className="inline inline-6 inline-wrap">
              {carried.slice(0, TYPE_IDS_MAX).map((type) => (
                <Chip key={type.id}>{type.name}</Chip>
              ))}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
