import {
  MAX_BINDINGS_PER_MENU,
  MAX_MENUS,
  ROLEMENU_KINDS,
  ROLEMENU_MODES,
  type RolemenuBinding,
  type RolemenuKind,
  type RolemenuMenu,
  type RolemenuMode,
  rolemenuMenusSchema,
} from '@proton/module-rolemenu/config';
import type { ReactElement } from 'react';
import { useId } from 'react';
import {
  channelOptions,
  type DiscordChannel,
  type DiscordRole,
  roleOptions,
  SinglePicker,
} from '../form/picker.tsx';

export interface RolemenuEditorProps {
  menus: readonly RolemenuMenu[];
  roles: readonly DiscordRole[];
  channels: readonly DiscordChannel[];
  onChange: (menus: RolemenuMenu[]) => void;
}

const MODE_HELP: Record<RolemenuMode, string> = {
  toggle: 'Picking a choice adds the role, picking it again removes it.',
  'add-only': 'Roles can be taken but never given back.',
  unique: 'Only one role from this menu at a time — the others are removed.',
};

export function RolemenuEditor({
  menus,
  roles,
  channels,
  onChange,
}: RolemenuEditorProps): ReactElement {
  const fieldId = useId();
  const parsed = rolemenuMenusSchema.safeParse(menus);
  const channelChoices = channelOptions(channels);
  const roleChoices = roleOptions(roles);

  function updateMenu(index: number, patch: Partial<RolemenuMenu>): void {
    onChange(menus.map((menu, i) => (i === index ? { ...menu, ...patch } : menu)));
  }

  function updateBinding(menuIndex: number, bindingIndex: number, patch: Partial<RolemenuBinding>) {
    const menu = menus[menuIndex];
    if (!menu) return;

    updateMenu(menuIndex, {
      bindings: menu.bindings.map((binding, i) =>
        i === bindingIndex ? { ...binding, ...patch } : binding,
      ),
    });
  }

  function addMenu(): void {
    onChange([
      ...menus,
      {
        id: `menu-${menus.length + 1}`,
        channelId: channels[0]?.id ?? '',
        kind: 'button',
        mode: 'toggle',
        bindings: [{ key: 'choice-1', roleId: '' }],
      },
    ]);
  }

  return (
    <div className="ladder" data-path="menus">
      <p className="field-description">
        Each menu is one message members interact with. Run <code>/rolemenu post</code> after saving
        to publish or refresh it.
      </p>

      {menus.map((menu, menuIndex) => {
        // A label wrapping the picker would forward option clicks back to the trigger and reopen it.
        const channelControlId = `${fieldId}-channel-${menuIndex}`;

        return (
          <fieldset className="ladder-rung rolemenu-menu" key={menu.id || `menu-${menuIndex}`}>
            <legend>{menu.id || 'Untitled menu'}</legend>

            <label className="filter">
              <span>Menu id</span>
              <input
                type="text"
                value={menu.id}
                aria-invalid={menu.id === ''}
                onChange={(e) => updateMenu(menuIndex, { id: e.target.value })}
              />
            </label>

            <div className="filter">
              <span>
                <label htmlFor={channelControlId}>Channel</label>
              </span>
              <SinglePicker
                id={channelControlId}
                label="Channel"
                options={channelChoices}
                value={menu.channelId === '' ? null : menu.channelId}
                onChange={(next) => updateMenu(menuIndex, { channelId: next ?? '' })}
                emptyLabel="Choose a channel…"
                clearable={false}
                invalid={menu.channelId === ''}
              />
            </div>

            <label className="filter">
              <span>Kind</span>
              <select
                value={menu.kind}
                onChange={(e) => updateMenu(menuIndex, { kind: e.target.value as RolemenuKind })}
              >
                {ROLEMENU_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </select>
            </label>

            <label className="filter">
              <span>Mode</span>
              <select
                value={menu.mode}
                onChange={(e) => updateMenu(menuIndex, { mode: e.target.value as RolemenuMode })}
              >
                {ROLEMENU_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode}
                  </option>
                ))}
              </select>
            </label>

            <p className="field-description">{MODE_HELP[menu.mode]}</p>

            <label className="filter">
              <span>
                {menu.kind === 'reaction' ? 'Message id (required)' : 'Message id (optional)'}
              </span>
              <input
                type="text"
                placeholder="Copy with Developer Mode"
                value={menu.messageId ?? ''}
                aria-invalid={menu.kind === 'reaction' && !menu.messageId}
                onChange={(e) =>
                  updateMenu(menuIndex, {
                    messageId: e.target.value === '' ? undefined : e.target.value,
                  })
                }
              />
            </label>

            {menu.bindings.map((binding, bindingIndex) => {
              const roleControlId = `${fieldId}-role-${menuIndex}-${bindingIndex}`;

              return (
                <div
                  className="rolemenu-binding"
                  // biome-ignore lint/suspicious/noArrayIndexKey: the key field is the edited value
                  key={`${menu.id}-${bindingIndex}`}
                >
                  <label className="filter">
                    <span>{menu.kind === 'reaction' ? 'Emoji' : 'Key'}</span>
                    <input
                      type="text"
                      value={binding.key}
                      onChange={(e) =>
                        updateBinding(menuIndex, bindingIndex, { key: e.target.value })
                      }
                    />
                  </label>

                  <div className="filter">
                    <span>
                      <label htmlFor={roleControlId}>Role</label>
                    </span>
                    <SinglePicker
                      id={roleControlId}
                      label="Role"
                      options={roleChoices}
                      value={binding.roleId === '' ? null : binding.roleId}
                      onChange={(next) =>
                        updateBinding(menuIndex, bindingIndex, { roleId: next ?? '' })
                      }
                      emptyLabel="Choose a role…"
                      clearable={false}
                      invalid={binding.roleId === ''}
                    />
                  </div>

                  <label className="filter">
                    <span>Label</span>
                    <input
                      type="text"
                      value={binding.label ?? ''}
                      onChange={(e) =>
                        updateBinding(menuIndex, bindingIndex, {
                          label: e.target.value === '' ? undefined : e.target.value,
                        })
                      }
                    />
                  </label>

                  <button
                    type="button"
                    className="button button-quiet"
                    aria-label={`Remove choice ${binding.key} from ${menu.id}`}
                    disabled={menu.bindings.length <= 1}
                    onClick={() =>
                      updateMenu(menuIndex, {
                        bindings: menu.bindings.filter((_, i) => i !== bindingIndex),
                      })
                    }
                  >
                    Remove choice
                  </button>
                </div>
              );
            })}

            <button
              type="button"
              className="button button-quiet"
              disabled={menu.bindings.length >= MAX_BINDINGS_PER_MENU}
              onClick={() =>
                updateMenu(menuIndex, {
                  bindings: [
                    ...menu.bindings,
                    { key: `choice-${menu.bindings.length + 1}`, roleId: '' },
                  ],
                })
              }
            >
              Add choice
            </button>

            <button
              type="button"
              className="button button-quiet"
              aria-label={`Remove menu ${menu.id}`}
              onClick={() => onChange(menus.filter((_, i) => i !== menuIndex))}
            >
              Remove menu
            </button>
          </fieldset>
        );
      })}

      {menus.length === 0 ? <p className="field-empty">No role menus.</p> : null}

      <button
        type="button"
        className="button button-quiet"
        onClick={addMenu}
        disabled={menus.length >= MAX_MENUS}
      >
        {menus.length >= MAX_MENUS ? `Limit of ${MAX_MENUS} menus reached` : 'Add menu'}
      </button>

      {parsed.success ? null : (
        <ul className="ladder-errors" role="alert">
          {parsed.error.issues.map((issue) => (
            <li key={`${issue.path.map(String).join('.')}-${issue.message}`}>
              {issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ` : ''}
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
