import type { ActionRow, ProtonMessage } from '@proton/core';
import { ACTION_ROWS_MAX, interactiveKeys, LIMIT_LABELS, MAX_CUSTOM_ID_LENGTH } from '@proton/core';
import type {
  MessagesConfig,
  SavedMessage,
  TemplateSchedule,
} from '@proton/module-messages/config';
import {
  componentKeys,
  encodedLength,
  MIN_REPEAT_MS,
  normaliseTemplateName,
  SCHEDULE_HELP,
  SCHEDULE_MODES,
  TEMPLATE_NAME_MAX,
  withFreshKeys,
} from '@proton/module-messages/config';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { ChannelPicker, POSTABLE_CHANNEL_TYPES } from '../../components/discord/channel-picker.tsx';
import { DurationInput } from '../../components/discord/inputs.tsx';
import {
  type EditableMessage,
  EditorPreviewLayout,
  MessageEditor,
} from '../../components/discord/message-editor.tsx';
import { DiscordPreview } from '../../components/discord/message-preview.tsx';
import { RolePicker } from '../../components/discord/role-picker.tsx';
import type { ModuleForm } from '../../components/module/form.ts';
import { ModuleLink, useModuleNavigate } from '../../components/module/route.tsx';
import {
  CollectionButtonRow,
  CollectionHeader,
  LimitCounter,
  MetaSeparator,
  useRecent,
} from '../../components/ui/collection.tsx';
import {
  Badge,
  Button,
  Chip,
  Field,
  SearchField,
  SegmentedControl,
  Select,
  Switch,
  TextInput,
} from '../../components/ui/controls.tsx';
import { EmptyState, Spinner, StatusBanner } from '../../components/ui/feedback.tsx';
import { ExpandableRow, Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { ConfirmDialog, Dialog, MenuButton } from '../../components/ui/overlay.tsx';
import { SegmentedTabs } from '../../components/ui/tabs.tsx';
import { ceilingNote, listCeiling } from '../../lib/limits.ts';
import { channelsQuery } from '../../lib/queries.ts';
import { type KeyContext, RowEditor } from './row-editor.tsx';
import {
  describeRow,
  emptyTemplate,
  isoWithOffset,
  mentionCaption,
  newButtonRow,
  newSelectRow,
  scheduleSummary,
  startHasPassed,
  templateContents,
  uniqueName,
  V2_PRESS_UNROUTABLE,
} from './shared.ts';

const NAME_HELP = 'Used with /message post. Posted buttons also depend on it.';

const RENAME_WARNING =
  'Buttons already posted from this template use the old name, so they stop working until you ' +
  'post it again.';

const EMPTY_BODY = 'Create a template, then post it with /message post or on a schedule.';

const EXTRA_EMBEDS =
  'Only the first embed can be edited here. The others are kept and shown in the preview.';

const V2_TEMPLATE =
  'A layout replaces the whole message, so this template has no text, embeds or button rows of ' +
  'its own. Saving keeps the layout as it is, and the preview shows how Discord displays it.';

const V2_REPLACE =
  'The layout is cleared and you start again with text and embeds. This cannot be undone once ' +
  'you save.';

const PING_OVERRIDES =
  'Mention this role at the start of each scheduled post. Discord cannot combine this with the ' +
  'template’s mention settings, so only this role is pinged.';

const PING_IN_LAYOUT =
  'A layout has no message text, so Proton cannot add the mention. Write the role mention into a ' +
  'text display yourself, and it still pings.';

const PING_OVERRIDES_MENTIONS =
  'The schedule pings a role, which replaces these mention settings on scheduled posts.';

const PASSED =
  'The start time has passed. If Proton missed it during downtime, the post may still go out.';

const AT_HELP = 'A complete ISO timestamp carrying a timezone, such as 2026-01-31T09:00:00Z.';

const SCHEDULE_OFF_HELP = 'Switch off to stop posting without removing the schedule.';

const NO_PALETTE = 'Create one under Saved rows.';

const NOTHING_YET = 'Add buttons or a dropdown that give members a role or reply to them.';

const STATUS_OPTIONS = [
  { value: 'all', label: 'All templates' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'unscheduled', label: 'Not scheduled' },
];

interface Search {
  q?: string | undefined;
  status?: string | undefined;
  id?: string | undefined;
}

interface AreaProps {
  guildId: string;
  moduleId: string;
  form: ModuleForm<MessagesConfig>;
  search: Search;
  index: number;
}

function duplicateName(name: string): string {
  return `two saved messages are both called '${name}' — /message post could not say which of them you meant`;
}

function templateMessage(template: SavedMessage): EditableMessage {
  return {
    content: template.content,
    embeds: template.embeds,
    components: template.components,
    mentions: template.mentions,
  };
}

function previewOf(template: SavedMessage): Partial<ProtonMessage> {
  const ping = template.schedule?.pingRoleId;
  const body = template.content ?? '';

  return {
    content: ping !== undefined && template.v2.length === 0 ? `<@&${ping}>\n${body}` : body,
    embeds: template.embeds,
    components: template.components,
    mentions: template.mentions,
    v2: template.v2,
  };
}

export function TemplatesArea(props: AreaProps): ReactElement {
  const template = props.index >= 0 ? props.form.value.templates[props.index] : undefined;

  if (template) return <TemplateEditor {...props} template={template} />;

  if (props.search.id !== undefined) {
    return (
      <EmptyState icon="chat-centered-text" title="Template not found" inset>
        It may have been renamed or deleted.{' '}
        <ModuleLink
          guildId={props.guildId}
          moduleId={props.moduleId}
          search={{ area: 'templates' }}
        >
          Back to templates
        </ModuleLink>
      </EmptyState>
    );
  }

  return <TemplateList {...props} />;
}

function TemplateList({ guildId, moduleId, form, search }: AreaProps): ReactElement {
  const go = useModuleNavigate(guildId, moduleId);
  const channels = useQuery(channelsQuery(guildId));

  const templates = form.value.templates;
  const tier = form.view.tier;
  const ceiling = listCeiling(tier, 'savedTemplates');
  const full = templates.length >= ceiling;

  const urlTerm = search.q ?? '';
  const [term, setTerm] = useState(urlTerm);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  useEffect(() => setTerm(urlTerm), [urlTerm]);

  useEffect(() => {
    const next = term.trim();
    if (next === urlTerm) return;

    const timer = window.setTimeout(() => {
      go({ q: next === '' ? undefined : next });
    }, 250);

    return () => window.clearTimeout(timer);
  }, [term, urlTerm, go]);

  const status = search.status ?? 'all';
  const needle = term.trim().toLowerCase();

  const shown = templates.filter((template) => {
    if (needle !== '' && !template.name.toLowerCase().includes(needle)) return false;
    if (status === 'scheduled') return template.schedule !== undefined;
    if (status === 'unscheduled') return template.schedule === undefined;
    return true;
  });

  const typed = name.trim();
  const taken = templates.map((template) => normaliseTemplateName(template.name));
  const nameError =
    typed !== '' && taken.includes(normaliseTemplateName(typed)) ? duplicateName(typed) : undefined;

  const create = (): void => {
    form.setValue((current) => ({
      ...current,
      templates: [...current.templates, emptyTemplate(typed)],
    }));

    setCreating(false);
    setName('');

    go({ area: 'templates', id: normaliseTemplateName(typed) });
  };

  return (
    <>
      <CollectionHeader
        title="Templates"
        used={templates.length}
        ceiling={ceiling}
        limitLabel={LIMIT_LABELS.savedTemplates}
        actions={
          <>
            {templates.length > 8 ? (
              <SearchField
                value={term}
                label="Search templates"
                placeholder="Search templates…"
                onChange={setTerm}
              />
            ) : null}

            <Select
              aria-label="Filter by schedule"
              width="sm"
              value={status}
              options={STATUS_OPTIONS}
              onChange={(next) => go({ status: next === 'all' ? undefined : next })}
            />

            <Button
              tone="primary"
              icon="plus"
              disabled={full}
              title={full ? ceilingNote(tier, 'savedTemplates') : undefined}
              onClick={() => setCreating(true)}
            >
              Create template
            </Button>
          </>
        }
      />

      {full ? <p className="text-sm text-muted">{ceilingNote(tier, 'savedTemplates')}</p> : null}

      {templates.length === 0 ? (
        <EmptyState icon="chat-centered-text" title="No templates" inset>
          {EMPTY_BODY}
        </EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState icon="magnifying-glass" title="No matching templates" inset>
          Search looks at template names only.
        </EmptyState>
      ) : (
        <Rows>
          {shown.map((template) => {
            const channel = (channels.data ?? []).find(
              (entry) => entry.id === template.schedule?.channelId,
            );

            return (
              <CollectionButtonRow
                key={normaliseTemplateName(template.name)}
                icon={template.schedule ? 'alarm' : 'chat-centered-text'}
                title={<span className="mono">{template.name}</span>}
                badge={
                  template.schedule && !template.schedule.enabled ? (
                    <Badge tone="neutral">Schedule off</Badge>
                  ) : startHasPassed(template.schedule) ? (
                    <Badge tone="warning">Start time passed</Badge>
                  ) : null
                }
                meta={
                  <>
                    {templateContents(template).map((part) => (
                      <Chip key={part}>{part}</Chip>
                    ))}
                    <MetaSeparator />
                    {template.schedule !== undefined &&
                    template.schedule.channelId !== '' &&
                    channels.isPending ? (
                      <Spinner label="Loading channels" />
                    ) : (
                      scheduleSummary(template.schedule, channel?.name)
                    )}
                  </>
                }
                onSelect={() => go({ area: 'templates', id: normaliseTemplateName(template.name) })}
              />
            );
          })}
        </Rows>
      )}

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="Create template"
        footer={
          <>
            <Button onClick={() => setCreating(false)}>Cancel</Button>
            <Button
              tone="primary"
              disabled={typed === '' || nameError !== undefined}
              onClick={create}
            >
              Create
            </Button>
          </>
        }
      >
        <Field label="Name" hint={NAME_HELP} error={nameError}>
          {(props) => (
            <TextInput
              {...props}
              className="mono"
              width="lg"
              maxLength={TEMPLATE_NAME_MAX}
              invalid={nameError !== undefined}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          )}
        </Field>
      </Dialog>
    </>
  );
}

function TemplateEditor({
  guildId,
  moduleId,
  form,
  index,
  template,
}: AreaProps & { template: SavedMessage }): ReactElement {
  const go = useModuleNavigate(guildId, moduleId);
  const channels = useQuery(channelsQuery(guildId));

  const [tab, setTab] = useState<'message' | 'delivery'>('message');
  const [palette, setPalette] = useState(false);
  const [renamed, setRenamed] = useState<string | null>(null);
  const [dropV2, setDropV2] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [switched, setSwitched] = useState(false);
  const recent = useRecent();

  const path = `templates.${index}`;
  const rows = template.components;

  const setTemplate = (next: SavedMessage): void => {
    form.setValue((current) => ({
      ...current,
      templates: current.templates.map((held, at) => (at === index ? next : held)),
    }));
  };

  const setRows = (next: ActionRow[]): void => setTemplate({ ...template, components: next });

  const keys = useMemo<KeyContext>(() => {
    const all = interactiveKeys(template);
    const counts = new Map<string, number>();
    for (const key of all) counts.set(key, (counts.get(key) ?? 0) + 1);

    return {
      counts,
      taken: new Set(all),
      subject: 'message',
      customId: (key: string) => {
        const length = encodedLength(template.name, key);

        return {
          length,
          problem:
            length > MAX_CUSTOM_ID_LENGTH
              ? `the name '${template.name}' and the component key '${key}' come to ${length} ` +
                'characters once Proton adds its own prefix, and Discord allows ' +
                `${MAX_CUSTOM_ID_LENGTH}. Shorten the message name or the key.`
              : undefined,
        };
      },
    };
  }, [template]);

  const clash = form.value.templates.some(
    (held, at) =>
      at !== index && normaliseTemplateName(held.name) === normaliseTemplateName(template.name),
  );

  const nameError = clash
    ? duplicateName(template.name)
    : template.name.trim() === ''
      ? 'Template needs a name.'
      : form.errorAt(`${path}.name`);

  const channel = (channels.data ?? []).find((entry) => entry.id === template.schedule?.channelId);

  // The saved name, so the rename warning appears on an actual rename rather than on every
  // template that has ever had a button.
  const savedName = (form.view.config.templates as { name?: string }[] | undefined)?.[index]?.name;
  const renaming = savedName !== undefined && savedName !== template.name;

  const insert = (row: ActionRow): void => {
    const fresh = withFreshKeys(row, keys.taken);
    const before = componentKeys(row);
    const after = componentKeys(fresh);

    const changes = before
      .map((key, at) => ({ from: key, to: after[at] ?? key }))
      .filter((change) => change.from !== change.to);

    recent.mark(rows.length);
    setRows([...rows, fresh]);
    setPalette(false);
    setRenamed(
      changes.length === 0
        ? null
        : `Renamed ${changes.length === 1 ? 'a key' : `${changes.length} keys`} in the inserted ` +
            `row because this template already uses ${changes.length === 1 ? 'it' : 'them'}: ` +
            `${changes.map((change) => `${change.from} → ${change.to}`).join(', ')}.`,
    );
  };

  const remove = (): void => {
    form.setValue((current) => ({
      ...current,
      templates: current.templates.filter((_, at) => at !== index),
    }));

    go({ area: 'templates', id: undefined });
  };

  const duplicate = (): void => {
    const name = uniqueName(
      `${template.name} copy`,
      form.value.templates.map((held) => held.name),
      TEMPLATE_NAME_MAX,
    );

    form.setValue((current) => ({
      ...current,
      templates: [...current.templates, { ...template, name }],
    }));

    go({ area: 'templates', id: normaliseTemplateName(name) });
  };

  const editor = (
    <>
      <div className="messages-toolbar">
        <SegmentedTabs
          label="Template sections"
          value={tab}
          onChange={(next) => {
            setSwitched(true);
            setTab(next);
          }}
          items={[
            { id: 'message', label: 'Message' },
            { id: 'delivery', label: 'Posting' },
          ]}
        />
        <span className="push-right">
          <MenuButton
            label="Template actions"
            actions={[
              {
                id: 'duplicate',
                label: 'Duplicate',
                icon: 'clipboard-text',
                onSelect: duplicate,
              },
              {
                id: 'delete',
                label: 'Delete',
                icon: 'trash',
                danger: true,
                onSelect: () => setRemoving(true),
              },
            ]}
          />
        </span>
      </div>

      <div key={tab} className={switched ? 'motion-fade' : undefined}>
        {tab === 'message' ? (
          <>
            <Section label="Template">
              <Rows>
                <SettingRow
                  title="Name"
                  description={NAME_HELP}
                  error={nameError}
                  note={renaming && keys.taken.size > 0 ? RENAME_WARNING : undefined}
                >
                  <TextInput
                    className="mono"
                    width="md"
                    aria-label="Template name"
                    maxLength={TEMPLATE_NAME_MAX}
                    invalid={nameError !== undefined}
                    value={template.name}
                    onChange={(event) =>
                      setTemplate({ ...template, name: event.currentTarget.value })
                    }
                  />
                </SettingRow>
              </Rows>
            </Section>

            {template.v2.length > 0 ? (
              <Section label="Layout">
                <StatusBanner tone="info" title="Layouts cannot be edited here">
                  {V2_TEMPLATE}
                </StatusBanner>

                {interactiveKeys({ components: [], v2: template.v2 }).length > 0 ? (
                  <StatusBanner tone="warning" title="Layout buttons do not work yet">
                    {V2_PRESS_UNROUTABLE}
                  </StatusBanner>
                ) : null}

                <div className="messages-layout-drop">
                  <Button tone="danger-quiet" icon="trash" onClick={() => setDropV2(true)}>
                    Replace with text and embeds
                  </Button>
                </div>
              </Section>
            ) : (
              <>
                {template.embeds.length > 1 ? (
                  <StatusBanner tone="info" title={`${template.embeds.length} embeds`}>
                    {EXTRA_EMBEDS}
                  </StatusBanner>
                ) : null}

                <MessageEditor
                  guildId={guildId}
                  value={templateMessage(template)}
                  pathPrefix={path}
                  errorAt={(at) => form.errorAt(at)}
                  allow={{ components: false }}
                  contentLabel="Message text"
                  contentDescription="Supports Discord markdown. Text in {braces} is posted as written, not replaced."
                  onChange={(next) =>
                    setTemplate({
                      ...template,
                      content: next.content,
                      embeds: next.embeds,
                      mentions: next.mentions,
                    })
                  }
                />

                {template.schedule?.pingRoleId !== undefined ? (
                  <StatusBanner tone="info">{PING_OVERRIDES_MENTIONS}</StatusBanner>
                ) : null}

                <Section
                  label="Buttons and dropdowns"
                  note={<LimitCounter used={rows.length} ceiling={ACTION_ROWS_MAX} label="rows" />}
                  actions={
                    <>
                      <Button
                        size="sm"
                        icon="plus"
                        disabled={rows.length >= ACTION_ROWS_MAX}
                        onClick={() => {
                          recent.mark(rows.length);
                          setRows([...rows, newButtonRow(keys.taken)]);
                        }}
                      >
                        Add button row
                      </Button>
                      <Button
                        size="sm"
                        icon="plus"
                        disabled={rows.length >= ACTION_ROWS_MAX}
                        onClick={() => {
                          recent.mark(rows.length);
                          setRows([...rows, newSelectRow(keys.taken)]);
                        }}
                      >
                        Add dropdown
                      </Button>
                      <Button
                        size="sm"
                        icon="squares-four"
                        disabled={rows.length >= ACTION_ROWS_MAX}
                        onClick={() => setPalette(true)}
                      >
                        Insert saved row
                      </Button>
                    </>
                  }
                >
                  {renamed !== null ? (
                    <StatusBanner tone="info" onDismiss={() => setRenamed(null)}>
                      {renamed}
                    </StatusBanner>
                  ) : null}

                  {rows.length === 0 ? (
                    <p className="section-intro">{NOTHING_YET}</p>
                  ) : (
                    <Rows>
                      {rows.map((row, rowIndex) => {
                        const rowError = form.errorAt(`${path}.components.${rowIndex}`);

                        return (
                          <ExpandableRow
                            // biome-ignore lint/suspicious/noArrayIndexKey: a row's position is its identity
                            key={rowIndex}
                            className={recent.enter(rowIndex, 'part')}
                            title={`Row ${rowIndex + 1}`}
                            description={rowError ?? describeRow(row)}
                            defaultOpen={rows.length === 1}
                            control={
                              rowError !== undefined ? (
                                <Badge tone="danger">Needs fixing</Badge>
                              ) : (
                                <Badge tone="neutral">
                                  {row.kind === 'select' ? 'Dropdown' : 'Buttons'}
                                </Badge>
                              )
                            }
                            detail={() => (
                              <RowEditor
                                guildId={guildId}
                                row={row}
                                keys={keys}
                                errorAt={(at) => form.errorAt(at)}
                                prefix={`${path}.components.${rowIndex}`}
                                onChange={(next) =>
                                  setRows(rows.map((held, at) => (at === rowIndex ? next : held)))
                                }
                                onRemove={() => setRows(rows.filter((_, at) => at !== rowIndex))}
                              />
                            )}
                          />
                        );
                      })}
                    </Rows>
                  )}

                  {keys.taken.size > 0 ? (
                    <p className="messages-keys text-xs text-muted">
                      Keys in use:{' '}
                      {[...keys.taken].map((key) => (
                        <span className="mono" key={key}>
                          {key}
                        </span>
                      ))}
                    </p>
                  ) : null}
                </Section>
              </>
            )}
          </>
        ) : (
          <DeliverySurface
            guildId={guildId}
            template={template}
            path={path}
            form={form}
            onChange={setTemplate}
          />
        )}
      </div>
    </>
  );

  return (
    <>
      <EditorPreviewLayout
        editor={editor}
        preview={
          <>
            <DiscordPreview
              message={previewOf(template)}
              channelName={channel?.name}
              empty="Nothing to preview. Add text, an embed, a button or a dropdown."
            />
            <p className="messages-preview-note text-xs text-muted">
              {mentionCaption(template.mentions)}
            </p>
          </>
        }
      />

      <Dialog
        open={palette}
        onClose={() => setPalette(false)}
        title="Insert saved row"
        description="The template gets its own copy of the row."
        size="wide"
      >
        {form.value.components.length === 0 ? (
          <EmptyState icon="squares-four" title="No saved rows" inset>
            {NO_PALETTE}
          </EmptyState>
        ) : (
          <Rows>
            {form.value.components.map((entry) => (
              <CollectionButtonRow
                key={entry.name}
                icon="squares-four"
                title={entry.name}
                meta={describeRow(entry.row)}
                onSelect={() => insert(entry.row)}
              />
            ))}
          </Rows>
        )}
      </Dialog>

      <ConfirmDialog
        open={dropV2}
        onClose={() => setDropV2(false)}
        onConfirm={() => {
          setTemplate({ ...template, v2: [], content: template.content ?? '' });
          setDropV2(false);
        }}
        title="Replace layout?"
        confirmLabel="Replace"
        danger
      >
        {V2_REPLACE}
      </ConfirmDialog>

      <ConfirmDialog
        open={removing}
        onClose={() => setRemoving(false)}
        onConfirm={remove}
        title={`Delete ${template.name}?`}
        confirmLabel="Delete"
        danger
      >
        Messages already posted from this template stay in Discord. Their buttons tell members who
        press them that the template no longer exists.
      </ConfirmDialog>
    </>
  );
}

function DeliverySurface({
  guildId,
  template,
  path,
  form,
  onChange,
}: {
  guildId: string;
  template: SavedMessage;
  path: string;
  form: ModuleForm<MessagesConfig>;
  onChange: (next: SavedMessage) => void;
}): ReactElement {
  const [clearing, setClearing] = useState(false);

  const schedule = template.schedule;
  const command = `/message post name:${template.name}`;

  const setSchedule = (next: TemplateSchedule): void => onChange({ ...template, schedule: next });

  return (
    <>
      <Section label="Command">
        <Rows>
          <SettingRow
            title="Post from Discord"
            description={`Use ${command} in Discord to post this template.`}
          >
            <Button
              icon="clipboard-text"
              onClick={() => void navigator.clipboard?.writeText(command)}
            >
              Copy command
            </Button>
          </SettingRow>
        </Rows>
      </Section>

      <Section label="Schedule" intro={SCHEDULE_HELP}>
        <Rows>
          <SettingRow title="Post on a schedule">
            <Switch
              label="Post on a schedule"
              checked={schedule !== undefined}
              onChange={(next) => {
                if (!next) {
                  setClearing(true);
                  return;
                }

                setSchedule({
                  channelId: '',
                  at: isoWithOffset(new Date(Date.now() + 3_600_000)),
                  mode: 'once',
                  enabled: true,
                });
              }}
            />
          </SettingRow>

          {schedule ? (
            <>
              <SettingRow title="Enabled" description={SCHEDULE_OFF_HELP}>
                <Switch
                  label="Schedule enabled"
                  checked={schedule.enabled}
                  onChange={(next) => setSchedule({ ...schedule, enabled: next })}
                />
              </SettingRow>

              <SettingRow
                title="Channel"
                description="Where Proton posts this template."
                error={form.errorAt(`${path}.schedule.channelId`)}
              >
                <ChannelPicker
                  guildId={guildId}
                  label="Channel"
                  types={POSTABLE_CHANNEL_TYPES}
                  allowNone={false}
                  invalid={form.errorAt(`${path}.schedule.channelId`) !== undefined}
                  value={schedule.channelId === '' ? null : schedule.channelId}
                  onChange={(next) => setSchedule({ ...schedule, channelId: next ?? '' })}
                />
              </SettingRow>

              <SettingRow
                title="Start time"
                description={AT_HELP}
                error={form.errorAt(`${path}.schedule.at`)}
                note={startHasPassed(schedule) ? PASSED : undefined}
                stacked
              >
                <span className="inline inline-8">
                  <TextInput
                    className="mono"
                    width="lg"
                    aria-label="Start time"
                    placeholder="2026-01-31T09:00:00Z"
                    invalid={form.errorAt(`${path}.schedule.at`) !== undefined}
                    value={schedule.at}
                    onChange={(event) =>
                      setSchedule({ ...schedule, at: event.currentTarget.value })
                    }
                  />
                  <Button
                    size="sm"
                    onClick={() =>
                      setSchedule({
                        ...schedule,
                        at: isoWithOffset(new Date(Date.now() + 3_600_000)),
                      })
                    }
                  >
                    An hour from now
                  </Button>
                </span>
              </SettingRow>

              <SettingRow title="Repeat">
                <SegmentedControl
                  label="Repeat"
                  value={schedule.mode}
                  options={SCHEDULE_MODES.map((mode) => ({
                    value: mode,
                    label: mode === 'once' ? 'Once' : 'Repeatedly',
                  }))}
                  onChange={(mode) =>
                    setSchedule(
                      mode === 'repeat'
                        ? { ...schedule, mode, every: schedule.every ?? '24h' }
                        : { ...schedule, mode, every: undefined },
                    )
                  }
                />
              </SettingRow>

              {schedule.mode === 'repeat' ? (
                <SettingRow
                  title="Interval"
                  description="How long Proton waits before posting it again."
                  error={form.errorAt(`${path}.schedule.every`)}
                >
                  <DurationInput
                    label="Interval"
                    min={MIN_REPEAT_MS}
                    invalid={form.errorAt(`${path}.schedule.every`) !== undefined}
                    value={schedule.every ?? ''}
                    onChange={(next) => setSchedule({ ...schedule, every: next })}
                  />
                </SettingRow>
              ) : null}

              <SettingRow
                title="Ping role"
                description={PING_OVERRIDES}
                error={form.errorAt(`${path}.schedule.pingRoleId`)}
              >
                <RolePicker
                  guildId={guildId}
                  label="Ping role"
                  requireAssignable={false}
                  noneLabel="No ping"
                  value={schedule.pingRoleId ?? null}
                  onChange={(next) => setSchedule({ ...schedule, pingRoleId: next ?? undefined })}
                />
              </SettingRow>
            </>
          ) : null}
        </Rows>

        {schedule?.pingRoleId !== undefined && template.v2.length > 0 ? (
          <StatusBanner tone="warning" title="Mention not added">
            {PING_IN_LAYOUT}
          </StatusBanner>
        ) : null}
      </Section>

      <ConfirmDialog
        open={clearing}
        onClose={() => setClearing(false)}
        onConfirm={() => {
          onChange({ ...template, schedule: undefined });
          setClearing(false);
        }}
        title="Remove schedule?"
        confirmLabel="Remove"
        danger
      >
        The channel, start time and interval are cleared. The template stays, and /message post
        still posts it.
      </ConfirmDialog>
    </>
  );
}
