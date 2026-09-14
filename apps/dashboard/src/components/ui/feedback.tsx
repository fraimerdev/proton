import { type ReactElement, type ReactNode, Suspense, useEffect, useId, useState } from 'react';
import { cx } from './controls.tsx';
import { Icon, type IconName } from './icon.tsx';

export type BannerTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const BANNER_ICON: Record<BannerTone, IconName> = {
  neutral: 'info',
  info: 'info',
  success: 'check',
  warning: 'warning',
  danger: 'warning-circle',
};

interface StatusBannerProps {
  tone?: BannerTone | undefined;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  icon?: IconName | undefined;
  onDismiss?: (() => void) | undefined;
  live?: 'assertive' | 'polite' | undefined;
}

export function StatusBanner({
  tone = 'neutral',
  title,
  children,
  actions,
  icon,
  onDismiss,
  live,
}: StatusBannerProps): ReactElement {
  return (
    <div
      className={cx('banner', tone !== 'neutral' && `banner-${tone}`)}
      role={live === 'assertive' ? 'alert' : undefined}
      aria-live={live}
    >
      <Icon name={icon ?? BANNER_ICON[tone]} size={16} weight="fill" className="banner-icon" />
      <div className="banner-main">
        {title !== undefined ? <div className="banner-title">{title}</div> : null}
        {children !== undefined ? <div className="banner-body">{children}</div> : null}
      </div>
      {actions !== undefined ? <div className="banner-actions">{actions}</div> : null}
      {onDismiss ? (
        <button type="button" className="banner-dismiss" aria-label="Dismiss" onClick={onDismiss}>
          <Icon name="x" size={13} weight="fill" />
        </button>
      ) : null}
    </div>
  );
}

interface EmptyStateProps {
  icon?: IconName | undefined;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  inset?: boolean | undefined;
}

export function EmptyState({
  icon,
  title,
  children,
  actions,
  inset = false,
}: EmptyStateProps): ReactElement {
  return (
    <div className={cx('empty', inset && 'inset')}>
      {icon ? <Icon name={icon} size={26} className="empty-icon" /> : null}
      <p className="empty-title">{title}</p>
      {children !== undefined ? <p className="empty-body">{children}</p> : null}
      {actions !== undefined ? <div className="empty-actions">{actions}</div> : null}
    </div>
  );
}

// Proton accepts a request before Discord takes it, so a Post button must not claim "Posted".
export type AsyncPhase = 'idle' | 'requested' | 'working' | 'completed' | 'failed';

export function AsyncOperationStatus({
  phase,
  requestedLabel = 'Asked Proton to post it. Check the channel in Discord to confirm it appeared.',
  workingLabel = 'Posting…',
  completedLabel = 'Posted',
  failedLabel,
}: {
  phase: AsyncPhase;
  requestedLabel?: string | undefined;
  workingLabel?: string | undefined;
  completedLabel?: string | undefined;
  failedLabel?: string | undefined;
}): ReactElement | null {
  if (phase === 'idle') return null;

  const labels: Record<Exclude<AsyncPhase, 'idle'>, string> = {
    requested: requestedLabel,
    working: workingLabel,
    completed: completedLabel,
    failed: failedLabel ?? 'Not posted',
  };

  // One live region for every phase: a role or aria-live added to a reused node goes unannounced.
  return (
    <span
      className={cx('async-status', phase === 'requested' ? 'working' : phase)}
      aria-live="polite"
    >
      {phase === 'failed' ? (
        <Icon name="warning-circle" size={14} weight="fill" className="motion-fade" />
      ) : phase === 'completed' ? (
        <Icon name="check" size={14} weight="fill" className="motion-pop" />
      ) : (
        <Icon name="circle-notch" size={14} className="button-spin" />
      )}
      <span key={phase} className="motion-fade" role={phase === 'failed' ? 'alert' : undefined}>
        {labels[phase]}
      </span>
    </span>
  );
}

export type SpinnerSize = 'sm' | 'md' | 'lg';

const SPINNER_PX: Record<SpinnerSize, number> = { sm: 14, md: 18, lg: 28 };

// Kept equal to --loading-delay and --loading-delay-fallback, or AT hears a load nobody saw.
const REVEAL_MS = 180;
const FALLBACK_REVEAL_MS = 350;

function useElapsed(ms: number | null): boolean {
  const [elapsed, setElapsed] = useState(false);

  useEffect(() => {
    if (ms === null) return;

    const timer = window.setTimeout(() => setElapsed(true), ms);
    return () => window.clearTimeout(timer);
  }, [ms]);

  return elapsed;
}

interface SpinnerProps {
  label?: string | undefined;
  showLabel?: boolean | undefined;
  size?: SpinnerSize | undefined;
  fallback?: boolean | undefined;
  status?: boolean | undefined;
}

export function Spinner({
  label = 'Loading',
  showLabel = false,
  size = 'sm',
  fallback = false,
  status = false,
}: SpinnerProps): ReactElement {
  const id = useId();
  const revealed = useElapsed(status ? (fallback ? FALLBACK_REVEAL_MS : REVEAL_MS) : null);

  const text = (
    <span id={id} className={showLabel ? undefined : 'visually-hidden'}>
      {label}
    </span>
  );

  if (!status) {
    return (
      <span className={cx('spinner', fallback && 'spinner-fallback')}>
        <Icon name="circle-notch" size={SPINNER_PX[size]} className="spinner-icon" />
        {text}
      </span>
    );
  }

  return (
    <span
      className={cx('spinner', fallback && 'spinner-fallback')}
      role="status"
      aria-labelledby={revealed ? id : undefined}
    >
      <Icon name="circle-notch" size={SPINNER_PX[size]} className="spinner-icon" />
      {revealed ? text : null}
    </span>
  );
}

interface LoadingAreaProps {
  label?: string | undefined;
  minHeight?: number | string | undefined;
  size?: SpinnerSize | undefined;
  fallback?: boolean | undefined;
  fill?: boolean | undefined;
}

export function LoadingArea({
  label,
  minHeight,
  size = 'md',
  fallback = false,
  fill = false,
}: LoadingAreaProps): ReactElement {
  return (
    <div
      className={cx('loading-area', fill && 'loading-area-fill')}
      style={minHeight === undefined ? undefined : { minHeight }}
    >
      <Spinner label={label} size={size} fallback={fallback} status />
    </div>
  );
}

export function LoadingBoundary({
  label,
  minHeight,
  children,
}: {
  label?: string | undefined;
  minHeight?: number | string | undefined;
  children: ReactNode;
}): ReactElement {
  return (
    <Suspense
      fallback={<LoadingArea label={label} minHeight={minHeight} size="lg" fill fallback />}
    >
      {children}
    </Suspense>
  );
}
