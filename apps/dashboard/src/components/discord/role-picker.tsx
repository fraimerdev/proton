import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useMemo, useRef, useState } from 'react';
import type { GuildRole } from '../../lib/discord.ts';
import { readFailure } from '../../lib/errors.ts';
import { rolesQuery } from '../../lib/queries.ts';
import { useRecent } from '../ui/collection.tsx';
import { Chip, cx, SearchField } from '../ui/controls.tsx';
import { Spinner } from '../ui/feedback.tsx';
import { Icon } from '../ui/icon.tsx';
import { Popover } from '../ui/overlay.tsx';

const DEFAULT_ROLE_COLOUR = '#99aab5';

export function roleColour(role: GuildRole | undefined): string {
  if (!role || role.color === 0) return DEFAULT_ROLE_COLOUR;
  return `#${role.color.toString(16).padStart(6, '0')}`;
}

export function RoleName({
  role,
  id,
  fresh = false,
}: {
  role?: GuildRole | undefined;
  id?: string | null | undefined;
  fresh?: boolean | undefined;
}): ReactElement {
  if (!role) {
    return <span className="text-muted">{id ? <span className="mono">{id}</span> : 'None'}</span>;
  }

  return (
    <span className="inline inline-6 truncate">
      <span
        key={role.id}
        className={cx('role-swatch', fresh && 'motion-fade')}
        style={{ background: roleColour(role) }}
      />
      <span className="truncate">{role.name}</span>
    </span>
  );
}

/** Why a role cannot be handed out, said before the save rather than as a 403 days later. */
function unreachableReason(role: GuildRole): string | undefined {
  if (role.premiumSubscriber) return 'Discord manages the Booster role — no bot can give it.';
  if (role.managed) return 'Another integration owns this role, so Proton cannot give it.';
  if (!role.assignable) return 'Proton cannot give a role that sits above its own.';
  return undefined;
}

interface Shared {
  guildId: string;
  disabled?: boolean | undefined;
  invalid?: boolean | undefined;
  width?: number | string | undefined;
  label?: string | undefined;
  /** Warn about roles Proton could not actually assign. Off where the role is only ever read. */
  requireAssignable?: boolean | undefined;
  /**
   * @everyone is hidden by default because nothing can be granted it. An exemption list only ever
   * reads a role, and "exempt @everyone" is a legitimate — if blunt — thing to configure.
   */
  includeEveryone?: boolean | undefined;
}

function useRoles(guildId: string, enabled: boolean, includeEveryone: boolean) {
  const { data, error, isPending } = useQuery({ ...rolesQuery(guildId), enabled });

  const roles = useMemo(
    () =>
      (data ?? [])
        .filter((role) => includeEveryone || role.name !== '@everyone')
        .sort((a, b) => b.position - a.position),
    [data, includeEveryone],
  );

  return { roles, error, isPending };
}

function RoleOptions({
  roles,
  isSelected,
  onPick,
  requireAssignable,
  query,
  popped,
}: {
  roles: readonly GuildRole[];
  isSelected: (id: string) => boolean;
  onPick: (role: GuildRole) => void;
  requireAssignable: boolean;
  query: string;
  popped?: string | null | undefined;
}): ReactElement {
  const needle = query.trim().toLowerCase();
  const shown = roles.filter((role) => needle === '' || role.name.toLowerCase().includes(needle));

  if (shown.length === 0) {
    return <p className="picker-note">{needle === '' ? 'No roles.' : 'No matching roles'}</p>;
  }

  return (
    <>
      {shown.map((role) => {
        const reason = requireAssignable ? unreachableReason(role) : undefined;

        return (
          <button
            key={role.id}
            type="button"
            role="option"
            aria-selected={isSelected(role.id)}
            title={reason}
            className={cx('picker-option', reason !== undefined && 'unreachable')}
            onClick={() => onPick(role)}
          >
            <span className="role-swatch" style={{ background: roleColour(role) }} />
            <span className="truncate">{role.name}</span>
            {reason !== undefined ? (
              <Icon name="warning" size={12} weight="fill" className="push-right text-warning" />
            ) : isSelected(role.id) ? (
              <Icon
                name="check"
                size={13}
                weight="fill"
                className={cx('menu-item-check', popped === role.id && 'motion-pop')}
              />
            ) : null}
          </button>
        );
      })}
    </>
  );
}

/* --------------------------------------------------------------------- one */

export function RolePicker({
  guildId,
  value,
  onChange,
  placeholder = 'Choose a role',
  allowNone = true,
  noneLabel = 'No role',
  disabled = false,
  invalid = false,
  width = 252,
  label,
  requireAssignable = true,
  includeEveryone = false,
}: Shared & {
  value: string | null | undefined;
  onChange: (roleId: string | null) => void;
  placeholder?: string | undefined;
  allowNone?: boolean | undefined;
  noneLabel?: string | undefined;
}): ReactElement {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const recent = useRecent();

  const { roles, error, isPending } = useRoles(guildId, open || value != null, includeEveryone);
  const selected = roles.find((role) => role.id === value);
  const warning = selected && requireAssignable ? unreachableReason(selected) : undefined;

  return (
    <div className="stack stack-4" style={{ width }}>
      <button
        ref={anchor}
        type="button"
        className="picker-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-invalid={invalid ? true : undefined}
        aria-label={label}
        onClick={() => {
          setQuery('');
          setOpen((current) => !current);
        }}
      >
        <span className="picker-value">
          {selected ? (
            <RoleName role={selected} fresh={recent.has(selected.id)} />
          ) : value && isPending ? (
            <Spinner label="Loading role" />
          ) : value ? (
            <span className="mono text-muted">{value}</span>
          ) : (
            <span className="picker-placeholder">{placeholder}</span>
          )}
        </span>
        <Icon name="caret-down" size={12} weight="fill" className="picker-chevron" />
      </button>

      {warning !== undefined ? <span className="field-error">{warning}</span> : null}

      <Popover
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        minWidth={260}
        maxWidth={340}
      >
        <div className="picker-search">
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder="Search roles…"
            label="Search roles"
            autoFocus
          />
        </div>

        <div className="popover-scroll" role="listbox">
          {allowNone ? (
            <button
              type="button"
              role="option"
              aria-selected={value == null}
              className="picker-option"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
            >
              <Icon name="prohibit" size={15} className="picker-option-icon" />
              {noneLabel}
            </button>
          ) : null}

          {error ? (
            <p className="picker-note">{readFailure(error, 'this server’s roles')}</p>
          ) : null}
          {isPending && !error ? (
            <p className="picker-note">
              <Spinner label="Loading roles…" showLabel status />
            </p>
          ) : null}

          {!isPending && !error ? (
            <RoleOptions
              roles={roles}
              query={query}
              requireAssignable={requireAssignable}
              isSelected={(id) => id === value}
              onPick={(role) => {
                recent.mark(role.id);
                onChange(role.id);
                setOpen(false);
              }}
            />
          ) : null}
        </div>
      </Popover>
    </div>
  );
}

/* -------------------------------------------------------------------- many */

export function RoleMultiPicker({
  guildId,
  value,
  onChange,
  placeholder = 'Add role',
  disabled = false,
  invalid = false,
  max,
  label,
  requireAssignable = false,
  includeEveryone = false,
}: Shared & {
  value: readonly string[];
  onChange: (roleIds: string[]) => void;
  placeholder?: string | undefined;
  max?: number | undefined;
}): ReactElement {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [popped, setPopped] = useState<string | null>(null);
  const recent = useRecent();

  const { roles, error, isPending } = useRoles(guildId, open || value.length > 0, includeEveryone);
  const byId = new Map(roles.map((role) => [role.id, role]));
  const atMax = max !== undefined && value.length >= max;

  const toggle = (id: string): void => {
    if (value.includes(id)) {
      onChange(value.filter((current) => current !== id));
      return;
    }
    if (atMax) return;
    recent.mark(id);
    setPopped(id);
    onChange([...value, id]);
  };

  const addLabel = label ?? placeholder;

  return (
    <div className="chip-list">
      {value.map((id) => {
        const role = byId.get(id);

        return (
          <Chip
            key={id}
            className={recent.enter(id, 'part')}
            colour={role ? roleColour(role) : undefined}
            removeLabel={role ? `Remove ${role.name}` : isPending ? 'Remove role' : `Remove ${id}`}
            onRemove={disabled ? undefined : () => toggle(id)}
          >
            {role ? role.name : isPending ? <Spinner label="Loading role" /> : id}
          </Chip>
        );
      })}

      <button
        ref={anchor}
        type="button"
        className="chip-add"
        disabled={disabled || atMax}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-invalid={invalid ? true : undefined}
        aria-label={atMax ? `${addLabel} (limit reached)` : addLabel}
        title={atMax ? `You can add up to ${max} roles` : addLabel}
        onClick={() => {
          setQuery('');
          setPopped(null);
          setOpen((current) => !current);
        }}
      >
        <Icon name="plus" size={14} />
      </button>

      <Popover
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        minWidth={260}
        maxWidth={340}
      >
        <div className="picker-search">
          <SearchField
            value={query}
            onChange={(next) => {
              setQuery(next);
              setPopped(null);
            }}
            placeholder="Search roles…"
            label="Search roles"
            autoFocus
          />
        </div>

        <div className="popover-scroll" role="listbox" aria-multiselectable>
          {error ? (
            <p className="picker-note">{readFailure(error, 'this server’s roles')}</p>
          ) : null}
          {isPending && !error ? (
            <p className="picker-note">
              <Spinner label="Loading roles…" showLabel status />
            </p>
          ) : null}

          {!isPending && !error ? (
            <RoleOptions
              roles={roles}
              query={query}
              requireAssignable={requireAssignable}
              isSelected={(id) => value.includes(id)}
              popped={popped}
              onPick={(role) => toggle(role.id)}
            />
          ) : null}

          {atMax ? (
            <p className="picker-note">You can add up to {max} roles. Remove one to add another.</p>
          ) : null}
        </div>
      </Popover>
    </div>
  );
}
