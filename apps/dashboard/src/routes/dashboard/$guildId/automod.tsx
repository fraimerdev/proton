import type { AutomodConfig } from '@proton/module-automod/config';
import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { EnforcementPanel } from '../../../components/automod/enforcement.tsx';
import { SectionCard } from '../../../components/form/section.tsx';
import { AUTOMOD_AREAS as AREAS } from '../../../components/module/area-index.ts';
import { activeArea } from '../../../components/module/areas.ts';
import { useModuleForm } from '../../../components/module/form.ts';
import {
  ChannelField,
  Choice,
  Duration,
  Num,
  Rule,
  Toggle,
  Tokens,
} from '../../../components/module/inputs.tsx';
import { AreaHub, ModuleChrome, ModuleSettings } from '../../../components/module/page.tsx';
import { moduleRoute } from '../../../components/module/route.tsx';

const RESPONSES = ['none', 'warn', 'timeout', 'kick', 'ban'] as const;

export const Route = createFileRoute('/dashboard/$guildId/automod')({
  ...moduleRoute('automod', { areas: AREAS }),
  component: AutomodPage,
});

function AutomodPage(): ReactElement {
  const { guildId } = Route.useParams();
  const search = Route.useSearch();
  const form = useModuleForm(guildId, 'automod', true);

  const area = activeArea(AREAS, search.area);

  return (
    <>
      <ModuleChrome guildId={guildId} summary={form.summary} area={area} tabs={[]} />

      {area === undefined ? (
        <AreaHub areas={AREAS} config={form.config} />
      ) : (
        <ModuleSettings form={form}>
          {area.id === 'checks' ? <ChecksArea /> : null}
          {area.id === 'response' ? <ResponseArea /> : null}
          {area.id === 'discord' ? <DiscordArea config={form.live as AutomodConfig} /> : null}
          {area.id === 'exemptions' ? <ExemptionsArea /> : null}
        </ModuleSettings>
      )}
    </>
  );
}

function ChecksArea(): ReactElement {
  return (
    <>
      <SectionCard id="automod:spam" title="Spam">
        <Rule id="flood" label="Message flood" path="floodSeverity">
          <Num
            path="floodCount"
            label="Messages"
            min={2}
            max={50}
            defaultValue={6}
            param={{ label: 'Messages' }}
          />
          <Duration
            path="floodWindow"
            label="Window"
            defaultValue="5s"
            param={{ label: 'Window' }}
          />
        </Rule>

        <Rule id="duplicate" label="Duplicate messages" path="duplicateSeverity">
          <Num
            path="duplicateCount"
            label="Repeats"
            min={2}
            max={50}
            defaultValue={3}
            param={{ label: 'Repeats' }}
          />
          <Duration
            path="duplicateWindow"
            label="Window"
            defaultValue="30s"
            param={{ label: 'Window' }}
          />
        </Rule>

        <Rule id="mentions" label="Mass mentions" path="mentionsSeverity">
          <Num
            path="mentionsLimit"
            label="Limit"
            min={1}
            max={50}
            defaultValue={8}
            param={{ label: 'Limit' }}
          />
        </Rule>
      </SectionCard>

      <SectionCard id="automod:content" title="Content">
        <Rule id="invites" label="Invite links" path="invitesSeverity" />

        <Rule
          id="links"
          label="Blocked links"
          path="linksSeverity"
          stacked={
            <>
              <Tokens
                path="linkBlockDomains"
                kind="string"
                label="Blocked domains"
                help="Also blocks every subdomain"
                maxItems={200}
              />
              <Tokens
                path="linkAllowDomains"
                kind="string"
                label="Allowed domains"
                maxItems={200}
              />
            </>
          }
        />

        <Rule
          id="attachments"
          label="Attachments"
          path="attachmentsSeverity"
          stacked={
            <Tokens
              path="attachmentExtensions"
              kind="string"
              label="Blocked file types"
              help="Only the filename’s last extension is matched"
              maxItems={100}
            />
          }
        />

        <Rule id="patterns" label="Custom patterns" path="patternsSeverity" />
      </SectionCard>

      <SectionCard id="automod:formatting" title="Formatting">
        <Rule id="caps" label="Shouting" path="capsSeverity">
          <Num
            path="capsRatio"
            label="Percent"
            min={50}
            max={100}
            defaultValue={70}
            param={{ label: 'Percent' }}
          />
        </Rule>

        <Rule id="emoji" label="Emoji spam" path="emojiSeverity">
          <Num
            path="emojiLimit"
            label="Limit"
            min={1}
            max={100}
            defaultValue={12}
            param={{ label: 'Limit' }}
          />
        </Rule>

        <Rule id="walls" label="Walls of text" path="wallsSeverity">
          <Num
            path="wallMaxLines"
            label="Lines"
            min={2}
            max={200}
            defaultValue={15}
            param={{ label: 'Lines' }}
          />
        </Rule>

        <Rule id="zalgo" label="Zalgo text" path="zalgoSeverity" />
      </SectionCard>
    </>
  );
}

function ResponseArea(): ReactElement {
  return (
    <>
      <SectionCard id="automod:general" title="General">
        <ChannelField
          path="alertChannelId"
          label="Alert channel"
          channelTypes={[0, 5, 11, 12]}
          optional
        />
      </SectionCard>

      <SectionCard id="automod:response" title="Response">
        <Choice
          path="deleteFrom"
          label="Delete from severity"
          options={['low', 'medium', 'high', 'never']}
          defaultValue="low"
        />
        <Choice
          path="lowResponse"
          label="Low severity response"
          options={RESPONSES}
          defaultValue="none"
        />
        <Choice
          path="mediumResponse"
          label="Medium severity response"
          options={RESPONSES}
          defaultValue="warn"
        />
        <Choice
          path="highResponse"
          label="High severity response"
          options={RESPONSES}
          defaultValue="timeout"
        />
        <Duration path="mediumTimeout" label="Medium timeout" defaultValue="10m" />
        <Duration path="highTimeout" label="High timeout" defaultValue="1h" />
      </SectionCard>
    </>
  );
}

function DiscordArea({ config }: { config: AutomodConfig }): ReactElement {
  return (
    <>
      <SectionCard id="automod:discord" title="Enforced by Discord">
        <Tokens
          path="blockedWords"
          kind="string"
          label="Blocked words"
          help="Blocked by Discord before Proton ever sees them"
          maxItems={1000}
        />
        <Tokens path="allowedWords" kind="string" label="Allowed words" maxItems={100} />
        <Tokens
          path="presets"
          kind="enum"
          label="Discord word presets"
          options={['profanity', 'sexualContent', 'slurs']}
          maxItems={3}
        />
        <Num
          path="mentionLimit"
          label="Mention limit (Discord)"
          help="0 turns it off"
          min={0}
          max={50}
          defaultValue={0}
        />
        <Toggle path="nativeSpam" label="Discord spam filter" defaultValue={false} />
        <Tokens path="regexPatterns" kind="string" label="Regex patterns" maxItems={10} />
      </SectionCard>

      <SectionCard id="automod:panel:enforcement" title={null}>
        <EnforcementPanel config={config} />
      </SectionCard>
    </>
  );
}

function ExemptionsArea(): ReactElement {
  return (
    <SectionCard id="automod:exemptions" title="Exemptions">
      <Tokens path="exemptRoleIds" kind="role-id" label="Exempt roles" maxItems={20} />
      <Tokens path="exemptChannelIds" kind="channel-id" label="Exempt channels" maxItems={50} />
      <Toggle path="exemptBots" label="Exempt bots" defaultValue={true} />
    </SectionCard>
  );
}
