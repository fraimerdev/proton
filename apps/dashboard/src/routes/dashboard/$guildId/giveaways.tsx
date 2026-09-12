import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { Callout, SectionCard, SettingsGrid } from '../../../components/form/section.tsx';
import { useModuleForm } from '../../../components/module/form.ts';
import {
  ChannelField,
  Colour,
  Num,
  POSTABLE_CHANNEL_TYPES,
  Toggle,
  Tokens,
} from '../../../components/module/inputs.tsx';
import { ModuleChrome, ModuleSettings } from '../../../components/module/page.tsx';
import { moduleRoute } from '../../../components/module/route.tsx';
import { moduleState } from '../../../components/shell/module-meta.ts';

export const Route = createFileRoute('/dashboard/$guildId/giveaways')({
  ...moduleRoute('giveaways'),
  component: GiveawaysPage,
});

function GiveawaysPage(): ReactElement {
  const { guildId } = Route.useParams();
  const form = useModuleForm(guildId, 'giveaways');

  return (
    <>
      <ModuleChrome guildId={guildId} summary={form.summary} area={undefined} tabs={[]} />

      <ModuleSettings form={form}>
        <SettingsGrid>
          {moduleState(form.summary) === 'off' ? (
            <Callout>
              Giveaways is switched off. Everything here is saved, and no draw can be started until
              the switch above is on.
            </Callout>
          ) : null}

          {/* The question this page is opened with, answered as far as the dashboard can: every
              setting below is a default for objects it cannot read. */}
          <SectionCard id="giveaways:active" title="Active draws" span="full">
            <div className="empty-state">
              <span className="empty-state-title">
                Running draws are not readable from the dashboard yet
              </span>
              <p className="status">
                Proton keeps every draw — its prize, how many have entered, how many win and when it
                ends — in its own table, and there is no route from here to it. Ending, rerolling
                and cancelling stay with <span className="mono">/giveaway</span> in Discord.
                Everything below is the defaults a new draw starts from.
              </p>
            </div>
          </SectionCard>

          <SectionCard id="giveaways:general" title="General">
            <Num
              path="defaultWinnerCount"
              label="Default number of winners"
              min={1}
              max={50}
              defaultValue={1}
            />
            <Colour path="embedColor" label="Accent colour" />
            <ChannelField
              path="logChannelId"
              label="Warning channel"
              help={
                'Where Proton reports a reward role it could not grant, or a draw it ran without ' +
                'one of its requirements.'
              }
              channelTypes={POSTABLE_CHANNEL_TYPES}
              optional
            />
          </SectionCard>

          <SectionCard id="giveaways:results" title="When a giveaway ends">
            <Toggle
              path="announceInChannel"
              label="Announce the winners in the channel"
              defaultValue={true}
            />
            <Toggle path="dmWinners" label="Also DM the winners" defaultValue={false} />
            {/* Num, not Seconds: an unset optional value reads as 0 in the d/h/m/s control, and it
                draws an out-of-range error for a field nobody has filled in. */}
            <Num
              path="claimWindowSeconds"
              label="Claim window (seconds)"
              help="Unclaimed wins are forfeited and rerolled."
              min={60}
              max={604_800}
              optional
            />
          </SectionCard>

          <SectionCard id="giveaways:access" title="Who can enter and who can manage" span="full">
            <Tokens
              path="managerRoleIds"
              kind="role-id"
              label="Giveaway manager roles"
              help={
                'May pause, edit, end, cancel and reroll any giveaway, not only their own. ' +
                'Who may run each command at all is still set in the Permissions module.'
              }
              maxItems={25}
            />
            <Tokens
              path="bypassRoleIds"
              kind="role-id"
              label="Bypass roles"
              help="Skip every requirement on every giveaway. Multipliers still apply."
              maxItems={25}
            />
            <Tokens
              path="blacklistRoleIds"
              kind="role-id"
              label="Blacklisted roles"
              help="Cannot enter any giveaway here. Checked before any requirement is evaluated."
              maxItems={25}
            />
          </SectionCard>
        </SettingsGrid>
      </ModuleSettings>
    </>
  );
}
