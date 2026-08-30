import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement, ReactNode } from 'react';
import { SectionCard } from '../../../components/form/section.tsx';
import { useModuleForm } from '../../../components/module/form.ts';
import { ChannelField, Choice, Duration, Num } from '../../../components/module/inputs.tsx';
import { ModuleChrome, ModuleSettings } from '../../../components/module/page.tsx';
import { moduleRoute } from '../../../components/module/route.tsx';

const AFTER_STRIP = ['none', 'kick', 'ban'] as const;

export const Route = createFileRoute('/dashboard/$guildId/antinuke')({
  ...moduleRoute('antinuke'),
  component: AntinukePage,
});

function AntinukePage(): ReactElement {
  const { guildId } = Route.useParams();
  const form = useModuleForm(guildId, 'antinuke');

  return (
    <>
      <ModuleChrome guildId={guildId} summary={form.summary} area={undefined} tabs={[]} />

      <ModuleSettings form={form}>
        <SectionCard id="antinuke:general" title="General">
          <Choice
            path="afterStrip"
            label="After stripping roles"
            help="Roles are stripped first whatever this is set to"
            options={AFTER_STRIP}
            defaultValue="none"
          />
          <ChannelField
            path="alertChannelId"
            label="Alert channel"
            channelTypes={[0, 5]}
            optional
          />
        </SectionCard>

        <SectionCard id="antinuke:thresholds" title="Thresholds">
          <Threshold id="channel" label="Channel deletion">
            <Num
              path="channelDeleteLimit"
              label="Channel deletions per member"
              min={2}
              max={100}
              defaultValue={3}
              param={{ label: 'Per member' }}
            />
            <Duration
              path="channelDeleteWindow"
              label="Channel deletion window"
              defaultValue="30s"
              param={{ label: 'Window' }}
            />
          </Threshold>

          <Threshold id="role" label="Role deletion">
            <Num
              path="roleDeleteLimit"
              label="Role deletions per member"
              min={2}
              max={100}
              defaultValue={3}
              param={{ label: 'Per member' }}
            />
            <Duration
              path="roleDeleteWindow"
              label="Role deletion window"
              defaultValue="30s"
              param={{ label: 'Window' }}
            />
          </Threshold>

          <Threshold id="webhook" label="Webhook deletion">
            <Num
              path="webhookDeleteLimit"
              label="Webhook deletions per member"
              min={2}
              max={100}
              defaultValue={5}
              param={{ label: 'Per member' }}
            />
            <Duration
              path="webhookDeleteWindow"
              label="Webhook deletion window"
              defaultValue="30s"
              param={{ label: 'Window' }}
            />
          </Threshold>

          <Threshold id="emoji" label="Emoji deletion">
            <Num
              path="emojiDeleteLimit"
              label="Emoji deletions per member"
              min={2}
              max={100}
              defaultValue={10}
              param={{ label: 'Per member' }}
            />
            <Duration
              path="emojiDeleteWindow"
              label="Emoji deletion window"
              defaultValue="1m"
              param={{ label: 'Window' }}
            />
          </Threshold>

          <Threshold id="member" label="Ban and kick">
            <Num
              path="memberRemoveLimit"
              label="Bans and kicks per moderator"
              min={2}
              max={100}
              defaultValue={5}
              param={{ label: 'Per moderator' }}
            />
            <Duration
              path="memberRemoveWindow"
              label="Ban and kick window"
              defaultValue="30s"
              param={{ label: 'Window' }}
            />
          </Threshold>
        </SectionCard>

        <SectionCard id="antinuke:maintenance" title="Maintenance mode">
          <Duration
            path="maintenanceMaxDuration"
            label="Longest maintenance window"
            help="Maintenance leaves the server unguarded for this long"
            defaultValue="1h"
          />
        </SectionCard>
      </ModuleSettings>
    </>
  );
}

// Not the seam's Rule: these pairs have no severity to head them, so the params sit in the head.
function Threshold({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="rule" data-rule={id}>
      <div className="rule-head">
        <span className="rule-label">{label}</span>
        <div className="rule-controls">{children}</div>
      </div>
    </div>
  );
}
