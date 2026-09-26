import type { ReactElement } from 'react';
import { RoleMultiPicker } from '../../components/discord/role-picker.tsx';
import { Switch } from '../../components/ui/controls.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import type { ModerationForm, Problems } from './punish-shape.ts';

const ROLES_MAX = 25;

const LISTS = [
  {
    key: 'global',
    title: 'Everything',
    description: 'Members with one of these roles can’t be banned, kicked, timed out or warned.',
  },
  { key: 'ban', title: 'Bans', description: 'Members with one of these roles can’t be banned.' },
  { key: 'kick', title: 'Kicks', description: 'Members with one of these roles can’t be kicked.' },
  {
    key: 'timeout',
    title: 'Timeouts',
    description: 'Members with one of these roles can’t be timed out.',
  },
  {
    key: 'warn',
    title: 'Warnings',
    description: 'Members with one of these roles can’t be warned.',
  },
] as const;

const HIERARCHY = 'Moderators can only punish members whose highest role is below their own.';

const HIERARCHY_HELP = 'The server owner can punish anyone, and nobody can punish the owner.';

const ROLES_INTRO = 'These apply to moderators, report automation and warn escalation.';

const AUTOMATIC_INTRO =
  'Moderators are ranked by role hierarchy. Report automation and warn escalation have no rank, ' +
  'so these roles still protect members from them.';

export function ImmunityArea({
  guildId,
  form,
  problems,
}: {
  guildId: string;
  form: ModerationForm;
  problems: Problems;
}): ReactElement {
  const immunity = form.value.punish.immunity;

  return (
    <>
      <Section>
        <Rows>
          <SettingRow
            title="Use role hierarchy"
            description={HIERARCHY}
            help={HIERARCHY_HELP}
            error={problems.at('punish.immunity.useHierarchy')}
          >
            <Switch
              label="Use role hierarchy"
              checked={immunity.useHierarchy}
              onChange={(next) => form.set('punish.immunity.useHierarchy', next)}
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section
        label={immunity.useHierarchy ? 'Automatic punishments' : 'Immune roles'}
        intro={immunity.useHierarchy ? AUTOMATIC_INTRO : ROLES_INTRO}
      >
        <Rows>
          {LISTS.map((list) => {
            const path = `punish.immunity.${list.key}`;
            const error = problems.at(path);

            return (
              <SettingRow
                key={list.key}
                stacked
                title={list.title}
                description={list.description}
                error={error}
              >
                <RoleMultiPicker
                  guildId={guildId}
                  label={`Add an immune role for ${list.title.toLowerCase()}`}
                  value={immunity[list.key]}
                  max={ROLES_MAX}
                  invalid={error !== undefined}
                  onChange={(next) => form.set(path, next)}
                />
              </SettingRow>
            );
          })}
        </Rows>
      </Section>
    </>
  );
}
