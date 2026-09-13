import {
  ESCALATION_ACTIONS,
  type EscalationAction,
  type EscalationRung,
  type ModerationConfig,
} from '@proton/module-moderation/config';
import type { ReactElement } from 'react';
import { DurationInput } from '../../components/discord/inputs.tsx';
import type { ModuleForm } from '../../components/module/form.ts';
import { CollectionHeader } from '../../components/ui/collection.tsx';
import { Button, cx, IconButton, NumberStepper, Select } from '../../components/ui/controls.tsx';
import { EmptyState } from '../../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';

const LADDER_MAX = 20;
const AT_WARNINGS_MIN = 2;
const AT_WARNINGS_MAX = 100;
const FIRST_RUNG = 3;
const NEW_RUNG_DURATION = '1h';

// escalationLadderSchema's two refines, verbatim: the same words the save would come back with.
const OUT_OF_ORDER =
  'rungs must be ordered by atWarnings, strictly increasing — two rungs at the same warning ' +
  'count would both fire on it.';

const NEEDS_DURATION =
  "a 'timeout' rung needs a duration, e.g. 1h — Discord timeouts are an expiry, not a flag.";

const LADDER_INTRO =
  'A step runs when a member reaches its warning count within the escalation window. Steps are ' +
  'ordered by warning count, so change the count to move a step.';

const NO_RUNGS = 'Warnings are still recorded, but nothing happens until a step is added.';

const ACTION_LABELS: Record<EscalationAction, string> = {
  timeout: 'Timeout',
  kick: 'Kick',
  ban: 'Ban',
};

const ACTION_OPTIONS = ESCALATION_ACTIONS.map((action) => ({
  value: action,
  label: ACTION_LABELS[action],
}));

function rungProblem(ladder: readonly EscalationRung[], index: number): string | undefined {
  const rung = ladder[index];
  if (rung === undefined) return undefined;

  const previous = index === 0 ? undefined : ladder[index - 1];
  if (previous !== undefined && rung.atWarnings <= previous.atWarnings) return OUT_OF_ORDER;
  if (rung.action === 'timeout' && rung.duration === undefined) return NEEDS_DURATION;

  return undefined;
}

function unsorted(ladder: readonly EscalationRung[]): boolean {
  return ladder.some(
    (rung, index) => index > 0 && rung.atWarnings < (ladder[index - 1]?.atWarnings ?? 0),
  );
}

export function EscalationArea({ form }: { form: ModuleForm<ModerationConfig> }): ReactElement {
  const config = form.value;
  const ladder = config.escalationLadder;

  const setLadder = (next: readonly EscalationRung[]): void => {
    form.setValue((current) => ({ ...current, escalationLadder: [...next] }));
  };

  const patchRung = (index: number, next: EscalationRung): void => {
    setLadder(ladder.map((rung, at) => (at === index ? next : rung)));
  };

  const addRung = (): void => {
    const last = ladder[ladder.length - 1];

    setLadder([
      ...ladder,
      {
        atWarnings:
          last === undefined ? FIRST_RUNG : Math.min(AT_WARNINGS_MAX, last.atWarnings + 1),
        action: 'timeout',
        duration: NEW_RUNG_DURATION,
      },
    ]);
  };

  const windowError = form.errorAt('escalationWindow');

  return (
    <>
      <Section label="Warnings" intro={LADDER_INTRO}>
        <Rows>
          <SettingRow
            title="Escalation window"
            description="How far back Proton counts a member’s warnings."
            error={windowError}
          >
            <DurationInput
              label="Escalation window"
              value={config.escalationWindow}
              invalid={windowError !== undefined}
              onChange={(next) =>
                form.setValue((current) => ({ ...current, escalationWindow: next }))
              }
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section>
        <CollectionHeader
          title="Steps"
          used={ladder.length}
          ceiling={LADDER_MAX}
          limitLabel="steps"
          actions={
            <>
              {unsorted(ladder) ? (
                <Button
                  size="sm"
                  onClick={() => setLadder([...ladder].sort((a, b) => a.atWarnings - b.atWarnings))}
                >
                  Sort by warnings
                </Button>
              ) : null}
              {ladder.length > 0 && ladder.length < LADDER_MAX ? (
                <Button size="sm" icon="plus" onClick={addRung}>
                  Add step
                </Button>
              ) : null}
            </>
          }
        />

        {ladder.length === 0 ? (
          <EmptyState
            inset
            icon="gavel"
            title="No escalation steps"
            actions={
              <Button tone="primary" size="sm" icon="plus" onClick={addRung}>
                Add step
              </Button>
            }
          >
            {NO_RUNGS}
          </EmptyState>
        ) : (
          <div className="ladder">
            {ladder.map((rung, index) => (
              <Rung
                // biome-ignore lint/suspicious/noArrayIndexKey: rungs carry no id of their own
                key={index}
                rung={rung}
                index={index}
                escalationWindow={config.escalationWindow}
                error={
                  form.errorAt(`escalationLadder.${index}.atWarnings`) ??
                  form.errorAt(`escalationLadder.${index}.duration`) ??
                  rungProblem(ladder, index)
                }
                onChange={(next) => patchRung(index, next)}
                onRemove={() => setLadder(ladder.filter((_, at) => at !== index))}
              />
            ))}
          </div>
        )}
      </Section>
    </>
  );
}

function Rung({
  rung,
  index,
  escalationWindow,
  error,
  onChange,
  onRemove,
}: {
  rung: EscalationRung;
  index: number;
  escalationWindow: string;
  error: string | undefined;
  onChange: (rung: EscalationRung) => void;
  onRemove: () => void;
}): ReactElement {
  const position = index + 1;

  const changeAction = (action: EscalationAction): void => {
    // Dropped, not kept: a duration left on a kick would reappear when the action goes back to timeout.
    if (action !== 'timeout') {
      onChange({ atWarnings: rung.atWarnings, action });
      return;
    }

    onChange({ ...rung, action, duration: rung.duration ?? NEW_RUNG_DURATION });
  };

  return (
    <div className="moderation-rung">
      <div className={cx('rung', error !== undefined && 'invalid')}>
        <span className="rung-index">{position}</span>

        <div className="rung-body">
          <span className="rung-connector">At</span>
          <NumberStepper
            label={`Step ${position} warning count`}
            value={rung.atWarnings}
            min={AT_WARNINGS_MIN}
            max={AT_WARNINGS_MAX}
            unit="warnings"
            width={172}
            invalid={error === OUT_OF_ORDER}
            onChange={(next) => onChange({ ...rung, atWarnings: next ?? rung.atWarnings })}
          />

          <span className="rung-connector">→</span>
          <Select
            aria-label={`Step ${position} action`}
            width="sm"
            value={rung.action}
            options={ACTION_OPTIONS}
            onChange={(value) => changeAction(value as EscalationAction)}
          />

          {rung.action === 'timeout' ? (
            <>
              <span className="rung-connector">for</span>
              <DurationInput
                label={`Step ${position} timeout duration`}
                value={rung.duration ?? ''}
                invalid={error === NEEDS_DURATION}
                onChange={(next) => onChange({ ...rung, duration: next })}
              />
            </>
          ) : null}
        </div>

        <div className="rung-aside">
          <IconButton
            icon="trash"
            tone="ghost"
            size="sm"
            label={`Remove step ${position}`}
            onClick={onRemove}
          />
        </div>
      </div>

      {error !== undefined ? (
        <p className="rung-error" role="alert">
          {error}
        </p>
      ) : null}

      <p className="moderation-rung-reason">
        Case reason:{' '}
        <span>
          Warning {rung.atWarnings} within {escalationWindow} — automatic escalation
        </span>
      </p>
    </div>
  );
}
