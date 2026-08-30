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
import { SectionCard } from '../../../components/form/section.tsx';
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
import { AreaHub, ModuleChrome, ModuleSettings } from '../../../components/module/page.tsx';
import { moduleRoute } from '../../../components/module/route.tsx';

const HoneypotChannelsEditor = lazyRouteComponent(
  () => import('../../../components/honeypot/channels.tsx'),
  'HoneypotChannelsEditor',
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
    preload: [HoneypotChannelsEditor, AuthoredLayout, AppealPicker],
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
      <ModuleChrome guildId={guildId} summary={form.summary} area={area} tabs={[]} />

      {area === undefined ? (
        <AreaHub areas={AREAS} config={form.config} />
      ) : (
        <ModuleSettings form={form}>
          {area.id === 'bait' ? <BaitArea form={form} /> : null}
          {area.id === 'camouflage' ? <CamouflageArea /> : null}
          {area.id === 'action' ? <ActionArea form={form} /> : null}
          {area.id === 'exemptions' ? <ExemptionsArea /> : null}
          {area.id === 'notice' ? <NoticeArea form={form} /> : null}
          {area.id === 'dm' ? <DirectMessageArea form={form} /> : null}
          {area.id === 'escalation' ? <EscalationArea /> : null}
        </ModuleSettings>
      )}
    </>
  );
}

function BaitArea({ form }: { form: ModuleForm }): ReactElement {
  const honeypots = form.value('channels', []) as HoneypotChannel[];
  usePanelSchema('channels', 'Bait channels', honeypotChannelsSchema, honeypots);

  return (
    <>
      <SectionCard id="honeypot:bait" title="Bait channels">
        <Toggle
          path="includeThreads"
          label="Threads count too"
          help="A thread under a bait channel is part of the trap"
          defaultValue={true}
        />
      </SectionCard>

      <SectionCard id="honeypot:panel:channels" title="The channels">
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

function CamouflageArea(): ReactElement {
  return (
    <SectionCard id="honeypot:camouflage" title="Camouflage">
      <Toggle
        path="keepChannelActive"
        label="Keep the channel active"
        help="Posts something once a day so the channel does not read as abandoned"
        defaultValue={false}
      />
      <Toggle
        path="renameChannelDaily"
        label="Rename the channel daily"
        help="Rotates the bait channel’s name once a day"
        defaultValue={false}
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
    <SectionCard id="honeypot:action" title="What happens">
      <Choice
        path="action"
        label="What happens to them"
        options={ACTIONS}
        optionLabels={ACTION_LABELS}
        defaultValue="softban"
      />
      <Toggle
        path="timeoutFirst"
        label="Time them out first"
        help="Silences them before the action lands, so a burst stops immediately"
        defaultValue={false}
      />
      <Duration path="timeoutFirstDuration" label="Held for" defaultValue="5m" />
      <Duration path="timeoutDuration" label="Timed out for" defaultValue="1h" />
      <Seconds
        path="deleteMessageSeconds"
        label="Messages to wipe"
        help="How far back their messages are deleted. Only a softban or a ban can do this"
        min={0}
        max={604_800}
        defaultValue={604_800}
      />
      <AppealPicker
        guildId={form.guildId}
        value={form.value('appealPanelId', undefined) as string | undefined}
        onChange={(next) => form.set('appealPanelId', next)}
      />
      <Seconds
        path="waitBeforeActingSeconds"
        label="Wait before acting"
        help="Leave at zero to act immediately. Proton checks for due work every 15 seconds"
        min={0}
        max={604_800}
        defaultValue={0}
      />
      <Text
        path="auditLogReason"
        label="Audit log reason"
        help="What Discord’s own audit log records against the action"
        maxLength={512}
        defaultValue={DEFAULT_AUDIT_REASON}
      />
      <Toggle path="deleteTriggerMessage" label="Delete their message" defaultValue={true} />
    </SectionCard>
  );
}

function ExemptionsArea(): ReactElement {
  return (
    <SectionCard id="honeypot:exemptions" title="Who is exempt">
      <p className="field-description">
        Catches from these are logged and counted, but nothing is done to the account.
      </p>
      <Toggle
        path="exemptAdministrators"
        label="Exempt administrators"
        help="Anyone holding Administrator is caught and counted, but not acted on"
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
    <>
      <SectionCard id="honeypot:notice" title="The warning message">
        <p className="field-description">
          The notice posted in every bait channel, so a member who wanders in knows to leave it
          alone.
        </p>
        <Toggle path="postNotice" label="Post the warning" defaultValue={true} />
        <Toggle
          path="noticeCounterButton"
          label="Counter button"
          help="Shows the live number this trap has caught"
          defaultValue={true}
        />
        <Toggle
          path="hideWhatIsAHoneypot"
          label="Hide what is a honeypot"
          help="Warns members off without saying the channel is a trap"
          defaultValue={false}
        />
      </SectionCard>

      <SectionCard id="honeypot:panel:noticeLayout" title="What it says">
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
    </>
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
      <SectionCard id="honeypot:dm" title="The direct message">
        <p className="field-description">
          What the caught account is told, sent just before the action lands — after a ban there is
          no shared server left to send it through.
        </p>
        <Toggle path="sendDirectMessage" label="Send a direct message" defaultValue={true} />
        <Toggle path="offerWayBackIn" label="Offer a way back in" defaultValue={false} />
        <Text
          path="inviteUrl"
          label="Invite link"
          help="Where the way back in points. Proton cannot mint one for you"
          maxLength={512}
          optional
        />
      </SectionCard>

      <SectionCard id="honeypot:panel:dmLayout" title="What it says">
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
        help="A blocked account cannot pass verification until a moderator lifts it"
        defaultValue={false}
      />
      <Toggle
        path="quoteMessage"
        label="Quote the message"
        help="Puts what they posted in the incident log"
        defaultValue={false}
      />
      <ChannelField
        path="logChannelId"
        label="Log channel"
        help="Where Proton reports every trap it springs"
        channelTypes={[0, 5, 11, 12]}
        optional
      />
    </SectionCard>
  );
}
