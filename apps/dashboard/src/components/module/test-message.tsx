import type {
  SimulationDescriptor,
  SimulationInput,
  SimulationInputValue,
  SimulationOutcome,
} from '@proton/core';
import { simulationInputDefaults, unresolvedDiagnostics } from '@proton/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { saveFailure } from '../../lib/errors.ts';
import { memberSearchQuery } from '../../lib/queries.ts';
import { runSimulation } from '../../server/simulations.ts';
import { ChannelPicker } from '../discord/channel-picker.tsx';
import { Button, NumberStepper, SearchField, Select, Switch, TextInput } from '../ui/controls.tsx';
import { Spinner, StatusBanner } from '../ui/feedback.tsx';
import { Rows, SettingRow } from '../ui/layout.tsx';
import { Dialog } from '../ui/overlay.tsx';

export interface TestSubject {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

type Values = Record<string, SimulationInputValue>;

type Mode = 'preview' | 'send';

function newRequestId(): string {
  return `sim-${crypto.randomUUID().replaceAll('-', '')}`.slice(0, 40);
}

function InputControl({
  input,
  value,
  onChange,
}: {
  input: SimulationInput;
  value: SimulationInputValue | undefined;
  onChange: (next: SimulationInputValue) => void;
}): ReactElement {
  if (input.kind === 'integer') {
    return (
      <NumberStepper
        label={input.label}
        value={typeof value === 'number' ? value : input.fallback}
        min={input.min}
        max={input.max}
        onChange={(next) => onChange(next ?? input.fallback)}
      />
    );
  }

  if (input.kind === 'choice') {
    return (
      <Select
        options={input.options.map(({ value: id, label }) => ({ value: id, label }))}
        value={typeof value === 'string' ? value : input.fallback}
        onChange={onChange}
        aria-label={input.label}
        width="md"
      />
    );
  }

  if (input.kind === 'boolean') {
    return (
      <Switch
        label={input.label}
        checked={typeof value === 'boolean' ? value : input.fallback}
        onChange={onChange}
      />
    );
  }

  return (
    <TextInput
      value={typeof value === 'string' ? value : input.fallback}
      maxLength={input.maxLength}
      aria-label={input.label}
      width="lg"
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/**
 * Null means "whoever is running the test", which the backend fills in from the signed-in session
 * rather than from anything the browser sends — the dashboard's own session id is Better Auth's,
 * not Discord's, and the two are not interchangeable.
 */
function SubjectPicker({
  guildId,
  value,
  onChange,
}: {
  guildId: string;
  value: TestSubject | null;
  onChange: (next: TestSubject | null) => void;
}): ReactElement {
  const [query, setQuery] = useState('');
  const results = useQuery(memberSearchQuery(guildId, query.trim()));

  return (
    <div className="sim-subject">
      <div className="sim-subject-current">
        {value === null ? (
          <span className="user-name">You</span>
        ) : (
          <>
            {value.avatarUrl ? (
              <img className="user-avatar" src={value.avatarUrl} alt="" width={22} height={22} />
            ) : (
              <span className="user-avatar avatar-fallback" aria-hidden />
            )}
            <span className="user-name">{value.displayName}</span>
            <Button size="sm" tone="ghost" onClick={() => onChange(null)}>
              Use me instead
            </Button>
          </>
        )}
      </div>

      <SearchField
        value={query}
        onChange={setQuery}
        placeholder="Search for another member…"
        label="Example member"
      />

      {query.trim() === '' ? null : results.isPending ? (
        <Spinner label="Searching" showLabel />
      ) : (results.data ?? []).length === 0 ? (
        <p className="text-sm text-muted">Nobody in this server matches that.</p>
      ) : (
        <ul className="sim-subject-results">
          {(results.data ?? []).slice(0, 8).map((member) => (
            <li key={member.id}>
              <button
                type="button"
                className="sim-subject-result"
                onClick={() => {
                  onChange({
                    id: member.id,
                    displayName: member.displayName,
                    avatarUrl: member.avatarUrl,
                  });
                  setQuery('');
                }}
              >
                {member.avatarUrl ? (
                  <img
                    className="user-avatar"
                    src={member.avatarUrl}
                    alt=""
                    width={22}
                    height={22}
                  />
                ) : (
                  <span className="user-avatar avatar-fallback" aria-hidden />
                )}
                <span className="user-name">{member.displayName}</span>
                <span className="text-xs text-muted">{member.username}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Unresolved({ outcome }: { outcome: SimulationOutcome }): ReactElement | null {
  const empty = unresolvedDiagnostics(outcome.render?.diagnostics ?? []);
  if (empty.length === 0) return null;

  return (
    <div className="sim-unresolved">
      <p className="field-warning">
        {empty.length === 1
          ? 'One placeholder comes out empty for this example:'
          : `${empty.length} placeholders come out empty for this example:`}
      </p>
      <ul>
        {empty.slice(0, 6).map((diagnostic) => (
          <li key={`${diagnostic.path}:${diagnostic.code}:${diagnostic.message}`}>
            {diagnostic.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Sent({ outcome }: { outcome: SimulationOutcome }): ReactElement | null {
  if (outcome.sent === null) return null;

  const { url, markerOmitted } = outcome.sent;

  return (
    <StatusBanner tone="success" live="polite" icon="check-circle">
      Discord took it.{' '}
      {url === null ? (
        outcome.destination.kind === 'dm' ? (
          'Check your direct messages.'
        ) : (
          'Check the channel in Discord.'
        )
      ) : (
        <a href={url} target="_blank" rel="noreferrer">
          Open the message
        </a>
      )}
      {markerOmitted === null ? null : ` ${markerOmitted}`}
    </StatusBanner>
  );
}

export function TestMessageDialog({
  open,
  onClose,
  guildId,
  moduleId,
  descriptor,
  draft,
  dirty,
  fixed = {},
  configuredChannelId,
}: {
  open: boolean;
  onClose: () => void;
  guildId: string;
  moduleId: string;
  descriptor: SimulationDescriptor;
  draft: Record<string, unknown>;
  dirty: boolean;
  fixed?: Values | undefined;
  configuredChannelId?: string | null | undefined;
}): ReactElement | null {
  const [subject, setSubject] = useState<TestSubject | null>(null);
  const [values, setValues] = useState<Values>(() => ({
    ...simulationInputDefaults(descriptor.inputs),
    ...fixed,
  }));
  const [channelId, setChannelId] = useState<string | null>(configuredChannelId ?? null);
  const [outcome, setOutcome] = useState<SimulationOutcome | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('preview');

  const shown = descriptor.inputs.filter((input) => input.fixed !== true);

  const run = useMutation({
    mutationFn: (next: Mode) =>
      runSimulation({
        data: {
          guildId,
          moduleId,
          simulationId: descriptor.id,
          mode: next,
          requestId: newRequestId(),
          inputs: values,
          ...(descriptor.subject && subject !== null ? { subjectId: subject.id } : {}),
          ...(channelId === null ? {} : { channelId }),
          // Always the draft: a test of anything other than what is on screen is a test of the
          // wrong thing, and the backend validates it exactly as a save would.
          draft,
        },
      }),
    onSuccess: (result) => {
      setOutcome(result);
      setFailure(result.error?.message ?? null);
    },
    onError: (error: Error) => {
      setOutcome(null);
      setFailure(saveFailure(error, 'That test did not run'));
    },
  });

  // Rendered but not shown: this is the check that says whether the message can be posted at all,
  // so an admin reads "this cannot be sent" here rather than after putting it in a channel.
  const check = useCallback(() => {
    setMode('preview');
    run.mutate('preview');
  }, [run.mutate]);

  const send = useCallback(() => {
    setMode('send');
    run.mutate('send');
  }, [run.mutate]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the example data is the trigger
  useEffect(() => {
    if (!open) return;

    const timer = window.setTimeout(check, 200);
    return () => window.clearTimeout(timer);
  }, [open, values, subject?.id, channelId]);

  useEffect(() => {
    if (open) return;

    setOutcome(null);
    setFailure(null);
    run.reset();
  }, [open, run.reset]);

  const sending = run.isPending && mode === 'send';
  const checking = run.isPending && mode === 'preview';
  const sendable = descriptor.delivery !== 'none';
  const ready = outcome !== null && outcome.error === null;

  const destination: ReactNode =
    descriptor.delivery === 'dm' ? (
      <p className="text-sm text-muted">
        Sent to you in a direct message. A real one goes to the member it is about — a test never
        does.
      </p>
    ) : descriptor.delivery === 'none' ? (
      <p className="text-sm text-muted">
        This is a name Proton gives a channel, not a message it posts, so there is nothing to send.
      </p>
    ) : (
      <ChannelPicker
        guildId={guildId}
        label="Test channel"
        value={channelId}
        placeholder="Choose a channel"
        noneLabel="No channel"
        onChange={setChannelId}
      />
    );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Test ${descriptor.label.toLowerCase()}`}
      description={descriptor.summary}
      footerNote={
        dirty
          ? 'Uses the settings on this page, including your unsaved changes. Nothing is saved.'
          : 'Uses this server’s saved settings.'
      }
      footer={
        <>
          <Button tone="ghost" onClick={onClose}>
            Close
          </Button>
          {sendable ? (
            <Button
              tone="primary"
              icon="megaphone"
              busy={sending}
              disabled={
                !ready || checking || (descriptor.delivery === 'channel' && channelId === null)
              }
              onClick={send}
            >
              Send test message
            </Button>
          ) : null}
        </>
      }
    >
      <div className="sim-body stack stack-12">
        {descriptor.note === undefined ? null : (
          <StatusBanner tone="info" icon="info">
            {descriptor.note}
          </StatusBanner>
        )}

        <Rows>
          {descriptor.subject ? (
            <SettingRow
              title="Example member"
              description="Nothing happens to them — they are not notified, moved or changed."
              stacked
            >
              <SubjectPicker guildId={guildId} value={subject} onChange={setSubject} />
            </SettingRow>
          ) : null}

          {shown.map((input) => (
            <SettingRow key={input.key} title={input.label} description={input.help}>
              <InputControl
                input={input}
                value={values[input.key]}
                onChange={(next) => setValues((current) => ({ ...current, [input.key]: next }))}
              />
            </SettingRow>
          ))}

          <SettingRow title="Where it goes" stacked>
            {destination}
          </SettingRow>
        </Rows>

        {failure === null ? null : (
          <StatusBanner tone="danger" live="polite">
            {failure}
          </StatusBanner>
        )}

        {outcome === null ? null : (
          <>
            {mode === 'send' ? <Sent outcome={outcome} /> : null}
            <Unresolved outcome={outcome} />
            {descriptor.output === 'text' && outcome.render?.text ? (
              <p className="sim-name">
                <span className="text-muted">The channel would be called&nbsp;</span>
                <span className="mono">{outcome.render.text}</span>
              </p>
            ) : null}
          </>
        )}
      </div>
    </Dialog>
  );
}

/**
 * The whole control: a button and the dialog behind it. One element per message editor, so a page
 * adding a Test control never has to hold dialog state of its own.
 */
export function TestMessage({
  guildId,
  moduleId,
  simulations,
  simulationId,
  draft,
  dirty,
  fixed,
  configuredChannelId,
  refusal,
  label,
}: {
  guildId: string;
  moduleId: string;
  simulations: readonly SimulationDescriptor[];
  simulationId: string;
  draft: Record<string, unknown>;
  dirty: boolean;
  fixed?: Values | undefined;
  configuredChannelId?: string | null | undefined;
  refusal?: string | undefined;
  label?: string | undefined;
}): ReactElement | null {
  const [open, setOpen] = useState(false);
  const descriptor = simulations.find((candidate) => candidate.id === simulationId);

  // A module whose api has not been redeployed with this simulation yet simply shows no button,
  // rather than a button that answers 'unknown_simulation' when it is pressed.
  if (descriptor === undefined) return null;

  return (
    <>
      <TestMessageButton
        descriptor={descriptor}
        refusal={refusal}
        label={label}
        onOpen={() => setOpen(true)}
      />
      <TestMessageDialog
        open={open}
        onClose={() => setOpen(false)}
        guildId={guildId}
        moduleId={moduleId}
        descriptor={descriptor}
        draft={draft}
        dirty={dirty}
        fixed={fixed}
        configuredChannelId={configuredChannelId}
      />
    </>
  );
}

export function TestMessageButton({
  descriptor,
  refusal,
  onOpen,
  label = 'Test',
}: {
  descriptor: SimulationDescriptor;
  refusal?: string | undefined;
  onOpen: () => void;
  label?: string | undefined;
}): ReactElement {
  return (
    <Button
      size="sm"
      tone="secondary"
      icon="pulse"
      disabled={refusal !== undefined}
      title={refusal ?? `Test ${descriptor.label.toLowerCase()}`}
      onClick={onOpen}
    >
      {label}
    </Button>
  );
}
