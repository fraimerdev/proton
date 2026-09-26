import type { ReactElement } from 'react';
import { useMemo, useRef, useState } from 'react';
import { SearchField } from '../../components/ui/controls.tsx';
import { Icon } from '../../components/ui/icon.tsx';
import { Popover } from '../../components/ui/overlay.tsx';
import { timeZoneList, zoneOffsetLabel } from './time.ts';

interface ZoneOption {
  zone: string;
  name: string;
  offset: string;
  region: string | null;
}

export function zoneName(zone: string): string {
  return zone.replaceAll('_', ' ');
}

function regionOf(zone: string): string | null {
  const slash = zone.indexOf('/');
  return slash === -1 || zone.startsWith('Etc/') ? null : zone.slice(0, slash);
}

export function TimeZonePicker({
  value,
  onChange,
  label = 'Time zone',
  width = 280,
  disabled = false,
  invalid = false,
}: {
  value: string;
  onChange: (zone: string) => void;
  label?: string | undefined;
  width?: number | string | undefined;
  disabled?: boolean | undefined;
  invalid?: boolean | undefined;
}): ReactElement {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [openedAt, setOpenedAt] = useState(() => Date.now());

  const options = useMemo<ZoneOption[]>(
    () =>
      open
        ? timeZoneList(value).flatMap((zone) => {
            const offset = zoneOffsetLabel(zone, openedAt);
            return offset === null
              ? []
              : [{ zone, name: zoneName(zone), offset, region: regionOf(zone) }];
          })
        : [],
    [open, value, openedAt],
  );

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const byRegion = new Map<string, { region: string | null; zones: ZoneOption[] }>();

    for (const option of options) {
      const haystack = `${option.zone} ${option.name} ${option.offset}`.toLowerCase();
      if (needle !== '' && !haystack.includes(needle)) continue;

      const key = option.region ?? '';
      const group = byRegion.get(key) ?? { region: option.region, zones: [] };
      group.zones.push(option);
      byRegion.set(key, group);
    }

    return [...byRegion.values()];
  }, [options, query]);

  const current = zoneOffsetLabel(value, openedAt);

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="picker-trigger"
        style={{ width }}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-invalid={invalid ? true : undefined}
        aria-label={`${label}: ${zoneName(value)}`}
        onClick={() => {
          setQuery('');
          setOpenedAt(Date.now());
          setOpen((shown) => !shown);
        }}
      >
        <span className="picker-value">
          <span className="truncate">{zoneName(value)}</span>
          {current !== null ? <span className="achievements-zone-offset">{current}</span> : null}
        </span>
        <Icon name="caret-down" size={12} weight="fill" className="picker-chevron" />
      </button>

      <Popover
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        minWidth={300}
        maxWidth={380}
      >
        <div className="picker-search">
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder="Search time zones…"
            label="Search time zones"
            autoFocus
          />
        </div>

        <div className="popover-scroll" role="listbox" aria-label={label}>
          {groups.map((group) => (
            <div key={group.region ?? '—'}>
              {group.region !== null ? <p className="picker-category">{group.region}</p> : null}
              {group.zones.map((option) => (
                <button
                  key={option.zone}
                  type="button"
                  role="option"
                  aria-selected={option.zone === value}
                  className="picker-option"
                  onClick={() => {
                    onChange(option.zone);
                    setOpen(false);
                  }}
                >
                  <span className="truncate">{option.name}</span>
                  <span className="achievements-zone-offset">{option.offset}</span>
                  {option.zone === value ? (
                    <Icon name="check" size={13} weight="fill" className="menu-item-check" />
                  ) : null}
                </button>
              ))}
            </div>
          ))}

          {groups.length === 0 ? <p className="picker-note">No matching time zones</p> : null}
        </div>
      </Popover>
    </>
  );
}
