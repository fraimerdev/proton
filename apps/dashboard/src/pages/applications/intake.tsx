import type { FormConfig, IntakeConfig } from '@proton/module-applications/config';
import { intakeSentence } from '@proton/module-applications/intake';
import type { ReactElement } from 'react';
import { Button, NumberStepper, Switch, TextInput } from '../../components/ui/controls.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { useHydrated } from '../../components/ui/overlay.tsx';
import {
  type ApplicationsForm,
  type FormEntry,
  fromLocalInput,
  issueMap,
  toLocalInput,
  updateFormAt,
  withOptional,
} from './shape.ts';

export const CLOSED_DRAFTS =
  'Drafts already started are kept, but can’t be sent until you open the form again.';

const REVIEW_CONTINUES = 'Staff keep reviewing what was already sent.';

const COOLDOWN =
  'Counted from their last application, decision or withdrawal on this form, even while another ' +
  'is still open. 0 lets them apply again straight away.';

const ARCHIVED =
  'Archived forms take no applications and panels list them as closed. Everything already sent ' +
  'stays readable and exportable.';

function DateField({
  label,
  value,
  onChange,
  invalid,
}: {
  label: string;
  value: number | undefined;
  onChange: (next: number | undefined) => void;
  invalid: boolean;
}): ReactElement {
  const hydrated = useHydrated();

  return (
    <span className="inline inline-6">
      <TextInput
        type="datetime-local"
        width="md"
        aria-label={label}
        invalid={invalid}
        disabled={!hydrated}
        value={hydrated ? toLocalInput(value) : ''}
        onChange={(event) => onChange(fromLocalInput(event.currentTarget.value))}
      />
      {value !== undefined ? (
        <Button size="sm" tone="ghost" onClick={() => onChange(undefined)}>
          Clear
        </Button>
      ) : null}
    </span>
  );
}

export function IntakeTab({
  form,
  index,
  current,
  entry,
}: {
  form: ApplicationsForm;
  index: number;
  current: FormConfig;
  entry: FormEntry | undefined;
}): ReactElement {
  const intake = current.intake;
  const path = `forms.${index}.intake`;
  const issues = issueMap(current);
  const closesError = issues.get('intake.closesAt') ?? form.errorAt(`${path}.closesAt`);

  const set = (change: (value: IntakeConfig) => IntakeConfig): void =>
    updateFormAt(form, index, (value) => ({ ...value, intake: change(value.intake) }));

  const hydrated = useHydrated();
  const now = entry === undefined || !hydrated ? null : intakeSentence(entry.intake, current);

  return (
    <>
      <Section
        label="Intake"
        help="Closing a form is different from turning Applications off. A closed form keeps its panel button and review goes on; with Applications off, nobody can apply to any form and staff can’t make decisions."
      >
        {now !== null ? (
          <p className="applications-now">
            <span className="text-muted">What members see now: </span>
            {now}
          </p>
        ) : null}

        <Rows>
          <SettingRow
            title="Accepting applications"
            description="Turn off to close the form without archiving it."
            note={intake.open ? undefined : `${CLOSED_DRAFTS} ${REVIEW_CONTINUES}`}
          >
            <Switch
              label="Accepting applications"
              checked={intake.open}
              onChange={(open) => set((value) => ({ ...value, open }))}
            />
          </SettingRow>

          <SettingRow
            title="Opens"
            description="In your local time. Empty opens it as soon as it’s accepting applications."
            error={form.errorAt(`${path}.opensAt`)}
          >
            <DateField
              label="Opens"
              value={intake.opensAt}
              invalid={form.errorAt(`${path}.opensAt`) !== undefined}
              onChange={(next) => set((value) => withOptional(value, 'opensAt', next))}
            />
          </SettingRow>

          <SettingRow
            title="Closes"
            description="In your local time. Empty keeps it open until you turn it off."
            error={closesError}
            note={intake.closesAt === undefined ? undefined : CLOSED_DRAFTS}
          >
            <DateField
              label="Closes"
              value={intake.closesAt}
              invalid={closesError !== undefined}
              onChange={(next) => set((value) => withOptional(value, 'closesAt', next))}
            />
          </SettingRow>

          <SettingRow
            title="Submission limit"
            description="Close the form after this many applications. Withdrawn ones don’t count. Empty for no limit."
            error={form.errorAt(`${path}.cap`)}
          >
            <NumberStepper
              label="Submission limit"
              width={148}
              min={1}
              max={100_000}
              value={intake.cap ?? null}
              onChange={(next) =>
                set((value) =>
                  withOptional(value, 'cap', next === null || next < 1 ? undefined : next),
                )
              }
            />
          </SettingRow>

          <SettingRow
            title="Reapply after"
            description="How long a member waits before applying to this form again."
            help={COOLDOWN}
            error={form.errorAt(`${path}.cooldownDays`)}
          >
            <NumberStepper
              label="Reapply after"
              unit="days"
              width={148}
              min={0}
              max={365}
              value={intake.cooldownDays}
              onChange={(next) => set((value) => ({ ...value, cooldownDays: next ?? 0 }))}
            />
          </SettingRow>

          <SettingRow
            title="Open applications per member"
            description="How many of their applications on this form can wait for a decision at once."
            error={form.errorAt(`${path}.maxActive`)}
          >
            <NumberStepper
              label="Open applications per member"
              width={128}
              min={1}
              max={5}
              value={intake.maxActive}
              onChange={(next) => set((value) => ({ ...value, maxActive: next ?? 1 }))}
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section label="Archive">
        <Rows>
          <SettingRow title="Archived" description={ARCHIVED}>
            <Switch
              label="Archived"
              checked={current.archived}
              onChange={(archived) =>
                updateFormAt(form, index, (value) => ({ ...value, archived }))
              }
            />
          </SettingRow>
        </Rows>
      </Section>
    </>
  );
}
