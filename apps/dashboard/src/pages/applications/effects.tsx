import type { ApplicationDetail, EffectView } from '@proton/module-applications/view';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { MetaSeparator } from '../../components/ui/collection.tsx';
import { Badge, Button } from '../../components/ui/controls.tsx';
import { StatusBanner } from '../../components/ui/feedback.tsx';
import { Rows, Section } from '../../components/ui/layout.tsx';
import { When } from '../moderation/reports/when.tsx';
import { type Outcome, outcomeOf, useApplicationAction } from './dialogs.tsx';
import {
  canCancel,
  canRetry,
  downgradeNotice,
  EFFECT_STATUS_LABELS,
  effectLabel,
  effectRoleId,
  effectStatusTone,
  effectTrigger,
  isWorking,
  shownEffects,
} from './labels.ts';

export const ACTIONS_ANCHOR = 'application-actions';

const PAUSED =
  'Applications is off, so these are paused. Proton checks they still apply and carries them ' +
  'on once you turn it on.';

const ACTIONS_HELP =
  'What Proton does after each step, such as DMs, roles, the review card and requests to other ' +
  'modules. A failed action can be tried again on its own, without running the others again.';

export function EffectsSection({
  guildId,
  detail,
  now,
  moduleOn,
  manage,
  roleName,
  onDone,
}: {
  guildId: string;
  detail: ApplicationDetail;
  now: number;
  moduleOn: boolean | null;
  manage: boolean;
  roleName?: ((id: string) => string | undefined) | undefined;
  onDone: (outcome: Outcome) => void;
}): ReactElement {
  const effects = shownEffects(detail.effects);
  const action = useApplicationAction(guildId, detail.application.id);
  const [busy, setBusy] = useState<{ id: string; change: 'retry' | 'cancel' } | null>(null);

  const settle = (effect: EffectView, change: 'retry' | 'cancel'): void => {
    setBusy({ id: effect.id, change });
    action.run(
      change === 'retry'
        ? { action: 'retry_effect', effectId: effect.id }
        : { action: 'cancel_effect', effectId: effect.id },
      change === 'retry' ? 'Couldn’t try the action again' : 'Couldn’t cancel the action',
      {
        onAnswer: (result) => {
          setBusy(null);
          onDone(outcomeOf(result));
        },
        onFailure: (failure) => {
          setBusy(null);
          onDone(failure);
        },
      },
    );
  };

  return (
    <div id={ACTIONS_ANCHOR} className="applications-review-block">
      <Section label="Actions" help={ACTIONS_HELP}>
        {moduleOn === false && isWorking(detail.effects) ? (
          <StatusBanner tone="info">{PAUSED}</StatusBanner>
        ) : null}

        {effects.length === 0 ? (
          <p className="text-sm text-muted">Proton has nothing to do for this application.</p>
        ) : (
          <Rows className="applications-review-effects">
            {effects.map((effect) => {
              const label = effectLabel(effect);
              const trigger = effectTrigger(effect.key);
              const roleId = effectRoleId(effect);
              const notice = downgradeNotice(effect);
              const showError = effect.error !== null && effect.status !== 'succeeded';

              return (
                <div
                  key={effect.id}
                  className="applications-review-effect"
                  data-status={effect.status}
                >
                  <div className="applications-review-effect-main">
                    <p className="applications-review-effect-title">
                      <span>{label}</span>
                      {roleId !== null ? (
                        <span className="applications-review-effect-role">
                          {roleName?.(roleId) ?? <span className="mono text-xs">{roleId}</span>}
                        </span>
                      ) : null}
                      <Badge tone={effectStatusTone(effect.status)}>
                        {EFFECT_STATUS_LABELS[effect.status]}
                      </Badge>
                    </p>
                    <p className="applications-review-effect-meta">
                      {trigger !== null ? (
                        <>
                          <span>{trigger}</span>
                          <MetaSeparator />
                        </>
                      ) : null}
                      {effect.attempts > 1 ? (
                        <>
                          <span>{effect.attempts} attempts</span>
                          <MetaSeparator />
                        </>
                      ) : null}
                      <When at={effect.updatedAt} now={now} />
                    </p>
                    {showError ? (
                      <p
                        className={
                          effect.status === 'failed'
                            ? 'applications-review-effect-error'
                            : 'applications-review-effect-note'
                        }
                      >
                        {effect.error}
                      </p>
                    ) : null}
                    {notice !== null ? (
                      <p className="applications-review-effect-note text-warning">{notice}</p>
                    ) : null}
                  </div>

                  {manage && (canRetry(effect) || canCancel(effect)) ? (
                    <div className="applications-review-effect-actions">
                      {canRetry(effect) ? (
                        <Button
                          size="sm"
                          aria-label={`Try ${label} again`}
                          busy={busy?.id === effect.id && busy.change === 'retry'}
                          disabled={action.pending}
                          onClick={() => settle(effect, 'retry')}
                        >
                          Retry
                        </Button>
                      ) : null}
                      {canCancel(effect) ? (
                        <Button
                          size="sm"
                          tone="ghost"
                          aria-label={`Cancel ${label}`}
                          busy={busy?.id === effect.id && busy.change === 'cancel'}
                          disabled={action.pending}
                          onClick={() => settle(effect, 'cancel')}
                        >
                          Cancel
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </Rows>
        )}
      </Section>
    </div>
  );
}
