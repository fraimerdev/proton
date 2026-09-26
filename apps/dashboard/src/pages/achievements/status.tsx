import type { ModuleIndex } from '@proton/core';
import type { Achievement } from '@proton/module-achievements/config';
import {
  type DisplayStatus,
  displayStatus,
  type StatusView,
} from '@proton/module-achievements/evaluate';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { Badge } from '../../components/ui/controls.tsx';
import { modulesQuery } from '../../lib/queries.ts';
import { enabledModuleIds } from './shape.ts';

type Tone = 'neutral' | 'info' | 'success' | 'warning';

export const STATUS_LABELS: Record<DisplayStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  active: 'Active',
  paused: 'Paused',
  expired: 'Expired',
  archived: 'Archived',
};

export interface StatusContext {
  now: number;
  moduleEnabled: boolean;
  enabledModules: ReadonlySet<string>;
}

export function statusContext(index: ModuleIndex | undefined, now: number): StatusContext {
  const enabledModules = enabledModuleIds(index);
  return { now, moduleEnabled: enabledModules.has('achievements'), enabledModules };
}

export function useStatusContext(guildId: string): StatusContext {
  const { data } = useQuery(modulesQuery(guildId));
  const [now] = useState(() => Date.now());

  return statusContext(data, now);
}

export function statusOf(achievement: Achievement, context: StatusContext): StatusView {
  return displayStatus(achievement, context);
}

export function statusTone(view: StatusView): Tone {
  if (view.status === 'active') return 'success';
  if (view.status === 'scheduled') return 'info';
  if (view.status === 'paused' && (view.blockedBy?.length ?? 0) > 0) return 'warning';
  return 'neutral';
}

export function StatusBadge({ view }: { view: StatusView }): ReactElement {
  return (
    <span className="achievements-status">
      <Badge tone={statusTone(view)}>{STATUS_LABELS[view.status]}</Badge>
      {view.reason !== undefined ? (
        <span className="achievements-status-reason">{view.reason}</span>
      ) : null}
    </span>
  );
}

export function AchievementStatus({
  guildId,
  achievement,
}: {
  guildId: string;
  achievement: Achievement;
}): ReactElement {
  const context = useStatusContext(guildId);
  return <StatusBadge view={statusOf(achievement, context)} />;
}
