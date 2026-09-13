import type { AutomodConfig, KeywordPreset } from '@proton/module-automod/config';
import { severityOf } from '@proton/module-automod/config';
import type { DesiredRule } from '@proton/module-automod/native';
import { planNativeRules, RULE_NAMES } from '@proton/module-automod/native';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import type { ModuleForm } from '../../components/module/form.ts';
import { ModuleLink } from '../../components/module/route.tsx';
import { Badge, NumberStepper, Switch } from '../../components/ui/controls.tsx';
import { EmptyState, Spinner, StatusBanner } from '../../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { channelsQuery } from '../../lib/queries.ts';
import { TokenField } from './lists.tsx';
import { setField } from './shape.ts';

type Form = ModuleForm<AutomodConfig>;

// KEYWORD_PRESETS itself is not exported from ./config, only the type — so the literals are
// declared here and checked against it rather than duplicated silently.
const PRESETS = ['profanity', 'sexualContent', 'slurs'] as const satisfies readonly KeywordPreset[];

const PRESET_LABEL: Record<KeywordPreset, string> = {
  profanity: 'Profanity',
  sexualContent: 'Sexual content',
  slurs: 'Slurs',
};

const PRESET_DESCRIPTION: Record<KeywordPreset, string> = {
  profanity: 'Block swearing and cursing.',
  sexualContent: 'Block sexually explicit words.',
  slurs: 'Block personal insults and hate speech.',
};

function ruleDetail(rule: DesiredRule, config: AutomodConfig): string {
  const metadata = rule.triggerMetadata;

  if (rule.name === RULE_NAMES.keywords) {
    const words = metadata.keywordFilter?.length ?? 0;
    const patterns = metadata.regexPatterns?.length ?? 0;

    return [
      `${words} ${words === 1 ? 'word' : 'words'}`,
      `${patterns} ${patterns === 1 ? 'pattern' : 'patterns'}`,
    ].join(' · ');
  }

  if (rule.name === RULE_NAMES.presets) {
    return config.presets.map((preset) => PRESET_LABEL[preset]).join(' · ');
  }

  if (rule.name === RULE_NAMES.mentions) {
    return `${config.mentionLimit} or more mentions in one message`;
  }

  return 'Discord’s spam filter';
}

function Plan({
  form,
  guildId,
  enabled,
}: {
  form: Form;
  guildId: string;
  enabled: boolean;
}): ReactElement {
  const config = form.value;
  const plan = planNativeRules({ ...config, enabled });

  const { data: channels, isPending: channelsPending } = useQuery(channelsQuery(guildId));
  const alert = channels?.find((channel) => channel.id === config.alertChannelId);

  const alerting =
    config.alertChannelId === undefined ? null : (
      <>
        {' and sends an alert to '}
        {alert ? (
          `#${alert.name}`
        ) : channelsPending ? (
          <Spinner label="Loading channel" />
        ) : (
          'the alert channel'
        )}
      </>
    );

  const patternsOff = severityOf(config, 'patterns') === 'off';

  const exempting = config.exemptRoleIds.length > 0 || config.exemptChannelIds.length > 0;
  const wordRules = plan.desired.filter(
    (rule) => rule.name === RULE_NAMES.keywords || rule.name === RULE_NAMES.presets,
  ).length;

  return (
    <Section label="Rules Proton creates">
      {!enabled ? (
        <StatusBanner tone="neutral">
          Automod is switched off, so Proton creates no rules.
        </StatusBanner>
      ) : plan.desired.length === 0 ? (
        <EmptyState inset title="No rules">
          Add blocked words or regex patterns, choose a preset, set a mention limit or switch on the
          spam filter.
        </EmptyState>
      ) : (
        <Rows>
          {plan.desired.map((rule) => (
            <div className="automod-plan-row" key={rule.name}>
              <span className="automod-plan-name mono">{rule.name}</span>
              <span className="automod-plan-detail">{ruleDetail(rule, config)}</span>
            </div>
          ))}
        </Rows>
      )}

      {enabled && plan.desired.length > 0 ? (
        <div className="automod-note stack stack-8">
          <p>
            Each rule blocks the message{alerting}
            {exempting ? ', and skips exempt roles and channels' : ''}.
            {config.allowedWords.length > 0 && wordRules > 0
              ? ` Allowed words apply to ${wordRules === 1 ? 'the word rule' : 'both word rules'}.`
              : ''}
          </p>
          <p>
            These rules never time out, kick or ban. When one blocks a message, Proton records a
            warning that counts toward warn escalation in Moderation.
          </p>
        </div>
      ) : null}

      {plan.inHousePatterns.length > 0 ? (
        <>
          <p className="automod-note">
            {patternsOff
              ? 'Discord AutoMod cannot run these patterns, and Custom patterns is set to Off, so nothing runs them.'
              : 'Discord AutoMod cannot run these patterns, so Proton runs them itself.'}{' '}
            <ModuleLink
              className="automod-link"
              guildId={guildId}
              moduleId={'automod'}
              search={{ area: 'checks' }}
            >
              Edit them under Checks
            </ModuleLink>
          </p>

          <Rows>
            {plan.inHousePatterns.map((note, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: patterns have no id and two may be equal
              <div className="automod-plan-row" key={index}>
                <span className="automod-plan-name mono">{note.pattern}</span>
                <span className="automod-plan-detail">{note.reason}</span>
              </div>
            ))}
          </Rows>
        </>
      ) : null}
    </Section>
  );
}

export function NativeArea({
  form,
  guildId,
  enabled,
}: {
  form: Form;
  guildId: string;
  enabled: boolean;
}): ReactElement {
  const config = form.value;

  const togglePreset = (preset: KeywordPreset, on: boolean): void => {
    form.setValue((current) =>
      setField(
        current,
        'presets',
        PRESETS.filter((candidate) =>
          candidate === preset ? on : current.presets.includes(candidate),
        ),
      ),
    );
  };

  return (
    <>
      <div className="automod-intro stack stack-10">
        <p className="automod-note">
          Discord blocks matching messages before Proton sees them, so the checks and actions on the
          other tabs do not apply.
        </p>
        <span>
          <Badge tone="neutral" icon="lock">
            Needs Manage Server
          </Badge>
        </span>
      </div>

      <Section label="Words">
        <Rows>
          <SettingRow
            title="Blocked words"
            description="Discord blocks messages that contain any of these."
            error={form.errorAt('blockedWords')}
            stacked
          >
            <TokenField
              label="Blocked words"
              countLabel="words"
              placeholder="A word or phrase, or paste a list"
              max={1000}
              maxLength={60}
              searchFrom={25}
              value={config.blockedWords}
              onChange={(next) =>
                form.setValue((current) => setField(current, 'blockedWords', next))
              }
            />
          </SettingRow>

          <SettingRow
            title="Allowed words"
            description="Discord never blocks these, even when a blocked word or preset matches."
            error={form.errorAt('allowedWords')}
            stacked
          >
            <TokenField
              label="Allowed words"
              countLabel="words"
              placeholder="A word or phrase, or paste a list"
              max={100}
              maxLength={60}
              searchFrom={25}
              value={config.allowedWords}
              onChange={(next) =>
                form.setValue((current) => setField(current, 'allowedWords', next))
              }
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section label="Discord word presets">
        <Rows>
          {PRESETS.map((preset) => (
            <SettingRow
              key={preset}
              title={PRESET_LABEL[preset]}
              description={PRESET_DESCRIPTION[preset]}
            >
              <Switch
                label={PRESET_LABEL[preset]}
                checked={config.presets.includes(preset)}
                onChange={(on) => togglePreset(preset, on)}
              />
            </SettingRow>
          ))}
        </Rows>
      </Section>

      <Section label="Limits">
        <Rows>
          <SettingRow
            title="Discord mention limit"
            description="Set to 0 for no limit."
            note="Separate from the Mass mentions check. Both can be on."
            error={form.errorAt('mentionLimit')}
          >
            <NumberStepper
              label="Discord mention limit"
              value={config.mentionLimit}
              min={0}
              max={50}
              onChange={(next) =>
                form.setValue((current) =>
                  setField(current, 'mentionLimit', next ?? current.mentionLimit),
                )
              }
            />
          </SettingRow>

          <SettingRow
            title="Discord spam filter"
            description="Let Discord block messages it considers spam."
          >
            <Switch
              label="Discord spam filter"
              checked={config.nativeSpam}
              onChange={(on) => form.setValue((current) => setField(current, 'nativeSpam', on))}
            />
          </SettingRow>
        </Rows>
      </Section>

      <Plan form={form} guildId={guildId} enabled={enabled} />
    </>
  );
}
