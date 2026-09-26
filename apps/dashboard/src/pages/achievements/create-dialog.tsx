import type { Achievement, AchievementKind } from '@proton/module-achievements/config';
import { PRESETS, type PresetDefinition } from '@proton/module-achievements/presets';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { RolePicker } from '../../components/discord/role-picker.tsx';
import { CollectionButtonRow } from '../../components/ui/collection.tsx';
import { Badge, Button } from '../../components/ui/controls.tsx';
import { Rows } from '../../components/ui/layout.tsx';
import { Dialog } from '../../components/ui/overlay.tsx';
import { modulesQuery } from '../../lib/queries.ts';
import {
  createFromPreset,
  type DependencyState,
  dependencyNote,
  newAchievement,
  presetDependencyStates,
} from './shape.ts';

const TITLE = 'New achievement';

const ROLE_STEP = 'Pick the role members get when they earn it. You can change it later.';

const ROLE_NEXT = 'You pick the role it gives next.';

const ROLE_NOTE = 'Proton needs Manage Roles, and its highest role must be above this one.';

const FROM_SCRATCH: readonly { kind: AchievementKind; title: string; body: string }[] = [
  {
    kind: 'single',
    title: 'Single',
    body: 'One badge for reaching a target. Up to 3 requirements, and members need all of them.',
  },
  {
    kind: 'tiered',
    title: 'Tiered',
    body: 'Bronze, Silver and Gold on one requirement, each with a higher target. You can add Diamond.',
  },
];

function DependencyLine({ states }: { states: readonly DependencyState[] }): ReactElement | null {
  const off = dependencyNote(states);
  return off === null ? null : <span className="text-warning">{off}</span>;
}

export function CreateAchievementDialog({
  guildId,
  open,
  taken,
  onClose,
  onCreate,
}: {
  guildId: string;
  open: boolean;
  taken: readonly string[];
  onClose: () => void;
  onCreate: (achievement: Achievement) => void;
}): ReactElement | null {
  const modules = useQuery({ ...modulesQuery(guildId), enabled: open });
  const [preset, setPreset] = useState<PresetDefinition | null>(null);
  const [roleId, setRoleId] = useState<string | null>(null);
  const [stepped, setStepped] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  const body = useRef<HTMLDivElement>(null);

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setPreset(null);
      setRoleId(null);
      setStepped(0);
    }
  }

  // Dialog moves focus only when it opens; a step change has to move it itself.
  useEffect(() => {
    if (stepped === 0) return;
    body.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
  }, [stepped]);

  const step = (next: PresetDefinition | null): void => {
    setPreset(next);
    setRoleId(null);
    setStepped((count) => count + 1);
  };

  const choose = (chosen: PresetDefinition): void => {
    if (chosen.needsRole) {
      step(chosen);
      return;
    }
    onCreate(createFromPreset(chosen.id, { taken }));
  };

  if (preset !== null) {
    const off = dependencyNote(presetDependencyStates(preset.id, modules.data));

    return (
      <Dialog
        open={open}
        onClose={onClose}
        title={`${preset.label}: reward role`}
        description={ROLE_STEP}
        size="medium"
        icon="trophy"
        footer={
          <>
            <Button onClick={() => step(null)}>Back</Button>
            <Button
              tone="primary"
              disabled={roleId === null}
              onClick={() => {
                if (roleId === null) return;
                onCreate(createFromPreset(preset.id, { taken, roleId }));
              }}
            >
              Create achievement
            </Button>
          </>
        }
      >
        <div ref={body} className="field">
          <span className="field-label">Reward role</span>
          <RolePicker
            guildId={guildId}
            label="Reward role"
            allowNone={false}
            requireAssignable
            value={roleId}
            onChange={setRoleId}
          />
          <span className="field-hint">{ROLE_NOTE}</span>
        </div>

        {off !== null ? <p className="text-sm text-warning">{off}</p> : null}
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onClose={onClose} title={TITLE} size="medium" icon="trophy">
      <div ref={body} className="stack stack-16">
        <div className="stack stack-8">
          <p className="section-label">Start from scratch</p>
          <Rows>
            {FROM_SCRATCH.map((choice) => (
              <CollectionButtonRow
                key={choice.kind}
                icon={choice.kind === 'tiered' ? 'stairs' : 'trophy'}
                title={choice.title}
                meta={choice.body}
                onSelect={() => onCreate(newAchievement(choice.kind, taken))}
              />
            ))}
          </Rows>
        </div>

        <div className="stack stack-8">
          <p className="section-label">Presets</p>
          <Rows>
            {PRESETS.map((choice) => (
              <CollectionButtonRow
                key={choice.id}
                title={choice.label}
                badge={
                  <Badge tone="neutral">{choice.kind === 'tiered' ? 'Tiered' : 'Single'}</Badge>
                }
                meta={
                  <>
                    <span>{choice.description}</span>
                    <DependencyLine states={presetDependencyStates(choice.id, modules.data)} />
                    {choice.needsRole ? <span>{ROLE_NEXT}</span> : null}
                  </>
                }
                onSelect={() => choose(choice)}
              />
            ))}
          </Rows>
        </div>
      </div>
    </Dialog>
  );
}
