import type { EntitlementTier } from '@proton/core';
import {
  APPROVE_ACTIONS,
  type AppealPanel,
  type ApproveAction,
  appealPanelsSchema,
  QUESTIONS_MAX,
} from '@proton/module-appeals/config';
import { type ReactElement, useId } from 'react';
import { ceilingNote, listCeiling } from '../../lib/limits.ts';
import { channelOptions, type DiscordChannel, SinglePicker } from '../form/picker.tsx';

export interface AppealPanelsEditorProps {
  panels: readonly Partial<AppealPanel>[];
  channels: readonly DiscordChannel[];
  tier: EntitlementTier;
  onChange: (panels: AppealPanel[]) => void;
}

const TEXT_CHANNEL_TYPES = [0, 5, 11, 12];

const APPROVE_LABELS: Record<ApproveAction, string> = {
  unban: 'Unban them',
  untimeout: 'Lift their timeout',
  nothing: 'Nothing — record the decision only',
};

function blank(index: number): AppealPanel {
  return appealPanelsSchema.parse([
    {
      id: `form-${index + 1}`,
      name: 'Ban appeal',
      questions: [{ key: 'why', label: 'Why should this be lifted?' }],
    },
  ])[0] as AppealPanel;
}

function complete(panel: Partial<AppealPanel>, index: number): AppealPanel {
  return { ...blank(index), ...panel };
}

export function AppealPanelsEditor({
  panels: stored,
  channels,
  tier,
  onChange,
}: AppealPanelsEditorProps): ReactElement {
  const fieldId = useId();
  const ceiling = listCeiling(tier, 'appealPanels');

  const panels = stored.map(complete);
  const parsed = appealPanelsSchema.safeParse(panels);

  function update(index: number, patch: Partial<AppealPanel>): void {
    onChange(panels.map((panel, i) => (i === index ? { ...panel, ...patch } : panel)));
  }

  function question(
    index: number,
    at: number,
    patch: Partial<AppealPanel['questions'][number]>,
  ): void {
    const held = panels[index];
    if (!held) return;

    update(index, {
      questions: held.questions.map((question, i) =>
        i === at ? { ...question, ...patch } : question,
      ),
    });
  }

  return (
    <div className="ladder" data-path="panels">
      <p className="field-description">
        A form is what somebody sees when they open an appeal link. A honeypot points at one of
        these by name, so renaming a form is safe but changing its id is not.
      </p>

      {panels.map((panel, index) => {
        const id = (part: string): string => `${fieldId}-${part}-${index}`;

        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: the edited value cannot key its own row
          <div className="ladder-rung" key={`panel-${index}`}>
            <label className="filter">
              <span>Name</span>
              <input
                type="text"
                maxLength={80}
                value={panel.name}
                onChange={(e) => update(index, { name: e.target.value })}
              />
            </label>

            <label className="filter">
              <span>Id</span>
              <input
                className="mono"
                type="text"
                maxLength={32}
                value={panel.id}
                onChange={(e) => update(index, { id: e.target.value })}
              />
            </label>

            <div className="filter">
              <span>
                <label htmlFor={id('review')}>Review channel</label>
              </span>
              <SinglePicker
                id={id('review')}
                label="Review channel"
                options={channelOptions(channels, TEXT_CHANNEL_TYPES)}
                value={panel.reviewChannelId ?? null}
                onChange={(next) => update(index, { reviewChannelId: next ?? undefined })}
                emptyLabel="Use the server default"
                clearable
              />
            </div>

            <label className="filter">
              <span>Accepting it does</span>
              <select
                value={panel.onApprove}
                onChange={(e) => update(index, { onApprove: e.target.value as ApproveAction })}
              >
                {APPROVE_ACTIONS.map((action) => (
                  <option key={action} value={action}>
                    {APPROVE_LABELS[action]}
                  </option>
                ))}
              </select>
            </label>

            <label className="filter">
              <span>Appeals close after (days)</span>
              <input
                type="number"
                min={1}
                max={30}
                value={panel.windowDays}
                onChange={(e) => update(index, { windowDays: e.target.valueAsNumber || 1 })}
              />
            </label>

            <label className="filter">
              <span>Wait before appealing again (days)</span>
              <input
                type="number"
                min={0}
                max={365}
                value={panel.cooldownDays}
                onChange={(e) => update(index, { cooldownDays: e.target.valueAsNumber || 0 })}
              />
            </label>

            <label className="filter">
              <span>Let them appeal again after a refusal</span>
              <input
                type="checkbox"
                role="switch"
                checked={panel.allowResubmit}
                aria-checked={panel.allowResubmit}
                onChange={(e) => update(index, { allowResubmit: e.target.checked })}
              />
            </label>

            <label className="filter">
              <span>Take them off the blocked list too</span>
              <input
                type="checkbox"
                role="switch"
                checked={panel.liftBlocklistOnApprove}
                aria-checked={panel.liftBlocklistOnApprove}
                onChange={(e) => update(index, { liftBlocklistOnApprove: e.target.checked })}
              />
            </label>

            <div className="ladder-nested">
              {panel.questions.map((held, at) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the edited value cannot key its own row
                <div className="filter" key={`question-${at}`}>
                  <span>Question {at + 1}</span>
                  <input
                    type="text"
                    maxLength={120}
                    value={held.label}
                    onChange={(e) => question(index, at, { label: e.target.value })}
                  />
                </div>
              ))}

              <button
                type="button"
                className="button button-quiet"
                disabled={panel.questions.length >= QUESTIONS_MAX}
                onClick={() =>
                  update(index, {
                    questions: [
                      ...panel.questions,
                      {
                        key: `q${panel.questions.length + 1}`,
                        label: 'Anything else?',
                        required: false,
                        maxLength: 1024,
                      },
                    ],
                  })
                }
              >
                Add a question
              </button>
            </div>

            <button
              type="button"
              className="button button-ghost"
              aria-label={`Remove form ${index + 1}`}
              onClick={() => onChange(panels.filter((_, i) => i !== index))}
            >
              Remove
            </button>
          </div>
        );
      })}

      {panels.length === 0 ? (
        <p className="field-empty">
          No appeal forms yet. Nobody can appeal until one exists for a honeypot to point at.
        </p>
      ) : null}

      <button
        type="button"
        className="button button-quiet"
        disabled={panels.length >= ceiling}
        onClick={() => onChange([...panels, blank(panels.length)])}
      >
        {panels.length >= ceiling ? ceilingNote(tier, 'appealPanels') : 'Add an appeal form'}
      </button>

      {parsed.success ? null : (
        <ul className="ladder-errors" role="alert">
          {parsed.error.issues.map((issue) => (
            <li key={`${issue.path.map(String).join('.')}-${issue.message}`}>
              {issue.path.length > 0 ? `Form ${Number(issue.path[0]) + 1}: ` : ''}
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
