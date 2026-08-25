import type { EntitlementTier } from '@proton/core';
import {
  DELETE_SECONDS_MAX,
  describeWindow,
  HONEYPOT_ACTIONS,
  type HoneypotAction,
  type HoneypotChannel,
  honeypotChannelsSchema,
  SECONDS_PER_DAY,
} from '@proton/module-honeypot/config';
import { type ReactElement, useEffect, useId, useRef, useState } from 'react';
import { ceilingNote, listCeiling } from '../../lib/limits.ts';
import { channelOptions, type DiscordChannel, SinglePicker } from '../form/picker.tsx';
import { Icon } from '../shell/icon.tsx';

export interface HoneypotChannelsEditorProps {
  honeypots: readonly Partial<HoneypotChannel>[];
  channels: readonly DiscordChannel[];
  tier: EntitlementTier;
  onChange: (honeypots: HoneypotChannel[]) => void;
}

const TEXT_CHANNEL_TYPES = [0, 5];

const MAX_DAYS = DELETE_SECONDS_MAX / SECONDS_PER_DAY;

const ACTION_LABELS: Record<HoneypotAction, string> = {
  softban: 'Softban — remove them and delete their messages',
  ban: 'Ban',
  kick: 'Kick',
  timeout: 'Timeout',
  warn: 'Warn',
  none: 'Log it and do nothing else',
};

const CONSEQUENCES: Record<HoneypotAction, string> = {
  softban: 'be removed from the server and let straight back in',
  ban: 'be banned from the server',
  kick: 'be removed from the server',
  timeout: 'be timed out and unable to speak',
  warn: 'be given a warning on their record',
  none: 'be reported to your moderators, and nothing else',
};

function blank(): HoneypotChannel {
  return {
    channelId: '',
    enabled: true,
    action: 'softban',
    deleteMessageSeconds: DELETE_SECONDS_MAX,
    timeoutDuration: '1h',
  };
}

function complete(honeypot: Partial<HoneypotChannel>): HoneypotChannel {
  return { ...blank(), ...honeypot, channelId: honeypot.channelId ?? '' };
}

function purges(action: HoneypotAction): boolean {
  return action === 'softban' || action === 'ban';
}

function nameOf(channels: readonly DiscordChannel[], channelId: string): string {
  if (channelId === '') return 'the channel you pick';

  return `#${channels.find((channel) => channel.id === channelId)?.name ?? channelId}`;
}

function secondsFromDays(value: number): number {
  if (!Number.isFinite(value)) return 0;

  return Math.min(DELETE_SECONDS_MAX, Math.max(0, Math.round(value * SECONDS_PER_DAY)));
}

function windowHint(honeypot: HoneypotChannel): string {
  if (!purges(honeypot.action))
    return 'Only a softban or a ban can delete what they already posted.';
  if (honeypot.deleteMessageSeconds === 0) return 'Nothing they already posted is deleted.';

  return `Proton deletes everything they posted in ${describeWindow(honeypot.deleteMessageSeconds)}.`;
}

function consequence(honeypot: HoneypotChannel, where: string): string {
  const purge =
    purges(honeypot.action) && honeypot.deleteMessageSeconds > 0
      ? ` Everything they posted in ${describeWindow(honeypot.deleteMessageSeconds)} goes with them.`
      : '';

  return (
    `Any message anybody posts in ${where} will ${CONSEQUENCES[honeypot.action]}.${purge} ` +
    'Nobody is warned first unless you post the notice.'
  );
}

function ArmConfirm({
  sentence,
  onCancel,
  onArm,
}: {
  sentence: string;
  onCancel: () => void;
  onArm: () => void;
}): ReactElement {
  const cancel = useRef<HTMLButtonElement>(null);

  // This replaces the button that opened it, so without moving focus the keyboard was left on a
  // node that no longer exists. Focus lands on the safe choice, and Escape takes it.
  useEffect(() => {
    cancel.current?.focus();

    function onKey(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onCancel();
    }

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="honeypot-arming">
      <p className="honeypot-arming-text" role="alert">
        <Icon name="warning" weight="fill" />
        <span>{sentence}</span>
      </p>
      <div className="confirm-actions">
        <button ref={cancel} type="button" className="button button-quiet" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="button button-danger" onClick={onArm}>
          Arm it
        </button>
      </div>
    </div>
  );
}

type Arming = { kind: 'add' } | { kind: 'enable'; index: number };

export function HoneypotChannelsEditor({
  honeypots: stored,
  channels,
  tier,
  onChange,
}: HoneypotChannelsEditorProps): ReactElement {
  const fieldId = useId();
  const ceiling = listCeiling(tier, 'honeypotChannels');
  const [arming, setArming] = useState<Arming | null>(null);

  const honeypots = stored.map(complete);
  const parsed = honeypotChannelsSchema.safeParse(honeypots);
  const options = channelOptions(channels, TEXT_CHANNEL_TYPES);

  function update(index: number, patch: Partial<HoneypotChannel>): void {
    onChange(honeypots.map((honeypot, i) => (i === index ? { ...honeypot, ...patch } : honeypot)));
  }

  // Cleared on every structural change: the pending confirmation names a row by index, and a
  // removal above it would arm whichever trap slid into that slot.
  function remove(index: number): void {
    setArming(null);
    onChange(honeypots.filter((_, i) => i !== index));
  }

  function arm(): void {
    if (!arming) return;
    setArming(null);

    if (arming.kind === 'add') onChange([...honeypots, blank()]);
    else update(arming.index, { enabled: true });
  }

  return (
    <div className="ladder" data-path="channels">
      <p className="field-description">
        A honeypot is a channel nobody has any reason to post in. Anyone who posts in one is dealt
        with immediately — no warning, no threshold, no second message. That is the point: spam bots
        and compromised accounts post in every channel they can see, and members do not.
      </p>

      {honeypots.map((honeypot, index) => {
        // A label wrapping a picker would forward option clicks back to the trigger and reopen it.
        const id = (part: string): string => `${fieldId}-${part}-${index}`;
        const where = nameOf(channels, honeypot.channelId);

        return (
          <div
            className="ladder-rung honeypot-row"
            // biome-ignore lint/suspicious/noArrayIndexKey: the edited value cannot key its own row
            key={`honeypot-${index}`}
          >
            <div className="filter">
              <span>
                <label htmlFor={id('channel')}>Channel</label>
              </span>
              <SinglePicker
                id={id('channel')}
                label="Channel"
                options={options}
                value={honeypot.channelId === '' ? null : honeypot.channelId}
                onChange={(next) => update(index, { channelId: next ?? '' })}
                emptyLabel="Choose a channel…"
                clearable={false}
                invalid={honeypot.channelId === ''}
              />
            </div>

            <label className="filter">
              <span>What happens to them</span>
              <select
                value={honeypot.action}
                onChange={(e) =>
                  update(index, { action: e.target.value as HoneypotChannel['action'] })
                }
              >
                {HONEYPOT_ACTIONS.map((action) => (
                  <option key={action} value={action}>
                    {ACTION_LABELS[action]}
                  </option>
                ))}
              </select>
            </label>

            <label className="filter">
              <span>Delete their messages from the last (days)</span>
              <input
                type="number"
                min={0}
                max={MAX_DAYS}
                step={1}
                disabled={!purges(honeypot.action)}
                value={honeypot.deleteMessageSeconds / SECONDS_PER_DAY}
                onChange={(e) =>
                  update(index, {
                    deleteMessageSeconds: secondsFromDays(
                      e.target.value === '' ? 0 : e.target.valueAsNumber,
                    ),
                  })
                }
              />
              <small className="honeypot-hint">{windowHint(honeypot)}</small>
            </label>

            {honeypot.action === 'timeout' ? (
              <label className="filter">
                <span>Timed out for</span>
                <input
                  type="text"
                  value={honeypot.timeoutDuration}
                  onChange={(e) => update(index, { timeoutDuration: e.target.value })}
                />
              </label>
            ) : null}

            <label className="filter honeypot-switch">
              <span>Armed</span>
              <input
                type="checkbox"
                role="switch"
                checked={honeypot.enabled}
                aria-checked={honeypot.enabled}
                onChange={(e) => {
                  if (!e.target.checked) {
                    setArming(null);
                    update(index, { enabled: false });
                    return;
                  }

                  setArming({ kind: 'enable', index });
                }}
              />
            </label>

            <button
              type="button"
              className="button button-ghost"
              aria-label={`Remove honeypot ${index + 1}`}
              onClick={() => remove(index)}
            >
              Remove
            </button>

            {arming?.kind === 'enable' && arming.index === index ? (
              <ArmConfirm
                sentence={`Arming ${where}. ${consequence(honeypot, 'it')}`}
                onCancel={() => setArming(null)}
                onArm={arm}
              />
            ) : null}
          </div>
        );
      })}

      {honeypots.length === 0 ? (
        <p className="field-empty">
          No honeypot channels. Nothing is trapped until at least one channel is listed here.
        </p>
      ) : null}

      {arming?.kind === 'add' ? (
        <ArmConfirm
          sentence={`A new honeypot is armed as soon as you save it. ${consequence(
            blank(),
            'the channel you pick',
          )}`}
          onCancel={() => setArming(null)}
          onArm={arm}
        />
      ) : (
        <button
          type="button"
          className="button button-quiet"
          onClick={() => setArming({ kind: 'add' })}
          disabled={honeypots.length >= ceiling}
        >
          {honeypots.length >= ceiling
            ? ceilingNote(tier, 'honeypotChannels')
            : 'Add honeypot channel'}
        </button>
      )}

      {parsed.success ? null : (
        <ul className="ladder-errors" role="alert">
          {parsed.error.issues.map((issue) => (
            <li key={`${issue.path.map(String).join('.')}-${issue.message}`}>
              {issue.path.length > 0 ? `Honeypot ${Number(issue.path[0]) + 1}: ` : ''}
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
