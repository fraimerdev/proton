import {
  SCHEDULE_HELP,
  SCHEDULE_MODES,
  type TemplateSchedule,
  templateScheduleSchema,
} from '@proton/module-messages/config';
import { type ReactElement, useId } from 'react';
import {
  channelOptions,
  type DiscordChannel,
  type DiscordRole,
  roleOptions,
  SinglePicker,
} from '../form/picker.tsx';
import { Icon } from '../shell/icon.tsx';

export interface ScheduleEditorProps {
  schedule: TemplateSchedule | undefined;
  channels: readonly DiscordChannel[];
  roles: readonly DiscordRole[];
  onChange: (schedule: TemplateSchedule | undefined) => void;
}

// datetime-local speaks local wall-clock with no zone; the stored timestamp keeps its offset.
function toLocalInput(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';

  return new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function fromLocalInput(value: string): string {
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? value : at.toISOString();
}

function blank(): TemplateSchedule {
  const hour = 60 * 60 * 1000;

  return {
    channelId: '',
    at: new Date(Math.ceil(Date.now() / hour) * hour + hour).toISOString(),
    mode: 'once',
    enabled: true,
  };
}

export function ScheduleEditor({
  schedule,
  channels,
  roles,
  onChange,
}: ScheduleEditorProps): ReactElement {
  const id = useId();
  const channelControlId = `${id}-channel`;
  const pingControlId = `${id}-ping`;
  const parsed = schedule === undefined ? null : templateScheduleSchema.safeParse(schedule);
  const issues = parsed && !parsed.success ? parsed.error.issues : [];

  function set(patch: Partial<TemplateSchedule>): void {
    if (!schedule) return;
    onChange({ ...schedule, ...patch });
  }

  if (!schedule) {
    return (
      <fieldset className="builder-section">
        <legend>Schedule</legend>
        <p className="field-description">
          This template posts only when somebody runs <code>/message post</code>. Give it a schedule
          and Proton posts it for you. {SCHEDULE_HELP}
        </p>

        <button className="button button-quiet" onClick={() => onChange(blank())} type="button">
          <Icon name="alarm" />
          Post this on a schedule
        </button>
      </fieldset>
    );
  }

  return (
    <fieldset className="builder-section">
      <legend>Schedule</legend>
      <p className="field-description">{SCHEDULE_HELP}</p>

      <div className="filter">
        <span>
          <label htmlFor={channelControlId}>Channel</label>
        </span>
        <SinglePicker
          id={channelControlId}
          label="Channel"
          options={channelOptions(channels)}
          value={schedule.channelId === '' ? null : schedule.channelId}
          onChange={(next) => set({ channelId: next ?? '' })}
          emptyLabel="Choose a channel…"
          clearable={false}
          invalid={schedule.channelId === ''}
        />
        <small className="field-description">
          Channels Proton cannot view are not listed here, because Discord never returns them.
        </small>
      </div>

      <label className="filter">
        <span>First posts at</span>
        <input
          onChange={(e) => set({ at: fromLocalInput(e.target.value) })}
          type="datetime-local"
          value={toLocalInput(schedule.at)}
        />
        <small className="field-description">
          Read in this browser’s timezone and stored with its offset, so it means the same moment
          wherever it is read back.
        </small>
      </label>

      <label className="filter">
        <span>Then</span>
        <select
          onChange={(e) => set({ mode: e.target.value as TemplateSchedule['mode'] })}
          value={schedule.mode}
        >
          {SCHEDULE_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {mode === 'once' ? 'Never again' : 'Repeat on an interval'}
            </option>
          ))}
        </select>
      </label>

      {schedule.mode === 'repeat' ? (
        <label className="filter">
          <span>Every</span>
          <input
            onChange={(e) => set({ every: e.target.value || undefined })}
            placeholder="24h"
            type="text"
            value={schedule.every ?? ''}
          />
          <small className="field-description">
            A number and a unit, such as <code>24h</code> or <code>7d</code>.
          </small>
        </label>
      ) : null}

      <div className="filter">
        <span>
          <label htmlFor={pingControlId}>Ping a role</label>
        </span>
        <SinglePicker
          id={pingControlId}
          label="Ping a role"
          options={roleOptions(roles)}
          value={schedule.pingRoleId ?? null}
          onChange={(next) => set({ pingRoleId: next ?? undefined })}
          emptyLabel="Nobody"
          clearable
        />
        <small className="field-description">
          Written above the message, and the only mention it is allowed to make — Discord refuses a
          message that both names a role and asks for every mention to be parsed.
        </small>
      </div>

      <label className="field field-boolean">
        <input
          aria-checked={schedule.enabled}
          checked={schedule.enabled}
          onChange={(e) => set({ enabled: e.target.checked })}
          role="switch"
          type="checkbox"
        />
        <span className="field-label">Schedule is on</span>
        <small className="field-description">
          Switching it off takes the booking down straight away. The template stays, and{' '}
          <code>/message post</code> still posts it on request.
        </small>
      </label>

      <button className="button button-ghost" onClick={() => onChange(undefined)} type="button">
        <Icon name="trash" />
        Remove the schedule
      </button>

      {issues.length > 0 ? (
        <ul className="ladder-errors" role="alert">
          {issues.map((issue) => (
            <li key={`${issue.path.map(String).join('.')}-${issue.message}`}>{issue.message}</li>
          ))}
        </ul>
      ) : null}
    </fieldset>
  );
}
