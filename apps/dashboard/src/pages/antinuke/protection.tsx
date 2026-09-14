import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { MemberCell, MemberProvider } from '../../components/discord/member.tsx';
import { Button } from '../../components/ui/controls.tsx';
import { LoadingArea, StatusBanner } from '../../components/ui/feedback.tsx';
import { readFailure, saveFailure } from '../../lib/errors.ts';
import { maintenanceQuery } from '../../lib/queries.ts';
import { queryKeys } from '../../lib/query-keys.ts';
import { endAntinukeMaintenance } from '../../server/modules.ts';

function remaining(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return 'less than a minute';

  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0
    ? `${hours} hour${hours === 1 ? '' : 's'}`
    : `${hours} hour${hours === 1 ? '' : 's'} ${rest} minute${rest === 1 ? '' : 's'}`;
}

/**
 * Whether the breaker is armed right now. The window expires on a clock rather than on a write,
 * so the countdown ticks locally between the poll intervals — a page that still says "suspended"
 * after the window closed is worse than one that says nothing.
 */
export function ProtectionState({
  guildId,
  enabled,
}: {
  guildId: string;
  enabled: boolean;
}): ReactElement | null {
  const queryClient = useQueryClient();
  const { data, error, isPending } = useQuery(maintenanceQuery(guildId));
  const [now, setNow] = useState(() => Date.now());
  const [failure, setFailure] = useState<string | null>(null);

  const window_ = data?.window ?? null;

  useEffect(() => {
    if (!window_) return;

    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [window_]);

  const end = useMutation({
    mutationFn: () => endAntinukeMaintenance({ data: { guildId } }),
    onSuccess: () => {
      setFailure(null);
      void queryClient.invalidateQueries({
        queryKey: [...queryKeys.guild(guildId), 'antinuke', 'maintenance'],
      });
    },
    onError: (thrown: Error) => setFailure(saveFailure(thrown, 'Maintenance mode was not ended')),
  });

  if (isPending) {
    // Switched off, the answer is almost always nothing, so a reserved slot would collapse on every load.
    return enabled ? (
      <LoadingArea label="Loading protection status" minHeight={70} size="sm" />
    ) : null;
  }

  // A read that failed is not "protection on". The page says it could not ask.
  if (error) {
    return (
      <StatusBanner tone="neutral" icon="warning">
        {readFailure(error, 'whether protection is suspended')}
      </StatusBanner>
    );
  }

  if (!window_ || window_.expiresAt <= now) {
    return enabled ? (
      <StatusBanner tone="success" icon="shield-check" title="Protection on">
        Maintenance mode is off.
      </StatusBanner>
    ) : null;
  }

  return (
    <MemberProvider guildId={guildId} userIds={[window_.enabledBy]}>
      <StatusBanner
        tone="warning"
        icon="siren"
        title="Protection suspended"
        actions={
          <Button tone="secondary" size="sm" busy={end.isPending} onClick={() => end.mutate()}>
            End maintenance mode
          </Button>
        }
      >
        <div className="stack stack-4">
          <span>
            Maintenance mode ends in {remaining(window_.expiresAt, now)}. Until then Proton will not
            act on mass deletions.
          </span>
          <span className="inline inline-6 text-xs">
            Started by <MemberCell userId={window_.enabledBy} />
            {window_.reason ? ` — ${window_.reason}` : ''}
          </span>
        </div>
      </StatusBanner>

      {failure !== null ? (
        <StatusBanner tone="danger" live="assertive" onDismiss={() => setFailure(null)}>
          {failure}
        </StatusBanner>
      ) : null}
    </MemberProvider>
  );
}
