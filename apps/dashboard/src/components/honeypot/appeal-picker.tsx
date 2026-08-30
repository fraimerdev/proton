import { appealPanelsSchema } from '@proton/module-appeals/config';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ReactElement, useId } from 'react';
import { moduleConfigQuery, modulesQuery } from '../../lib/queries.ts';
import { type PickerOption, SinglePicker } from '../form/picker.tsx';

export interface AppealPickerProps {
  guildId: string;
  value: string | undefined;
  onChange: (next: string | undefined) => void;
}

export function AppealPicker({ guildId, value, onChange }: AppealPickerProps): ReactElement {
  const id = useId();

  const { modules } = useSuspenseQuery(modulesQuery(guildId)).data;
  const summary = modules.find((candidate) => candidate.id === 'appeals');

  if (!summary) {
    return (
      <div className="field">
        <span className="field-head">Ban appeal</span>
        <p className="status">
          This deployment of Proton has no Appeals module, so there is no form to point at.
        </p>
      </div>
    );
  }

  return (
    <Picker guildId={guildId} enabled={summary.enabled} id={id} value={value} onChange={onChange} />
  );
}

function Picker({
  guildId,
  enabled,
  id,
  value,
  onChange,
}: {
  guildId: string;
  enabled: boolean;
  id: string;
  value: string | undefined;
  onChange: (next: string | undefined) => void;
}): ReactElement {
  const settings = useSuspenseQuery(moduleConfigQuery(guildId, 'appeals')).data;

  const parsed = appealPanelsSchema.safeParse(
    (settings.config as Record<string, unknown>).panels ?? [],
  );

  const panels = parsed.success ? parsed.data.filter((panel) => panel.enabled) : [];

  const options: PickerOption[] = panels.map((panel) => ({ id: panel.id, label: panel.name }));

  // A form deleted in Appeals must not silently vanish from here: the stored id is kept, shown as
  // missing, and marked invalid so the next save is a decision rather than an accident.
  const dangling = value !== undefined && !panels.some((panel) => panel.id === value);
  if (dangling) options.push({ id: value, label: `Missing form (${value})` });

  return (
    <div className="field">
      <span className="field-head">
        <label htmlFor={id}>Ban appeal</label>
      </span>

      <span className="field-control">
        <SinglePicker
          id={id}
          label="Ban appeal"
          options={options}
          value={value ?? null}
          onChange={(next) => onChange(next ?? undefined)}
          emptyLabel="No appeal offered"
          clearable
          invalid={dangling}
        />

        {dangling ? (
          <span className="field-error" role="alert">
            The form this points at no longer exists in Appeals. Pick another, or clear it — a ban
            would otherwise offer a link that goes nowhere.
          </span>
        ) : null}

        {!enabled ? (
          <span className="status">
            Appeals is switched off in this server, so nothing is sent even with a form picked.{' '}
            <Link to="/dashboard/$guildId/appeals" params={{ guildId }}>
              Turn it on
            </Link>
            .
          </span>
        ) : null}

        {enabled && panels.length === 0 ? (
          <span className="status">
            This server has no appeal forms yet.{' '}
            <Link to="/dashboard/$guildId/appeals" params={{ guildId }}>
              Add one
            </Link>
            .
          </span>
        ) : null}
      </span>
    </div>
  );
}
