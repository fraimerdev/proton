import type { ComponentEmoji } from '@proton/core';
import {
  BINDING_KEY_MAX,
  BINDING_LABEL_MAX,
  MAX_BINDINGS_PER_MENU,
  type RolemenuBinding,
  type RolemenuMenu,
} from '@proton/module-rolemenu/config';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { EmojiPicker } from '../../components/discord/emoji-picker.tsx';
import { RolePicker } from '../../components/discord/role-picker.tsx';
import { CollectionHeader } from '../../components/ui/collection.tsx';
import { Button, IconButton, TextInput } from '../../components/ui/controls.tsx';
import { EmptyState, StatusBanner } from '../../components/ui/feedback.tsx';
import { Section } from '../../components/ui/layout.tsx';
import { emojisQuery } from '../../lib/queries.ts';
import {
  encodedLength,
  keyBudget,
  type Problems,
  type RolemenuForm,
  SNOWFLAKE,
  setMenu,
} from './shape.ts';

const EMPTY = 'Add a role for members to pick.';

const AT_LIMIT = `Discord allows up to ${MAX_BINDINGS_PER_MENU} roles on one message.`;

const COUNTER_FROM = 12;

function budgetNote(menuId: string): string {
  const budget = keyBudget(menuId);
  return `With the menu ID '${menuId}', each key can be up to ${budget} character${budget === 1 ? '' : 's'}. Discord allows 100 behind a button.`;
}

function manualEmojiWarning(keys: readonly string[]): string {
  return (
    `Proton cannot add ${keys.length} custom emoji (${keys.join(', ')}) itself: it stores only ` +
    'their IDs, and Discord needs an emoji’s name to react with it. React to the message once ' +
    'with each, and members can then use them.'
  );
}

function blankBinding(): RolemenuBinding {
  return { key: '', roleId: '' };
}

export function BindingLadder({
  form,
  guildId,
  index,
  menu,
  problems,
}: {
  form: RolemenuForm;
  guildId: string;
  index: number;
  menu: RolemenuMenu;
  problems: Problems;
}): ReactElement {
  const reaction = menu.kind === 'reaction';
  const full = menu.bindings.length >= MAX_BINDINGS_PER_MENU;

  const { data: emojis } = useQuery({ ...emojisQuery(guildId), enabled: reaction });
  const emojiById = new Map((emojis ?? []).map((emoji) => [emoji.id, emoji]));

  const manual = reaction
    ? menu.bindings.map((b) => b.key).filter((key) => SNOWFLAKE.test(key))
    : [];

  const write = (bindings: RolemenuBinding[]): void => setMenu(form, index, { ...menu, bindings });

  const patch = (at: number, next: Partial<RolemenuBinding>): void => {
    write(
      menu.bindings.map((binding, position) =>
        position === at ? { ...binding, ...next } : binding,
      ),
    );
  };

  const move = (at: number, delta: number): void => {
    const target = at + delta;
    if (target < 0 || target >= menu.bindings.length) return;

    const next = [...menu.bindings];
    const moved = next[at];
    const displaced = next[target];
    if (!moved || !displaced) return;

    next[at] = displaced;
    next[target] = moved;
    write(next);
  };

  const budget = keyBudget(menu.id);

  return (
    <Section>
      <CollectionHeader
        title="Roles"
        used={menu.bindings.length}
        ceiling={MAX_BINDINGS_PER_MENU}
        limitLabel="roles in this menu"
        actions={
          <Button
            tone="primary"
            icon="plus"
            disabled={full}
            title={full ? AT_LIMIT : undefined}
            onClick={() => write([...menu.bindings, blankBinding()])}
          >
            Add role
          </Button>
        }
      />

      {!reaction ? <p className="rolemenu-budget-note">{budgetNote(menu.id)}</p> : null}

      {manual.length > 0 ? (
        <StatusBanner tone="info" title="Some emoji need adding by hand">
          {manualEmojiWarning(manual)}
        </StatusBanner>
      ) : null}

      {problems.get(`menus.${index}.bindings`) !== undefined ? (
        <p className="rolemenu-section-error" role="alert">
          {problems.get(`menus.${index}.bindings`)}
        </p>
      ) : null}

      {menu.bindings.length === 0 ? (
        <EmptyState icon="list-checks" title="No roles" inset>
          {EMPTY}
        </EmptyState>
      ) : (
        <div className="ladder">
          {menu.bindings.map((binding, at) => {
            const keyError =
              problems.get(`menus.${index}.bindings.${at}.key`) ??
              form.errorAt(`menus.${index}.bindings.${at}.key`);
            const roleError =
              problems.get(`menus.${index}.bindings.${at}.roleId`) ??
              form.errorAt(`menus.${index}.bindings.${at}.roleId`);

            const used = encodedLength(menu.id, binding.key) - encodedLength(menu.id, '');
            const left = budget - used;

            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: a binding's position is its identity, and two drafts may briefly share a key
                key={at}
              >
                <div
                  className={
                    keyError !== undefined || roleError !== undefined ? 'rung invalid' : 'rung'
                  }
                >
                  <span className="rung-index">{at + 1}</span>

                  <div className="rung-body">
                    {reaction ? (
                      <EmojiPicker
                        guildId={guildId}
                        label={`Role ${at + 1} emoji`}
                        value={emojiFor(binding.key, emojiById)}
                        onChange={(emoji) =>
                          patch(at, { key: emoji === null ? '' : (emoji.id ?? emoji.name ?? '') })
                        }
                      />
                    ) : (
                      <TextInput
                        className="mono"
                        width="sm"
                        spellCheck={false}
                        placeholder="Key"
                        aria-label={`Role ${at + 1} key`}
                        maxLength={BINDING_KEY_MAX}
                        invalid={keyError !== undefined}
                        value={binding.key}
                        onChange={(event) => patch(at, { key: event.currentTarget.value })}
                      />
                    )}

                    {!reaction && left <= COUNTER_FROM ? (
                      <span className={left < 0 ? 'rolemenu-budget over' : 'rolemenu-budget'}>
                        {left} left
                      </span>
                    ) : null}

                    <span className="rung-connector">gives</span>

                    <RolePicker
                      guildId={guildId}
                      label={`Role ${at + 1}`}
                      width={220}
                      allowNone={false}
                      invalid={roleError !== undefined}
                      value={binding.roleId === '' ? null : binding.roleId}
                      onChange={(roleId) => patch(at, { roleId: roleId ?? '' })}
                    />

                    {!reaction ? (
                      <TextInput
                        width="md"
                        aria-label={`Role ${at + 1} label`}
                        placeholder={binding.key === '' ? 'Label' : binding.key}
                        maxLength={BINDING_LABEL_MAX}
                        value={binding.label ?? ''}
                        onChange={(event) => {
                          const raw = event.currentTarget.value;
                          patch(at, { label: raw === '' ? undefined : raw });
                        }}
                      />
                    ) : null}
                  </div>

                  <div className="rung-aside">
                    <IconButton
                      tone="ghost"
                      size="sm"
                      icon="caret-up"
                      label={`Move role ${at + 1} up`}
                      disabled={at === 0}
                      onClick={() => move(at, -1)}
                    />
                    <IconButton
                      tone="ghost"
                      size="sm"
                      icon="caret-down"
                      label={`Move role ${at + 1} down`}
                      disabled={at === menu.bindings.length - 1}
                      onClick={() => move(at, 1)}
                    />
                    <IconButton
                      tone="danger-quiet"
                      size="sm"
                      icon="trash"
                      label={`Remove role ${at + 1}`}
                      onClick={() => write(menu.bindings.filter((_, position) => position !== at))}
                    />
                  </div>
                </div>

                {keyError !== undefined ? (
                  <p className="rung-error" role="alert">
                    {keyError}
                  </p>
                ) : roleError !== undefined ? (
                  <p className="rung-error" role="alert">
                    {roleError}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

// A reaction binding stores the guild emoji's id, or the character itself — that is what a gateway
// reaction event reports back, and storing a custom emoji's name would silently never match.
function emojiFor(
  key: string,
  byId: ReadonlyMap<string, { id: string; name: string; animated: boolean }>,
): ComponentEmoji | null {
  if (key === '') return null;
  if (!SNOWFLAKE.test(key)) return { name: key };

  const found = byId.get(key);
  return found ? { id: found.id, name: found.name, animated: found.animated } : { id: key };
}
