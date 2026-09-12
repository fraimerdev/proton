import {
  DEFAULT_AUDIT_REASON,
  DEFAULT_DM_MESSAGE,
  DEFAULT_NOTICE_MESSAGE,
  type HoneypotAction,
  type HoneypotChannel,
  honeypotChannelsSchema,
  honeypotLayoutSchema,
} from '@proton/module-honeypot/config';
import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { BooleanGroupFieldInput } from '../../../components/form/fields.tsx';
import { Callout, SectionCard, SettingsGrid } from '../../../components/form/section.tsx';
import { HONEYPOT_AREAS as AREAS } from '../../../components/module/area-index.ts';
import { activeArea } from '../../../components/module/areas.ts';
import type { ModuleForm } from '../../../components/module/form.ts';
import { useModuleForm } from '../../../components/module/form.ts';
import {
  ChannelField,
  Choice,
  Duration,
  RoleField,
  Seconds,
  Text,
  Toggle,
  Tokens,
  usePanelSchema,
} from '../../../components/module/inputs.tsx';
import { ModuleChrome, ModuleSettings, tabsFor } from '../../../components/module/page.tsx';
import { moduleRoute } from '../../../components/module/route.tsx';
import { moduleState } from '../../../components/shell/module-meta.ts';

const HoneypotChannelsEditor = lazyRouteComponent(
  () => import('../../../components/honeypot/channels.tsx'),
  'HoneypotChannelsEditor',
);

const HoneypotActivity = lazyRouteComponent(
  () => import('../../../components/honeypot/activity.tsx'),
  'HoneypotActivity',
);

const AppealPicker = lazyRouteComponent(
  () => import('../../../components/honeypot/appeal-picker.tsx'),
  'AppealPicker',
);

const AuthoredLayout = lazyRouteComponent(
  () => import('../../../components/honeypot/authored.tsx'),
  'AuthoredLayout',
);

export const Route = createFileRoute('/dashboard/$guildId/honeypot')({
  ...moduleRoute('honeypot', {
    areas: AREAS,
    preload: [HoneypotChannelsEditor, HoneypotActivity, AuthoredLayout, AppealPicker],
  }),
  component: HoneypotPage,
});

function HoneypotPage(): ReactElement {
  const { guildId } = Route.useParams();
  const search = Route.useSearch();
  const form = useModuleForm(guildId, 'honeypot', true);

  const area = activeArea(AREAS, search.area);

  return (
    <>
      <ModuleChrome
        guildId={guildId}
        summary={form.summary}
        area={area}
        tabs={tabsFor([], search.view, area?.id, AREAS)}
      />

      <ModuleSettings form={form}>
        {/* One grid for every face, so a callout and a card are siblings rather than a card holding
            a card. The area components below contribute grid children, never their own grid. */}
        <SettingsGrid>
          {moduleState(form.summary) === 'off' ? (
            <Callout>
              Honeypot is switched off. Everything here is saved, and no bait channel traps anybody
              until the switch above is on.
            </Callout>
          ) : null}

          {area?.id === 'bait' ? <BaitArea form={form} /> : null}
          {area?.id === 'camouflage' ? <CamouflageArea form={form} /> : null}
          {area?.id === 'action' ? <ActionArea form={form} /> : null}
          {area?.id === 'exemptions' ? <ExemptionsArea /> : null}
          {area?.id === 'notice' ? <NoticeArea form={form} /> : null}
          {area?.id === 'dm' ? <DirectMessageArea form={form} /> : null}
          {area?.id === 'escalation' ? <EscalationArea /> : null}
        </SettingsGrid>
      </ModuleSettings>
    </>
  );
}

function BaitArea({ form }: { form: ModuleForm }): ReactElement {
  const honeypots = form.value('channels', []) as HoneypotChannel[];
  usePanelSchema('channels', 'Bait channels', honeypotChannelsSchema, honeypots);

  const armed = honeypots.filter(
    (honeypot) => honeypot.enabled && (honeypot.channelId ?? '') !== '',
  ).length;

  return (
    <>
      {honeypots.length === 0 ? (
        <Callout>
          No bait channel yet. The order is: pick a channel nobody has a reason to post in, arm it,
          then decide under “What happens” what is done to whoever posts.
        </Callout>
      ) : (
        <SectionCard id="honeypot:activity" title="Activity" span="full">
          <HoneypotActivity
            guildId={form.guildId}
            armed={armed}
            waitSeconds={form.value('waitBeforeActingSeconds', 0) as number}
          />
        </SectionCard>
      )}

      {/* Beside the catches, not a page away: whether a channel is armed is the first thing a
          reader asks of the feed above it. */}
      <SectionCard id="honeypot:bait" title="Bait channels" span="full">
        <Toggle
          path="includeThreads"
          label="Threads count too"
          help="A thread under a bait channel is part of the trap."
          defaultValue={true}
        />
        <HoneypotChannelsEditor
          honeypots={honeypots}
          channels={form.channels}
          tier={form.tier}
          action={form.value('action', 'softban') as HoneypotAction}
          deleteMessageSeconds={form.value('deleteMessageSeconds', 604_800) as number}
          onChange={(next) => form.set('channels', next)}
        />
      </SectionCard>
    </>
  );
}

function CamouflageArea({ form }: { form: ModuleForm }): ReactElement {
  return (
    <SectionCard id="honeypot:camouflage" title="Camouflage">
      <BooleanGroupFieldInput
        label="Daily jobs"
        description="Both run once a day, on the bait channels that are armed."
        toggles={[
          {
            path: 'keepChannelActive',
            label: 'Post something',
            value: form.value('keepChannelActive', undefined) === true,
            onChange: (next) => form.set('keepChannelActive', next),
          },
          {
            path: 'renameChannelDaily',
            label: 'Rotate the name',
            value: form.value('renameChannelDaily', undefined) === true,
            onChange: (next) => form.set('renameChannelDaily', next),
          },
        ]}
      />
    </SectionCard>
  );
}

const NOTICE_PLACEHOLDERS = ['{consequence}', '{purge}'] as const;

const DM_PLACEHOLDERS = ['{server}', '{action}'] as const;

const ACTIONS = ['softban', 'ban', 'kick', 'timeout', 'warn', 'none'] as const;

const ACTION_LABELS: Record<HoneypotAction, string> = {
  softban: 'Softban — remove them and delete what they posted',
  ban: 'Ban',
  kick: 'Kick',
  timeout: 'Timeout',
  warn: 'Warn',
  none: 'Log it and do nothing else',
};

function ActionArea({ form }: { form: ModuleForm }): ReactElement {
  return (
    <>
      <Callout tone="warn">
        Only a softban or a ban can wipe what they posted — Discord takes a deletion window on a ban
        and nowhere else. Kick, timeout and warn can still delete the one message that sprang the
        trap.
      </Callout>

      <SectionCard id="honeypot:action" title="The action">
        <Choice
          path="action"
          label="What happens to them"
          options={ACTIONS}
          optionLabels={ACTION_LABELS}
          defaultValue="softban"
        />
        <Duration path="timeoutDuration" label="Timed out for" defaultValue="1h" />
        <Toggle path="deleteTriggerMessage" label="Delete their message" defaultValue={true} />
        <Seconds
          path="deleteMessageSeconds"
          label="Messages to wipe"
          help="How far back their messages are deleted."
          min={0}
          max={604_800}
          defaultValue={604_800}
        />
      </SectionCard>

      <SectionCard id="honeypot:action:timing" title="When it lands">
        <Toggle
          path="timeoutFirst"
          label="Time them out first"
          help="Silences them before the action lands, so a burst stops immediately."
          defaultValue={false}
        />
        <Duration path="timeoutFirstDuration" label="Held for" defaultValue="5m" />
        <Seconds
          path="waitBeforeActingSeconds"
          label="Wait before acting"
          help="Leave at zero to act immediately. Proton checks for due work every 15 seconds."
          min={0}
          max={604_800}
          defaultValue={0}
        />
      </SectionCard>

      <SectionCard id="honeypot:action:record" title="Record and appeal" span="full">
        <Text
          path="auditLogReason"
          label="Audit log reason"
          help="What Discord’s own audit log records against the action."
          maxLength={512}
          defaultValue={DEFAULT_AUDIT_REASON}
        />
        <AppealPicker
          guildId={form.guildId}
          value={form.value('appealPanelId', undefined) as string | undefined}
          onChange={(next) => form.set('appealPanelId', next)}
        />
      </SectionCard>
    </>
  );
}

function ExemptionsArea(): ReactElement {
  return (
    <SectionCard id="honeypot:exemptions" title="Who is exempt" span="full">
      <Toggle
        path="exemptAdministrators"
        label="Exempt administrators"
        help="Anyone holding Administrator is caught and counted, but not acted on."
        defaultValue={true}
      />
      <RoleField path="exemptAdminRoleId" label="Exempt admin role" optional />
      <Tokens path="exemptRoleIds" label="Exempt roles" kind="role-id" maxItems={50} />
    </SectionCard>
  );
}

function NoticeArea({ form }: { form: ModuleForm }): ReactElement {
  usePanelSchema(
    'noticeLayout',
    'The warning message',
    honeypotLayoutSchema,
    form.value('noticeLayout', DEFAULT_NOTICE_MESSAGE),
  );

  return (
    <SectionCard id="honeypot:panel:noticeLayout" title="The warning message" span="full">
      <BooleanGroupFieldInput
        label="The notice"
        description="The counter button shows the live number this trap has caught. Hiding the explanation warns members off without saying the channel is a trap."
        toggles={[
          {
            path: 'postNotice',
            label: 'Post the warning',
            value: form.value('postNotice', undefined) !== false,
            onChange: (next) => form.set('postNotice', next),
          },
          {
            path: 'noticeCounterButton',
            label: 'Counter button',
            value: form.value('noticeCounterButton', undefined) !== false,
            onChange: (next) => form.set('noticeCounterButton', next),
          },
          {
            path: 'hideWhatIsAHoneypot',
            label: 'Hide the explanation',
            value: form.value('hideWhatIsAHoneypot', undefined) === true,
            onChange: (next) => form.set('hideWhatIsAHoneypot', next),
          },
        ]}
      />
      <AuthoredLayout
        message={form.value('noticeLayout', DEFAULT_NOTICE_MESSAGE)}
        onChange={(next) => form.set('noticeLayout', next)}
        channels={form.channels}
        roles={form.roles}
        tier={form.tier}
        description="Posted into every armed bait channel, and kept in step with your settings on every save."
        placeholders={NOTICE_PLACEHOLDERS}
        adds="Proton adds the counter button itself when that switch is on."
      />
    </SectionCard>
  );
}

function DirectMessageArea({ form }: { form: ModuleForm }): ReactElement {
  usePanelSchema(
    'dmLayout',
    'The direct message',
    honeypotLayoutSchema,
    form.value('dmLayout', DEFAULT_DM_MESSAGE),
  );

  return (
    <>
      <SectionCard id="honeypot:dm" title="Sending it">
        <Toggle path="sendDirectMessage" label="Send a direct message" defaultValue={true} />
        <Toggle path="offerWayBackIn" label="Offer a way back in" defaultValue={false} />
        <Text
          path="inviteUrl"
          label="Invite link"
          help="Where the way back in points. Proton cannot mint one for you."
          maxLength={512}
          optional
        />
      </SectionCard>

      <SectionCard id="honeypot:panel:dmLayout" title="The direct message" span="full">
        <AuthoredLayout
          message={form.value('dmLayout', DEFAULT_DM_MESSAGE)}
          onChange={(next) => form.set('dmLayout', next)}
          channels={form.channels}
          roles={form.roles}
          tier={form.tier}
          description="Sent just before the action lands — after a ban there is no shared server left to send it through."
          placeholders={DM_PLACEHOLDERS}
          adds="Proton adds the recovery advice, the appeal link and the way back in itself."
        />
      </SectionCard>
    </>
  );
}

function EscalationArea(): ReactElement {
  return (
    <SectionCard id="honeypot:escalation" title="Escalation and logging">
      <Toggle
        path="addToBlacklist"
        label="Add them to the blacklist"
        help="A blocked account cannot pass verification until a moderator lifts it."
        defaultValue={false}
      />
      <Toggle
        path="quoteMessage"
        label="Quote the message"
        help="Puts what they posted in the incident log."
        defaultValue={false}
      />
      <ChannelField
        path="logChannelId"
        label="Log channel"
        help="Where Proton reports every trap it springs."
        channelTypes={[0, 5, 11, 12]}
        optional
      />
    </SectionCard>
  );
}
