import type { ReactElement } from 'react';
import type { AreaMeta } from '../../lib/modules/catalogue.ts';
import { ModuleLink } from '../module/route.tsx';
import { cx, useSlidingIndicator } from './controls.tsx';
import { Icon, type IconName } from './icon.tsx';

export function AreaTabs({
  guildId,
  moduleId,
  areas,
  current,
  counts,
}: {
  guildId: string;
  moduleId: string;
  areas: readonly AreaMeta[];
  current: string;
  counts?: Readonly<Record<string, number | string | undefined>> | undefined;
}): ReactElement {
  const { track, indicator } = useSlidingIndicator<HTMLElement>(
    areas.findIndex((area) => area.id === current),
    areas.map((area) => area.id).join(' '),
  );

  return (
    <nav ref={track} className="area-tabs" aria-label="Sections">
      {areas.map((area) => {
        const count = counts?.[area.id];

        return (
          <ModuleLink
            key={area.id}
            guildId={guildId}
            moduleId={moduleId}
            search={{ area: area.id }}
            className="area-tab"
            aria-current={area.id === current ? 'page' : undefined}
          >
            {area.label}
            {count !== undefined ? <span className="area-tab-count">{count}</span> : null}
          </ModuleLink>
        );
      })}
      <span ref={indicator} className="area-tabs-indicator" aria-hidden />
    </nav>
  );
}

export function SegmentedTabs<T extends string>({
  items,
  value,
  onChange,
  label,
  className,
}: {
  items: readonly { id: T; label: string; icon?: IconName | undefined }[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  className?: string | undefined;
}): ReactElement {
  const { track, indicator } = useSlidingIndicator<HTMLDivElement>(
    items.findIndex((item) => item.id === value),
    items.map((item) => item.id).join(' '),
  );

  return (
    <div ref={track} role="tablist" aria-label={label} className={cx('segmented', className)}>
      <span ref={indicator} className="segmented-thumb" aria-hidden />
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={item.id === value}
          className="segmented-option"
          onClick={() => onChange(item.id)}
        >
          {item.icon ? <Icon name={item.icon} size={14} /> : null}
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function SegmentedTabLinks({
  guildId,
  moduleId,
  areas,
  current,
}: {
  guildId: string;
  moduleId: string;
  areas: readonly AreaMeta[];
  current: string;
}): ReactElement {
  const { track, indicator } = useSlidingIndicator<HTMLElement>(
    areas.findIndex((area) => area.id === current),
    areas.map((area) => area.id).join(' '),
  );

  return (
    <nav ref={track} aria-label="Sections" className="segmented">
      <span ref={indicator} className="segmented-thumb" aria-hidden />
      {areas.map((area) => (
        <ModuleLink
          key={area.id}
          guildId={guildId}
          moduleId={moduleId}
          search={{ area: area.id }}
          className="segmented-option"
          aria-current={area.id === current ? 'page' : undefined}
        >
          {area.label}
        </ModuleLink>
      ))}
    </nav>
  );
}
