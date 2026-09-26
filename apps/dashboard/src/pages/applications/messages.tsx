import type {
  ApplicantMessage,
  ApplicantMessageKey,
  FormConfig,
} from '@proton/module-applications/config';
import {
  APPLICANT_SURFACES,
  type ApplicantMessageFacts,
  CLOSED_SURFACE,
} from '@proton/module-applications/placeholders';
import { STATUS_LABELS } from '@proton/module-applications/web';
import type { ReactElement } from 'react';
import { useId, useMemo, useState } from 'react';
import {
  EditorPreviewLayout,
  MessageEditor,
  placeholderSlot,
} from '../../components/discord/message-editor.tsx';
import { DiscordPreview } from '../../components/discord/message-preview.tsx';
import { TestMessage } from '../../components/module/test-message.tsx';
import { PlaceholderSuggestions } from '../../components/placeholders/placeholder-suggestions.tsx';
import {
  TemplateDiagnostics,
  visibleDiagnostics,
} from '../../components/placeholders/template-diagnostics.tsx';
import { usePlaceholderAutocomplete } from '../../components/placeholders/use-placeholder-autocomplete.ts';
import { Select, Switch, TextArea } from '../../components/ui/controls.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { previewMessage } from '../../lib/placeholder-preview.ts';
import { type ApplicationsForm, updateFormAt } from './shape.ts';

const CLOSED_MAX = 1000;

interface MessageCopy {
  key: ApplicantMessageKey;
  label: string;
  when: string;
  simulation: string;
  status?: 'accepted' | 'rejected' | 'waitlisted';
}

const RECEIPT: MessageCopy = {
  key: 'receipt',
  label: 'Application sent',
  when: 'Sent once they send their application.',
  simulation: 'applications.receipt',
};

const MESSAGES: readonly MessageCopy[] = [
  RECEIPT,
  {
    key: 'accepted',
    label: 'Accepted',
    when: 'Sent when staff accept the application.',
    simulation: 'applications.decision',
    status: 'accepted',
  },
  {
    key: 'rejected',
    label: 'Rejected',
    when: 'Sent when staff reject the application.',
    simulation: 'applications.decision',
    status: 'rejected',
  },
  {
    key: 'waitlisted',
    label: 'Waitlisted',
    when: 'Sent when staff put the application on the waitlist.',
    simulation: 'applications.decision',
    status: 'waitlisted',
  },
  {
    key: 'infoRequest',
    label: 'Information request',
    when: 'Sent when staff ask the applicant a question.',
    simulation: 'applications.info_request',
  },
  {
    key: 'withdrawn',
    label: 'Withdrawn',
    when: 'Sent when the applicant withdraws.',
    simulation: 'applications.withdrawn',
  },
];

const CONTENT_DESCRIPTION = 'Supports Discord markdown and placeholders. Type { to add one.';

const PREVIEW_EMPTY = 'This message is empty, so nothing is sent.';

const PREVIEW_REFUSED =
  'With this sample filled in, the message couldn’t be sent, so the applicant would get nothing. ' +
  'The preview shows it as written.';

const DMS_OFF = 'DMs are off for this form, so none of these messages are sent.';

function ClosedMessageField({
  form,
  index,
  current,
}: {
  form: ApplicationsForm;
  index: number;
  current: FormConfig;
}): ReactElement {
  const id = useId();
  const path = `forms.${index}.messages.closed`;
  const value = current.messages.closed;

  const change = (next: string): void =>
    updateFormAt(form, index, (value) => ({
      ...value,
      messages: { ...value.messages, closed: next },
    }));

  const diagnostics = form.templateDiagnosticsAt(path);
  const autocomplete = usePlaceholderAutocomplete({
    surface: CLOSED_SURFACE,
    path,
    onChange: change,
  });
  const error = form.errorAt(path);
  const explained = error !== undefined && diagnostics.some(({ message }) => message === error);
  const listed = visibleDiagnostics(diagnostics, autocomplete.pending).shown.length > 0;

  return (
    <SettingRow
      stacked
      title="Closed message"
      description="Shown on panels and the web page while the form isn’t taking applications."
      error={explained ? undefined : error}
    >
      <div className="stack stack-4">
        <TextArea
          {...autocomplete.field}
          rows={2}
          aria-label="Closed message"
          aria-describedby={listed ? id : undefined}
          maxLength={CLOSED_MAX}
          invalid={error !== undefined}
          value={value}
          onChange={(event) => change(event.currentTarget.value)}
        />
        <PlaceholderSuggestions autocomplete={autocomplete} />
        {listed ? (
          <TemplateDiagnostics id={id} diagnostics={diagnostics} autocomplete={autocomplete} />
        ) : null}
        <span className="field-hint applications-counter">
          {value.length} / {CLOSED_MAX}
        </span>
      </div>
    </SettingRow>
  );
}

export function MessagesTab({
  form,
  guildId,
  index,
  current,
}: {
  form: ApplicationsForm;
  guildId: string;
  index: number;
  current: FormConfig;
}): ReactElement {
  const [key, setKey] = useState<ApplicantMessageKey>('receipt');
  const copy = MESSAGES.find((entry) => entry.key === key) ?? RECEIPT;

  const surface = APPLICANT_SURFACES[key];
  const message = current.messages[key];
  const prefix = `forms.${index}.messages.${key}`;

  const setMessage = (next: ApplicantMessage): void =>
    updateFormAt(form, index, (value) => ({
      ...value,
      messages: { ...value.messages, [key]: next },
    }));

  const preview = useMemo(() => {
    const sample = surface.samples[0];
    if (sample === undefined) return null;

    const overrides: Partial<ApplicantMessageFacts> = {
      application: {
        ...sample.facts.application,
        formName: current.name,
        ...(copy.status === undefined ? {} : { statusLabel: STATUS_LABELS[copy.status] }),
      },
    };
    return previewMessage(surface, message, sample, overrides);
  }, [surface, message, current.name, copy.status]);

  const messageError =
    form.errorAt(prefix) ?? form.errorAt(`${prefix}.v2`) ?? form.errorAt(`${prefix}.components`);

  const editor = (
    <>
      <Section label="Delivery">
        <Rows>
          <SettingRow
            title="DM the applicant"
            description="Closed DMs never stop an application. Staff see when a DM wasn’t delivered and can send it again."
          >
            <Switch
              label="DM the applicant"
              checked={current.notify.dm}
              onChange={(dm) =>
                updateFormAt(form, index, (value) => ({
                  ...value,
                  notify: { ...value.notify, dm },
                }))
              }
            />
          </SettingRow>
          <ClosedMessageField form={form} index={index} current={current} />
        </Rows>
      </Section>

      <Section label="Messages" intro="Each step of an application has its own DM.">
        <Rows>
          <SettingRow
            stacked
            title="Message"
            description={copy.when}
            note={current.notify.dm ? undefined : DMS_OFF}
            error={messageError}
          >
            <Select
              aria-label="Message to edit"
              width="md"
              value={key}
              options={MESSAGES.map((entry) => ({ value: entry.key, label: entry.label }))}
              onChange={(next) => {
                const found = MESSAGES.find((entry) => entry.key === next);
                if (found !== undefined) setKey(found.key);
              }}
            />
          </SettingRow>
        </Rows>
      </Section>

      <MessageEditor
        key={key}
        guildId={guildId}
        value={message}
        allow={{ components: false, mentions: false }}
        placeholders={placeholderSlot(surface, form.templateDiagnosticsAt)}
        contentLabel="Message text"
        contentDescription={CONTENT_DESCRIPTION}
        errorAt={form.errorAt}
        pathPrefix={prefix}
        onChange={(next) => setMessage({ ...message, ...next })}
      />
    </>
  );

  return (
    <EditorPreviewLayout
      editor={editor}
      previewTitle="What the applicant receives"
      previewActions={
        <TestMessage
          key={key}
          guildId={guildId}
          moduleId="applications"
          simulations={form.view.simulations}
          simulationId={copy.simulation}
          draft={form.value as unknown as Record<string, unknown>}
          dirty={form.dirty}
          fixed={{
            formIndex: index,
            ...(copy.status === undefined ? {} : { decision: copy.status }),
          }}
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
          {preview !== null ? <p className="text-xs text-muted">{preview.caption}</p> : null}
          {preview?.problem !== undefined ? (
            <p className="text-xs text-danger">{PREVIEW_REFUSED}</p>
          ) : null}
        </div>
      }
    />
  );
}
