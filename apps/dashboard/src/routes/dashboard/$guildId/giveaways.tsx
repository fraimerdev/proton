import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { SectionCard } from '../../../components/form/section.tsx';
import { useModuleForm } from '../../../components/module/form.ts';
import { ChannelField, Num, Toggle, Tokens } from '../../../components/module/inputs.tsx';
import { ModuleChrome, ModuleSettings } from '../../../components/module/page.tsx';
import { moduleRoute } from '../../../components/module/route.tsx';

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
        <SectionCard id="giveaways:general" title="General">
          <Num
            path="defaultWinnerCount"
            label="Default number of winners"
            min={1}
            max={50}
            defaultValue={1}
          />
          {/* Not a swatch: embedColor registers no field:'colour', so its control is a number. */}
          <Num
            path="embedColor"
            label="Accent colour"
            min={0}
            max={0xffffff}
            defaultValue={0x5865f2}
          />
        </SectionCard>

        <SectionCard id="giveaways:access" title="Who can enter and who can manage">
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

        <SectionCard id="giveaways:results" title="Results">
          <Toggle
            path="announceInChannel"
            label="Announce the winners in the channel"
            defaultValue={true}
          />
          <Toggle path="dmWinners" label="Also DM the winners" defaultValue={false} />
          <Num
            path="claimWindowSeconds"
            label="Claim window (seconds)"
            help="Unclaimed wins are forfeited and rerolled"
            min={60}
            max={604800}
            optional
          />
        </SectionCard>

        <SectionCard id="giveaways:logging" title="Logging">
          <ChannelField path="logChannelId" label="Giveaway warning channel" optional />
        </SectionCard>
      </ModuleSettings>
    </>
  );
}
