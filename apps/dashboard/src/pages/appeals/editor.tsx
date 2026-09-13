import type { AppealPanel, ApproveAction } from '@proton/module-appeals/config';
import { reviewChannelFor } from '@proton/module-appeals/config';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { ChannelPicker } from '../../components/discord/channel-picker.tsx';
import { ModuleLink } from '../../components/module/route.tsx';
import {
  IconButton,
  NumberStepper,
  Select,
  Switch,
  TextArea,
  TextInput,
} from '../../components/ui/controls.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { channelsQuery } from '../../lib/queries.ts';
import { DecisionDm, PanelPreview } from './preview.tsx';
import { QuestionsSection } from './questions.tsx';
import {
  type AppealsForm,
  BLURB_MAX,
  MESSAGE_MAX,
  OUTCOME_OPTIONS,
  PANEL_NAME_MAX,
  REJOIN_URL_MAX,
  REVIEW_CHANNEL_TYPES,
  setOptional,
  updatePanel,
} from './shape.ts';

const NO_CHANNEL = 'No review channel is set here or under Review, so appeals have nowhere to go.';

function Counter({ used, ceiling }: { used: number; ceiling: number }): ReactElement {
  return (
    <span className="field-hint appeals-counter">
      {used} / {ceiling}
    </span>
  );
}

export function PanelEditor({
  form,
  panel,
  index,
  guildId,
  moduleId,
}: {
  form: AppealsForm;
  panel: AppealPanel;
  index: number;
  guildId: string;
  moduleId: string;
}): ReactElement {
  const config = form.value;
  const path = `panels.${index}`;

  const { data: channels } = useQuery(channelsQuery(guildId));
  const routedTo = reviewChannelFor(config, panel);
  const channelName = (channels ?? []).find((channel) => channel.id === routedTo)?.name;

  const patch = (change: (current: AppealPanel) => AppealPanel): void =>
    updatePanel(form, panel.id, change);

  const nameError =
    panel.name.trim() === '' ? 'Appeal form needs a name.' : form.errorAt(`${path}.name`);

  return (
    <div className="editor">
      <div className="editor-main">
        <Section label="Details">
          <Rows>
            <SettingRow
              title="Name"
              description="Shown on the appeal page and the review card."
              error={nameError}
            >
              <TextInput
                width="lg"
                aria-label="Name"
                maxLength={PANEL_NAME_MAX}
                invalid={nameError !== undefined}
                value={panel.name}
                onChange={(event) =>
                  patch((current) => ({ ...current, name: event.currentTarget.value }))
                }
              />
            </SettingRow>

            <SettingRow
              title="ID"
              description="Honeypot points at this form by its ID. It cannot be changed, because appeal links already sent would stop working."
              error={form.errorAt(`${path}.id`)}
            >
              <span className="inline inline-6">
                <TextInput readOnly width="sm" className="mono" aria-label="ID" value={panel.id} />
                <IconButton
                  tone="ghost"
                  size="sm"
                  icon="clipboard-text"
                  label="Copy ID"
                  onClick={() => navigator.clipboard?.writeText(panel.id)}
                />
              </span>
            </SettingRow>

            <SettingRow
              title="Enabled"
              description="Switch off to close this form without deleting it."
              note={
                panel.enabled
                  ? undefined
                  : 'Members who open its link see: “This server is not taking appeals at the moment.”'
              }
            >
              <Switch
                label="Enabled"
                checked={panel.enabled}
                onChange={(next) => patch((current) => ({ ...current, enabled: next }))}
              />
            </SettingRow>

            <SettingRow
              stacked
              title="Introduction"
              description="Shown above the questions on the appeal page."
              error={form.errorAt(`${path}.blurb`)}
            >
              <div className="stack stack-4">
                <TextArea
                  rows={3}
                  aria-label="Introduction"
                  maxLength={BLURB_MAX}
                  invalid={form.errorAt(`${path}.blurb`) !== undefined}
                  value={panel.blurb}
                  onChange={(event) =>
                    patch((current) => ({ ...current, blurb: event.currentTarget.value }))
                  }
                />
                <Counter used={panel.blurb.length} ceiling={BLURB_MAX} />
              </div>
            </SettingRow>
          </Rows>
        </Section>

        <QuestionsSection form={form} panel={panel} index={index} />

        <Section label="Timing">
          <Rows>
            <SettingRow
              title="Appeals close after"
              description="How long after the action a member can still appeal, counted from when the link was sent."
              note={`After that, the page shows: “Appeals close ${panel.windowDays} days after the action, and that has passed.”`}
              error={form.errorAt(`${path}.windowDays`)}
            >
              <NumberStepper
                label="Appeals close after"
                unit="days"
                width={148}
                min={1}
                max={30}
                value={panel.windowDays}
                invalid={form.errorAt(`${path}.windowDays`) !== undefined}
                onChange={(next) =>
                  patch((current) => ({ ...current, windowDays: next ?? current.windowDays }))
                }
              />
            </SettingRow>

            <SettingRow
              title="Appeal cooldown"
              description="How long a member must wait after a decision before appealing again. Set to 0 for no cooldown."
              note={
                panel.cooldownDays === 0
                  ? undefined
                  : `During the cooldown, the page shows: “You appealed recently. You can appeal again in ${panel.cooldownDays} days.”`
              }
              error={form.errorAt(`${path}.cooldownDays`)}
            >
              <NumberStepper
                label="Appeal cooldown"
                unit="days"
                width={148}
                min={0}
                max={365}
                value={panel.cooldownDays}
                invalid={form.errorAt(`${path}.cooldownDays`) !== undefined}
                onChange={(next) =>
                  patch((current) => ({ ...current, cooldownDays: next ?? current.cooldownDays }))
                }
              />
            </SettingRow>

            <SettingRow
              title="Allow another appeal"
              description="Let a turned-down member appeal again from the same link once the cooldown ends."
            >
              <Switch
                label="Allow another appeal"
                checked={panel.allowResubmit}
                onChange={(next) => patch((current) => ({ ...current, allowResubmit: next }))}
              />
            </SettingRow>
          </Rows>

          <p className="appeals-note">
            An appeal link lasts 30 days, so no appeal can be sent after that.
          </p>
        </Section>

        <Section label="Review">
          <Rows>
            <SettingRow
              title="Review channel"
              description="Where appeals from this form are posted."
              error={routedTo === undefined ? NO_CHANNEL : form.errorAt(`${path}.reviewChannelId`)}
            >
              <ChannelPicker
                guildId={guildId}
                label="Review channel"
                noneLabel="Use default"
                placeholder="Use default"
                types={REVIEW_CHANNEL_TYPES}
                invalid={routedTo === undefined}
                value={panel.reviewChannelId ?? null}
                onChange={(next) =>
                  patch((current) => setOptional(current, 'reviewChannelId', next ?? ''))
                }
              />
            </SettingRow>
          </Rows>

          <p className="appeals-note">
            Reviewer roles apply to every form. Set them under{' '}
            <ModuleLink guildId={guildId} moduleId={moduleId} search={{ area: 'review' }}>
              Review
            </ModuleLink>
            .
          </p>
        </Section>

        <Section label="When accepted">
          <Rows>
            <SettingRow
              title="Action"
              description="What Proton does when a reviewer accepts an appeal."
              error={form.errorAt(`${path}.onApprove`)}
            >
              <Select
                width="md"
                aria-label="Action"
                options={OUTCOME_OPTIONS}
                value={panel.onApprove}
                onChange={(event) => {
                  const next = event.currentTarget.value as ApproveAction;
                  // Cleared rather than kept hidden: a rejoin link is still appended to an accepted
                  // appeal's DM whatever this is set to, so leaving one behind sends it invisibly.
                  patch((current) =>
                    next === 'nothing'
                      ? { ...setOptional(current, 'rejoinUrl', ''), onApprove: next }
                      : { ...current, onApprove: next },
                  );
                }}
              />
            </SettingRow>

            <SettingRow
              title="Lift Proton’s block"
              description={
                <>
                  Remove the member from{' '}
                  <ModuleLink
                    guildId={guildId}
                    moduleId={'moderation'}
                    search={{ area: 'blocked' }}
                  >
                    Blocked members
                  </ModuleLink>
                  , with the accepted appeal as the reason. This does not remove a ban or timeout on
                  its own.
                </>
              }
            >
              <Switch
                label="Lift Proton’s block"
                checked={panel.liftBlocklistOnApprove}
                onChange={(next) =>
                  patch((current) => ({ ...current, liftBlocklistOnApprove: next }))
                }
              />
            </SettingRow>

            {panel.onApprove === 'nothing' ? null : (
              <SettingRow
                title="Rejoin link"
                description="Added to the end of the accepted message."
                error={form.errorAt(`${path}.rejoinUrl`)}
              >
                <TextInput
                  width="lg"
                  aria-label="Rejoin link"
                  maxLength={REJOIN_URL_MAX}
                  invalid={form.errorAt(`${path}.rejoinUrl`) !== undefined}
                  value={panel.rejoinUrl ?? ''}
                  onChange={(event) =>
                    patch((current) => setOptional(current, 'rejoinUrl', event.currentTarget.value))
                  }
                />
              </SettingRow>
            )}
          </Rows>
        </Section>

        <Section label="Direct messages">
          <Rows>
            <SettingRow
              stacked
              title="Accepted message"
              error={form.errorAt(`${path}.approvedMessage`)}
            >
              <div className="stack stack-4">
                <TextArea
                  rows={2}
                  aria-label="Accepted message"
                  maxLength={MESSAGE_MAX}
                  invalid={form.errorAt(`${path}.approvedMessage`) !== undefined}
                  value={panel.approvedMessage}
                  onChange={(event) =>
                    patch((current) => ({ ...current, approvedMessage: event.currentTarget.value }))
                  }
                />
                <Counter used={panel.approvedMessage.length} ceiling={MESSAGE_MAX} />
              </div>
            </SettingRow>

            <SettingRow
              stacked
              title="Turned-down message"
              error={form.errorAt(`${path}.deniedMessage`)}
            >
              <div className="stack stack-4">
                <TextArea
                  rows={2}
                  aria-label="Turned-down message"
                  maxLength={MESSAGE_MAX}
                  invalid={form.errorAt(`${path}.deniedMessage`) !== undefined}
                  value={panel.deniedMessage}
                  onChange={(event) =>
                    patch((current) => ({ ...current, deniedMessage: event.currentTarget.value }))
                  }
                />
                <Counter used={panel.deniedMessage.length} ceiling={MESSAGE_MAX} />
              </div>
            </SettingRow>
          </Rows>

          <div className="stack stack-16 appeals-dm">
            <div className="stack stack-6">
              <span className="editor-preview-title">Accepted</span>
              <DecisionDm panel={panel} status="approved" />
            </div>
            <div className="stack stack-6">
              <span className="editor-preview-title">Turned down</span>
              <DecisionDm panel={panel} status="denied" />
            </div>
          </div>
        </Section>
      </div>

      <PanelPreview panel={panel} channelName={channelName} />
    </div>
  );
}
