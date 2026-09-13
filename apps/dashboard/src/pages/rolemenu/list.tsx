import {
  MAX_MENUS,
  MENU_ID_MAX,
  type RolemenuKind,
  type RolemenuMenu,
} from '@proton/module-rolemenu/config';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { ChannelName } from '../../components/discord/channel-picker.tsx';
import {
  CollectionHeader,
  CollectionStaticRow,
  MetaSeparator,
} from '../../components/ui/collection.tsx';
import {
  Badge,
  Button,
  Field,
  SearchField,
  SegmentedControl,
  TextInput,
} from '../../components/ui/controls.tsx';
import { EmptyState, LoadingArea } from '../../components/ui/feedback.tsx';
import { Rows, Section } from '../../components/ui/layout.tsx';
import { Dialog, MenuButton } from '../../components/ui/overlay.tsx';
import type { GuildChannel } from '../../lib/discord.ts';
import { channelsQuery, rolesQuery } from '../../lib/queries.ts';
import { PostAction, postRefusal, reactionInsteadOfPost } from './post.tsx';
import {
  KIND_HELP,
  KIND_ICON,
  KIND_LABEL,
  KIND_OPTIONS,
  MENU_ID_HELP,
  MENU_ID_PATTERN,
  MENU_ID_SHAPE,
  MODE_LABEL,
  menuHasProblem,
  menuIds,
  type Problems,
  type RolemenuForm,
  setMenus,
  uniqueMenuId,
} from './shape.ts';

const SEARCH_FROM = 8;

const FULL = `You can add up to ${MAX_MENUS} role menus. Delete one to add another.`;

const EMPTY = 'Create a menu, add its roles, then post it.';

const ID_TAKEN = 'Another role menu already has this ID.';

const NEW_MENU_MODE = 'New role menus start in Toggle mode.';

export function MenuList({
  form,
  guildId,
  moduleId,
  enabled,
  problems,
  onOpen,
}: {
  form: RolemenuForm;
  guildId: string;
  moduleId: string;
  enabled: boolean;
  problems: Problems;
  onOpen: (menuId: string) => void;
}): ReactElement {
  const config = form.value;
  const menus = config.menus;

  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [query, setQuery] = useState('');

  const searchable = menus.length > SEARCH_FROM;

  const { data: channels } = useQuery(channelsQuery(guildId));
  const { data: roles, isPending: rolesPending } = useQuery({
    ...rolesQuery(guildId),
    enabled: searchable,
  });

  const channelById = new Map((channels ?? []).map((channel) => [channel.id, channel]));
  const roleNameById = new Map((roles ?? []).map((role) => [role.id, role.name.toLowerCase()]));

  const needle = query.trim().toLowerCase();

  const shown = menus
    .map((menu, index) => ({ menu, index }))
    .filter(
      ({ menu }) =>
        needle === '' ||
        menu.id.toLowerCase().includes(needle) ||
        menu.bindings.some((binding) => roleNameById.get(binding.roleId)?.includes(needle)),
    );

  const full = menus.length >= MAX_MENUS;
  const saved = new Set(form.view.postables.map((postable) => postable.id));

  const create = (id: string, kind: RolemenuKind): void => {
    setMenus(form, [...menus, { id, channelId: '', kind, mode: 'toggle', bindings: [] }]);
    setCreating(false);
    onOpen(id);
  };

  const duplicate = (menu: RolemenuMenu): void => {
    const id = uniqueMenuId(`${menu.id}-copy`, menuIds(config));
    const copy = structuredClone(menu);
    // Two menus pointing at one message would both match a reaction on it, so the copy starts unposted.
    delete copy.messageId;
    setMenus(form, [...menus, { ...copy, id }]);
    onOpen(id);
  };

  return (
    <Section>
      <CollectionHeader
        title="Menus"
        used={menus.length}
        ceiling={MAX_MENUS}
        limitLabel="role menus"
        actions={
          <>
            {searchable ? (
              <SearchField
                value={query}
                onChange={setQuery}
                label="Search role menus"
                placeholder="Search role menus…"
              />
            ) : null}
            <Button
              tone="primary"
              icon="plus"
              disabled={full}
              title={full ? FULL : undefined}
              onClick={() => setCreating(true)}
            >
              Create role menu
            </Button>
          </>
        }
      />

      {menus.length === 0 ? (
        <EmptyState
          icon="list-checks"
          title="No role menus"
          inset
          actions={
            <Button tone="primary" icon="plus" onClick={() => setCreating(true)}>
              Create role menu
            </Button>
          }
        >
          {EMPTY}
        </EmptyState>
      ) : shown.length === 0 && searchable && rolesPending ? (
        <LoadingArea label="Loading roles" minHeight={160} />
      ) : shown.length === 0 ? (
        <EmptyState icon="magnifying-glass" title="No matching role menus" inset>
          Search looks at menu IDs and role names.
        </EmptyState>
      ) : (
        <Rows>
          {shown.map(({ menu, index }) => (
            <MenuRow
              key={index}
              menu={menu}
              guildId={guildId}
              moduleId={moduleId}
              enabled={enabled}
              dirty={form.dirty}
              saved={saved.has(menu.id)}
              broken={menuHasProblem(problems, index)}
              channel={channelById.get(menu.channelId)}
              onOpen={() => onOpen(menu.id)}
              onDuplicate={() => duplicate(menu)}
              onDelete={() => setDeleting(index)}
              duplicateDisabled={full}
            />
          ))}
        </Rows>
      )}

      <CreateMenuDialog
        open={creating}
        taken={menuIds(config)}
        onClose={() => setCreating(false)}
        onCreate={create}
      />

      <DeleteMenuDialog
        menu={deleting === null ? undefined : menus[deleting]}
        channel={deleting === null ? undefined : channelById.get(menus[deleting]?.channelId ?? '')}
        onClose={() => setDeleting(null)}
        onDelete={() => {
          setMenus(
            form,
            menus.filter((_, index) => index !== deleting),
          );
          setDeleting(null);
        }}
      />
    </Section>
  );
}

function MenuRow({
  menu,
  guildId,
  moduleId,
  enabled,
  dirty,
  saved,
  broken,
  channel,
  onOpen,
  onDuplicate,
  onDelete,
  duplicateDisabled,
}: {
  menu: RolemenuMenu;
  guildId: string;
  moduleId: string;
  enabled: boolean;
  dirty: boolean;
  saved: boolean;
  broken: boolean;
  channel: GuildChannel | undefined;
  onOpen: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  duplicateDisabled: boolean;
}): ReactElement {
  const count = menu.bindings.length;
  const name = menu.id === '' ? 'Unnamed menu' : menu.id;

  return (
    <CollectionStaticRow
      icon={KIND_ICON[menu.kind]}
      title={<span className="mono">{name}</span>}
      badge={broken ? <Badge tone="danger">Needs fixing</Badge> : null}
      meta={
        <>
          {menu.channelId === '' ? (
            <Badge tone="warning">No channel</Badge>
          ) : (
            <ChannelName channel={channel} id={menu.channelId} guildId={guildId} />
          )}
          <MetaSeparator />
          {KIND_LABEL[menu.kind]}
          <MetaSeparator />
          {MODE_LABEL[menu.mode]}
          <MetaSeparator />
          {count} {count === 1 ? 'role' : 'roles'}
        </>
      }
      aside={
        <>
          {menu.kind === 'reaction' ? (
            <Button
              size="sm"
              icon="clipboard-text"
              title={reactionInsteadOfPost(menu.id)}
              onClick={() => navigator.clipboard?.writeText(`/rolemenu menu:${menu.id}`)}
            >
              Copy command
            </Button>
          ) : (
            <PostAction
              guildId={guildId}
              moduleId={moduleId}
              menu={menu}
              channelName={channel?.name}
              refusal={postRefusal({ menu, enabled, dirty, saved, broken })}
            />
          )}
          <Button size="sm" onClick={onOpen}>
            Edit
          </Button>
          <MenuButton
            label={`More actions for ${name}`}
            actions={[
              {
                id: 'duplicate',
                label: 'Duplicate',
                icon: 'clipboard-text',
                disabled: duplicateDisabled,
                onSelect: onDuplicate,
              },
              { id: 'delete', label: 'Delete', icon: 'trash', danger: true, onSelect: onDelete },
            ]}
          />
        </>
      }
    />
  );
}

function CreateMenuDialog({
  open,
  taken,
  onClose,
  onCreate,
}: {
  open: boolean;
  taken: ReadonlySet<string>;
  onClose: () => void;
  onCreate: (id: string, kind: RolemenuKind) => void;
}): ReactElement | null {
  const [id, setId] = useState('');
  const [kind, setKind] = useState<RolemenuKind>('button');

  if (!open) return null;

  const trimmed = id.trim();
  const idError =
    trimmed === ''
      ? undefined
      : !MENU_ID_PATTERN.test(trimmed)
        ? MENU_ID_SHAPE
        : taken.has(trimmed)
          ? ID_TAKEN
          : undefined;

  return (
    <Dialog
      open
      onClose={onClose}
      title="Create role menu"
      description="Choose its channel and roles next."
      footerNote={NEW_MENU_MODE}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            tone="primary"
            disabled={trimmed === '' || idError !== undefined}
            onClick={() => {
              setId('');
              onCreate(trimmed, kind);
            }}
          >
            Create
          </Button>
        </>
      }
    >
      <div className="stack stack-16">
        <Field label="Menu ID" hint={MENU_ID_HELP} error={idError}>
          {(props) => (
            <TextInput
              {...props}
              autoFocus
              className="mono"
              spellCheck={false}
              maxLength={MENU_ID_MAX}
              invalid={idError !== undefined}
              value={id}
              onChange={(event) => setId(event.currentTarget.value)}
            />
          )}
        </Field>

        <div className="field">
          <span className="field-label">Style</span>
          <SegmentedControl
            label="Style"
            options={KIND_OPTIONS}
            value={kind}
            onChange={setKind}
            block
          />
          <span className="field-hint">{KIND_HELP[kind]}</span>
        </div>
      </div>
    </Dialog>
  );
}

function DeleteMenuDialog({
  menu,
  channel,
  onClose,
  onDelete,
}: {
  menu: RolemenuMenu | undefined;
  channel: GuildChannel | undefined;
  onClose: () => void;
  onDelete: () => void;
}): ReactElement | null {
  if (!menu) return null;

  const where = channel ? `#${channel.name}` : 'its channel';

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Delete ${menu.id === '' ? 'Unnamed menu' : menu.id}?`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="danger" onClick={onDelete}>
            Delete
          </Button>
        </>
      }
    >
      <p className="text-secondary text-sm">
        The message in {where} stays. Members who use its buttons or dropdown are told the menu no
        longer exists.
      </p>
    </Dialog>
  );
}
