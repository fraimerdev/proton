import {
  SCHEDULE_HELP,
  SCHEDULE_MODES,
  type TemplateSchedule,
  templateScheduleSchema,
} from '@proton/module-messages/config';
import { type ReactElement, useId } from 'react';
import {
  CHANNEL_NOTE,
  channelOptions,
  type DiscordChannel,
  type DiscordRole,
  POSTABLE_CHANNEL_TYPES,
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
  const atControlId = `${id}-at`;
  const everyControlId = `${id}-every`;
  const enabledControlId = `${id}-enabled`;
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
          options={channelOptions(channels, POSTABLE_CHANNEL_TYPES)}
          value={schedule.channelId === '' ? null : schedule.channelId}
          onChange={(next) => set({ channelId: next ?? '' })}
          emptyLabel="Choose a channel…"
          clearable={false}
          invalid={schedule.channelId === ''}
        />
        <small className="field-description">{CHANNEL_NOTE}</small>
      </div>

      {/* A <label> around both the control and its sentence reads the sentence out as part of the
          control's name. The Channel and Ping rows below already name theirs with htmlFor. */}
      <div className="filter">
        <span>
          <label htmlFor={atControlId}>First posts at</label>
        </span>
        <input
          id={atControlId}
          onChange={(e) => set({ at: fromLocalInput(e.target.value) })}
          type="datetime-local"
          value={toLocalInput(schedule.at)}
        />
        <small className="field-description">
          Read in this browser’s timezone and stored with its offset, so it means the same moment
          wherever it is read back.
        </small>
      </div>

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
        <div className="filter">
          <span>
            <label htmlFor={everyControlId}>Every</label>
          </span>
          <input
            id={everyControlId}
            onChange={(e) => set({ every: e.target.value || undefined })}
            placeholder="24h"
            type="text"
            value={schedule.every ?? ''}
          />
          <small className="field-description">
            A number and a unit, such as <code>24h</code> or <code>7d</code>.
          </small>
        </div>
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
          Written above the message, and the only mention it is allowed to make.
        </small>
      </div>

      {/* Head first, then the control: `.field` is a two-column grid, so an input written first
          took column one and put the switch left of its own label, alone in the whole product. */}
      <div className="field field-boolean">
        <span className="field-head">
          <label className="field-label" htmlFor={enabledControlId}>
            Schedule is on
          </label>
        </span>
        <input
          id={enabledControlId}
          aria-checked={schedule.enabled}
          checked={schedule.enabled}
          onChange={(e) => set({ enabled: e.target.checked })}
          role="switch"
          type="checkbox"
        />
        <small className="field-description">
          Switching it off stops the schedule straight away. The template stays, and{' '}
          <code>/message post</code> still posts it on request.
        </small>
      </div>

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
