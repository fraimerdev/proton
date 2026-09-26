import type { DmMessage, PunishDirection } from '@proton/module-moderation/config';
import { noticeSurface, type PunishmentNoticeFacts } from '@proton/module-moderation/placeholders';
import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';
import {
  EditorPreviewLayout,
  MessageEditor,
  placeholderSlot,
} from '../../components/discord/message-editor.tsx';
import { DiscordPreview } from '../../components/discord/message-preview.tsx';
import { TestMessage } from '../../components/module/test-message.tsx';
import { Button, Select, Switch } from '../../components/ui/controls.tsx';
import { StatusBanner } from '../../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { previewMessage } from '../../lib/placeholder-preview.ts';
import { type ModerationForm, type Problems, setPunish } from './punish-shape.ts';

type Switches = 'onPunish' | 'onUnpunish' | 'onPunishByOthers' | 'onUnpunishByOthers';

const PUNISHED = 'When punished';
const LIFTED = 'When lifted';

const MESSAGE_OPTIONS = [
  { value: 'ban', label: 'Banned', group: PUNISHED },
  { value: 'kick', label: 'Kicked', group: PUNISHED },
  { value: 'timeout', label: 'Timed out', group: PUNISHED },
  { value: 'warn', label: 'Warned', group: PUNISHED },
  { value: 'unban', label: 'Unbanned', group: LIFTED },
  { value: 'untimeout', label: 'Timeout ended', group: LIFTED },
  { value: 'unwarn', label: 'Warning removed', group: LIFTED },
] as const satisfies readonly { value: PunishDirection; label: string; group: string }[];

const SENT_BY: Readonly<Record<PunishDirection, readonly Switches[]>> = {
  ban: ['onPunish', 'onPunishByOthers'],
  kick: ['onPunish', 'onPunishByOthers'],
  timeout: ['onPunish', 'onPunishByOthers'],
  warn: ['onPunish'],
  unban: ['onUnpunish', 'onUnpunishByOthers'],
  untimeout: ['onUnpunish', 'onUnpunishByOthers'],
  unwarn: ['onUnpunish'],
};

const NOT_SENT: Readonly<Record<PunishDirection, string>> = {
  ban: 'Not sent while “When a member is punished” and “When someone else punishes” are off.',
  kick: 'Not sent while “When a member is punished” and “When someone else punishes” are off.',
  timeout: 'Not sent while “When a member is punished” and “When someone else punishes” are off.',
  warn: 'Not sent while “When a member is punished” is off.',
  unban: 'Not sent while “When a punishment is lifted” and “When someone else lifts” are off.',
  untimeout: 'Not sent while “When a punishment is lifted” and “When someone else lifts” are off.',
  unwarn: 'Not sent while “When a punishment is lifted” is off.',
};

const SAMPLE_FACTS: Readonly<Record<PunishDirection, Partial<PunishmentNoticeFacts>>> = {
  ban: { direction: 'ban', durationMs: null, expiresAt: null },
  kick: { direction: 'kick', durationMs: null, expiresAt: null },
  timeout: { direction: 'timeout' },
  warn: { direction: 'warn', durationMs: null, expiresAt: null },
  unban: { direction: 'unban' },
  untimeout: { direction: 'untimeout' },
  unwarn: { direction: 'unwarn' },
};

const CAPTIONS: Readonly<Record<PunishDirection, string>> = {
  ban: 'Sample: a permanent ban with the reason “Posting invite links”.',
  kick: 'Sample: a kick with the reason “Posting invite links”.',
  timeout: 'Sample: a one-hour timeout with the reason “Posting invite links”.',
  warn: 'Sample: a warning with the reason “Posting invite links”.',
  unban: 'Sample: a ban lifted with the reason “Appeal accepted”.',
  untimeout: 'Sample: a timeout removed with the reason “Appeal accepted”.',
  unwarn: 'Sample: a warning removed with the reason “Appeal accepted”.',
};

const AUDIT_LOG =
  'Proton needs View Audit Log in this server to see who acted. Without it, these messages ' +
  'aren’t sent.';

const ALL_OFF = 'No DMs are sent to members. The messages below are kept for when you turn one on.';

const CONTENT_DESCRIPTION = 'Supports Discord markdown and placeholders. Type { to add one.';

const PREVIEW_EMPTY = 'This message is empty, so nothing is sent.';

const PREVIEW_REFUSED =
  'With this sample filled in, the message couldn’t be sent, so the member would get nothing. ' +
  'The preview shows it as written.';

const LAYOUT_NOTE =
  'This message is a components layout, which this editor can’t change. Remove it to write text ' +
  'and an embed instead.';

function isPunished(direction: PunishDirection): boolean {
  return (
    direction === 'ban' || direction === 'kick' || direction === 'timeout' || direction === 'warn'
  );
}

function SwitchRow({
  form,
  problems,
  field,
  title,
  description,
  help,
  note,
}: {
  form: ModerationForm;
  problems: Problems;
  field: Switches;
  title: string;
  description: string;
  help?: string | undefined;
  note?: string | undefined;
}): ReactElement {
  const path = `punish.notifications.${field}`;
  const checked = form.value.punish.notifications[field];

  return (
    <SettingRow
      title={title}
      description={description}
      help={help}
      note={checked ? note : undefined}
      error={problems.at(path)}
    >
      <Switch label={title} checked={checked} onChange={(next) => form.set(path, next)} />
    </SettingRow>
  );
}

export function NotificationsArea({
  guildId,
  form,
  problems,
}: {
  guildId: string;
  form: ModerationForm;
  problems: Problems;
}): ReactElement {
  const [direction, setDirection] = useState<PunishDirection>('ban');

  const notifications = form.value.punish.notifications;
  const message = notifications.messages[direction];
  const surface = noticeSurface(direction);
  const prefix = `punish.notifications.messages.${direction}`;

  const setMessage = (next: DmMessage): void =>
    setPunish(form, (current) => ({
      ...current,
      notifications: {
        ...current.notifications,
        messages: { ...current.notifications.messages, [direction]: next },
      },
    }));

  const preview = useMemo(() => {
    const sample = surface.samples[0];
    return sample === undefined
      ? null
      : previewMessage(surface, message, sample, SAMPLE_FACTS[direction]);
  }, [surface, message, direction]);

  const allOff =
    !notifications.onPunish &&
    !notifications.onUnpunish &&
    !notifications.onPunishByOthers &&
    !notifications.onUnpunishByOthers;

  const sent = SENT_BY[direction].some((field) => notifications[field]);
  const hasLayout = message.v2.length > 0;
  const messageError =
    problems.at(prefix) ?? problems.at(`${prefix}.v2`) ?? problems.at(`${prefix}.components`);

  const editor = (
    <>
      {allOff ? (
        <div className="moderation-banners">
          <StatusBanner tone="neutral">{ALL_OFF}</StatusBanner>
        </div>
      ) : null}

      <Section label="When to send">
        <Rows>
          <SwitchRow
            form={form}
            problems={problems}
            field="onPunish"
            title="When a member is punished"
            description="Sent when a moderator bans, kicks, times out or warns them through Proton."
            help="For bans and kicks, it’s sent first, while the member can still receive it."
          />
          <SwitchRow
            form={form}
            problems={problems}
            field="onUnpunish"
            title="When a punishment is lifted"
            description="Sent when a ban, timeout or warning is removed through Proton, or when a timeout Proton applied ends."
          />
          <SwitchRow
            form={form}
            problems={problems}
            field="onPunishByOthers"
            title="When someone else punishes"
            description="Sent when a member is banned, kicked or timed out in Discord or by another bot."
            help="After a ban or kick the member has usually left, so it rarely arrives."
            note={AUDIT_LOG}
          />
          <SwitchRow
            form={form}
            problems={problems}
            field="onUnpunishByOthers"
            title="When someone else lifts"
            description="Sent when a ban or timeout is removed in Discord or by another bot."
            note={AUDIT_LOG}
          />
        </Rows>
      </Section>

      <Section
        label="Messages"
        intro="Each punishment, and each way one ends, has its own message."
      >
        <Rows>
          <SettingRow
            stacked
            title="Message"
            note={sent ? undefined : NOT_SENT[direction]}
            error={messageError}
          >
            <Select
              aria-label="Message to edit"
              width="md"
              value={direction}
              options={MESSAGE_OPTIONS}
              onChange={(value) => setDirection(value as PunishDirection)}
            />
          </SettingRow>
        </Rows>
      </Section>

      {hasLayout ? (
        <Section label="Layout" intro={LAYOUT_NOTE}>
          <Rows>
            <SettingRow title="Components layout">
              <Button
                tone="danger-quiet"
                size="sm"
                icon="trash"
                onClick={() => setMessage({ ...message, v2: [] })}
              >
                Remove layout
              </Button>
            </SettingRow>
          </Rows>
        </Section>
      ) : (
        <MessageEditor
          key={direction}
          guildId={guildId}
          value={message}
          allow={{ components: false, mentions: false }}
          placeholders={placeholderSlot(surface, form.templateDiagnosticsAt)}
          contentLabel="Message text"
          contentDescription={CONTENT_DESCRIPTION}
          errorAt={problems.at}
          pathPrefix={prefix}
          onChange={(next) => setMessage({ ...message, ...next })}
        />
      )}
    </>
  );

  return (
    <EditorPreviewLayout
      editor={editor}
      previewTitle="What the member receives"
      previewActions={
        <TestMessage
          key={direction}
          guildId={guildId}
          moduleId="moderation"
          simulations={form.view.simulations}
          simulationId={isPunished(direction) ? 'moderation.punished' : 'moderation.unpunished'}
          draft={form.value as unknown as Record<string, unknown>}
          dirty={form.dirty}
          fixed={{ kind: direction }}
          configuredChannelId={null}
        />
      }
      preview={
        <div className="stack stack-10">
          <DiscordPreview
            message={preview?.message ?? message}
            mentionNames={preview?.mentionNames}
            now={preview?.now}
            empty={PREVIEW_EMPTY}
          />
          <p className="text-xs text-muted">{CAPTIONS[direction]}</p>
          {preview?.problem !== undefined ? (
            <p className="text-xs text-danger">{PREVIEW_REFUSED}</p>
          ) : null}
        </div>
      }
    />
  );
}
