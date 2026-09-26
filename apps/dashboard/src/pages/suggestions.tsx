import { type SuggestionsConfig, suggestionsConfigSchema } from '@proton/module-suggestions/config';
import type { ReactElement } from 'react';
import { ChannelPicker } from '../components/discord/channel-picker.tsx';
import { useModuleForm } from '../components/module/form.ts';
import {
  ModuleBanners,
  ModuleHeader,
  ModuleSwitch,
  moduleState,
} from '../components/module/page.tsx';
import type { ModulePageProps } from '../components/module/registry.ts';
import { useModuleToggle } from '../components/module/toggle.ts';
import { SegmentedControl, type SegmentedOption, Switch } from '../components/ui/controls.tsx';
import { StatusBanner } from '../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../components/ui/layout.tsx';
import { SaveBar } from '../components/ui/savebar.tsx';

type Attribution = 'named' | 'anonymous';

const ATTRIBUTION_OPTIONS: readonly SegmentedOption<Attribution>[] = [
  { value: 'named', label: 'Named' },
  { value: 'anonymous', label: 'Anonymous' },
];

function outcome(config: SuggestionsConfig): string {
  return config.anonymous
    ? 'Suggestions don’t show who wrote them.'
    : 'Suggestions show who wrote them.';
}

function consequences(config: SuggestionsConfig): string[] {
  if (!config.anonymous) {
    return [
      'The post reads “Suggested by @member.”',
      'Suggestions posted while this was Anonymous show their author after the next vote or ' +
        'decision.',
    ];
  }

  const points = [
    'The post reads “Suggested anonymously.” instead of “Suggested by @member.”',
    'Proton still stores who wrote each suggestion.',
    `Nothing in the channel${config.createThread ? ', the discussion thread' : ''} or this ` +
      'dashboard names the author.',
    'Suggestions posted before this change keep the author’s name until the next vote or ' +
      'decision.',
  ];

  if (!config.allowSelfVote) {
    points.push(
      'Members still can’t vote on their own suggestions, because Proton knows who wrote them.',
    );
  }

  return points;
}

export default function SuggestionsPage({ guildId, meta, summary }: ModulePageProps): ReactElement {
  const form = useModuleForm({ guildId, moduleId: meta.id, schema: suggestionsConfigSchema });
  const toggle = useModuleToggle(guildId, summary);

  const enabled = summary?.enabled ?? form.view.enabled;
  const noChannel = enabled && form.value.channelId === undefined;
  const anonymityError = form.errorAt('anonymous');

  return (
    <>
      <ModuleHeader
        meta={meta}
        actions={
          <ModuleSwitch
            name={meta.label}
            enabled={enabled}
            state={summary ? moduleState(summary) : 'off'}
            busy={toggle.busy}
            onToggle={toggle.toggle}
          />
        }
      />

      <ModuleBanners
        moduleName={meta.label}
        status={summary?.status}
        enabled={enabled}
        migrated={form.view.migrated}
        changedElsewhere={form.changedElsewhere}
        saveError={form.saveError}
      >
        {toggle.failure !== null ? (
          <StatusBanner tone="danger" live="assertive" onDismiss={toggle.dismiss}>
            {toggle.failure}
          </StatusBanner>
        ) : null}
      </ModuleBanners>

      <Section label="Attribution">
        <div className="suggestions-attribution">
          <div className="suggestions-choice">
            <SegmentedControl
              block
              label="Attribution"
              options={ATTRIBUTION_OPTIONS}
              value={form.value.anonymous ? 'anonymous' : 'named'}
              onChange={(next) =>
                form.setValue((current) => ({ ...current, anonymous: next === 'anonymous' }))
              }
            />
            {anonymityError !== undefined ? (
              <p className="row-error" role="alert">
                {anonymityError}
              </p>
            ) : null}
          </div>

          <div className="suggestions-effect">
            <p className="suggestions-outcome">{outcome(form.value)}</p>
            <ul className="suggestions-consequences">
              {consequences(form.value).map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      <Section label="Posting">
        <Rows>
          <SettingRow
            title="Suggestion channel"
            description="Where suggestions are posted. Needs View Channel, Send Messages and Embed Links there."
            error={form.errorAt('channelId')}
            note={
              noChannel ? (
                <span className="text-warning">
                  No suggestion channel is set, so /suggest can’t post anything.
                </span>
              ) : undefined
            }
          >
            <ChannelPicker
              guildId={guildId}
              label="Suggestion channel"
              noneLabel="No channel"
              placeholder="Choose a channel"
              invalid={form.errorAt('channelId') !== undefined}
              value={form.value.channelId}
              onChange={(next) =>
                form.setValue((current) => ({ ...current, channelId: next ?? undefined }))
              }
            />
          </SettingRow>

          <SettingRow
            title="Create discussion threads"
            description="Open a thread under each suggestion. Needs Create Public Threads in the suggestion channel."
            error={form.errorAt('createThread')}
          >
            <Switch
              label="Create discussion threads"
              checked={form.value.createThread}
              onChange={(next) => form.setValue((current) => ({ ...current, createThread: next }))}
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section
        label="Voting"
        intro="Voting closes once staff accept, deny or implement a suggestion."
      >
        <Rows>
          <SettingRow
            title="Let members vote on their own suggestion"
            description="When off, Proton doesn’t count an author’s vote on their own suggestion."
            error={form.errorAt('allowSelfVote')}
          >
            <Switch
              label="Let members vote on their own suggestion"
              checked={form.value.allowSelfVote}
              onChange={(next) => form.setValue((current) => ({ ...current, allowSelfVote: next }))}
            />
          </SettingRow>
        </Rows>
      </Section>

      <SaveBar
        dirty={form.dirty}
        saving={form.saving}
        failures={form.failures}
        onSave={form.save}
        onReset={form.reset}
      />
    </>
  );
}
