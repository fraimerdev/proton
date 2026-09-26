import type { PredefinedReason } from '@proton/module-moderation/config';
import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { CollectionHeader, useRecent } from '../../components/ui/collection.tsx';
import { Button, Chip, cx, IconButton, TextInput } from '../../components/ui/controls.tsx';
import { EmptyState } from '../../components/ui/feedback.tsx';
import { Icon } from '../../components/ui/icon.tsx';
import { Rows, Section } from '../../components/ui/layout.tsx';
import { type ModerationForm, type Problems, setPunish } from './punish-shape.ts';

const REASONS_MAX = 50;
const REASON_MAX = 512;
const ALIASES_MAX = 20;
const ALIAS_MAX = 16;
const ALIAS_SHAPE = /^[a-z0-9_-]+$/;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 10;

const INTRO =
  'A moderator who types an alias as the reason, like spam, gets the full reason instead. ' +
  '/ban, /kick, /timeout and /warn suggest these reasons while the moderator types.';

const EMPTY =
  'Moderators type every reason by hand. Add the ones your team gives most often, with a short ' +
  'alias for each.';

function newReasonId(reasons: readonly PredefinedReason[]): string {
  const taken = new Set(reasons.map((reason) => reason.id.toLowerCase()));

  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
    const id = Array.from(bytes, (byte) => ID_ALPHABET.charAt(byte % ID_ALPHABET.length)).join('');
    if (!taken.has(id)) return id;
  }
}

function aliasProblem(
  alias: string,
  index: number,
  reasons: readonly PredefinedReason[],
): string | undefined {
  if (!ALIAS_SHAPE.test(alias)) return 'An alias is one word: letters, numbers, - and _.';
  if (alias.length > ALIAS_MAX) return `An alias can be at most ${ALIAS_MAX} characters.`;

  for (const [at, reason] of reasons.entries()) {
    if (reason.aliases.some((held) => held.toLowerCase() === alias)) {
      return at === index
        ? `'${alias}' is already an alias of this reason.`
        : `Reason ${at + 1} already uses the alias '${alias}'.`;
    }

    if (at !== index && reason.id.toLowerCase() === alias) {
      return `'${alias}' already stands for reason ${at + 1}.`;
    }
  }

  return undefined;
}

function AliasEditor({
  reasons,
  index,
  savedError,
  onChange,
}: {
  reasons: readonly PredefinedReason[];
  index: number;
  savedError: string | undefined;
  onChange: (aliases: string[]) => void;
}): ReactElement {
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const recent = useRecent();

  const reason = reasons[index];
  const aliases = reason?.aliases ?? [];
  const full = aliases.length >= ALIASES_MAX;
  const position = index + 1;

  const add = (): void => {
    const alias = draft.trim().toLowerCase();
    if (alias === '') return;

    const issue = aliasProblem(alias, index, reasons);
    if (issue !== undefined) {
      setProblem(issue);
      return;
    }

    recent.mark(alias);
    onChange([...aliases, alias]);
    setDraft('');
    setProblem(undefined);
  };

  const error = problem ?? savedError;

  return (
    <div className="moderation-aliases">
      <div className="chip-list">
        {aliases.map((alias) => (
          <Chip
            key={alias}
            className={cx('mono', recent.enter(alias, 'part'))}
            removeLabel={`Remove the alias ${alias}`}
            onRemove={() => onChange(aliases.filter((held) => held !== alias))}
          >
            {alias}
          </Chip>
        ))}

        {full ? null : (
          <span className="moderation-alias-add">
            <TextInput
              className="moderation-alias-input mono"
              aria-label={`Add an alias to reason ${position}`}
              placeholder="Add alias"
              spellCheck={false}
              autoCapitalize="off"
              maxLength={ALIAS_MAX}
              invalid={error !== undefined}
              value={draft}
              onChange={(event) => {
                setDraft(event.currentTarget.value);
                setProblem(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                add();
              }}
            />
            <button
              type="button"
              className="chip-add"
              aria-label={`Add the alias to reason ${position}`}
              title="Add alias"
              disabled={draft.trim() === ''}
              onClick={add}
            >
              <Icon name="plus" size={14} />
            </button>
          </span>
        )}
      </div>

      {error !== undefined ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : full ? (
        <p className="field-hint">{ALIASES_MAX} aliases, the most a reason can have.</p>
      ) : null}
    </div>
  );
}

function ReasonRow({
  reasons,
  index,
  problems,
  focus,
  className,
  onChange,
  onMove,
  onRemove,
}: {
  reasons: readonly PredefinedReason[];
  index: number;
  problems: Problems;
  focus: boolean;
  className: string | undefined;
  onChange: (next: PredefinedReason) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}): ReactElement | null {
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focus) input.current?.focus();
  }, [focus]);

  const reason = reasons[index];
  if (reason === undefined) return null;

  const path = `punish.reasons.${index}`;
  const position = index + 1;
  const saved = problems.at(`${path}.reason`) ?? problems.at(`${path}.id`);
  const textError =
    saved !== undefined && reason.reason.trim() === '' ? 'A reason needs text.' : saved;

  const aliasError = reason.aliases
    .map((_, at) => problems.at(`${path}.aliases.${at}`))
    .find((error) => error !== undefined);

  return (
    <div className={cx('moderation-preset', className)}>
      <span className="moderation-preset-index">{position}</span>

      <div className="moderation-preset-body">
        <TextInput
          ref={input}
          width="full"
          aria-label={`Reason ${position}`}
          placeholder="The reason moderators get"
          maxLength={REASON_MAX}
          invalid={textError !== undefined}
          value={reason.reason}
          onChange={(event) => onChange({ ...reason, reason: event.currentTarget.value })}
        />
        {textError !== undefined ? (
          <p className="field-error" role="alert">
            {textError}
          </p>
        ) : null}

        <AliasEditor
          reasons={reasons}
          index={index}
          savedError={aliasError}
          onChange={(aliases) => onChange({ ...reason, aliases })}
        />
      </div>

      <div className="moderation-preset-actions">
        <IconButton
          tone="ghost"
          size="sm"
          icon="caret-up"
          label={`Move reason ${position} up`}
          disabled={index === 0}
          onClick={() => onMove(-1)}
        />
        <IconButton
          tone="ghost"
          size="sm"
          icon="caret-down"
          label={`Move reason ${position} down`}
          disabled={index === reasons.length - 1}
          onClick={() => onMove(1)}
        />
        <IconButton
          tone="danger-quiet"
          size="sm"
          icon="trash"
          label={`Remove reason ${position}`}
          onClick={onRemove}
        />
      </div>
    </div>
  );
}

export function ReasonsArea({
  form,
  problems,
}: {
  form: ModerationForm;
  problems: Problems;
}): ReactElement {
  const [focused, setFocused] = useState<string | null>(null);
  const recent = useRecent();

  const reasons = form.value.punish.reasons;
  const full = reasons.length >= REASONS_MAX;

  const setReasons = (next: PredefinedReason[]): void =>
    setPunish(form, (current) => ({ ...current, reasons: next }));

  const add = (): void => {
    const id = newReasonId(reasons);
    recent.mark(id);
    setFocused(id);
    setReasons([...reasons, { id, reason: '', aliases: [] }]);
  };

  const move = (index: number, delta: number): void => {
    const next = [...reasons];
    const held = next[index];
    const other = next[index + delta];
    if (held === undefined || other === undefined) return;

    next[index] = other;
    next[index + delta] = held;
    setReasons(next);
  };

  return (
    <Section>
      <CollectionHeader
        title="Predefined reasons"
        used={reasons.length}
        ceiling={REASONS_MAX}
        limitLabel="reasons"
        actions={
          reasons.length > 0 && !full ? (
            <Button size="sm" icon="plus" onClick={add}>
              Add reason
            </Button>
          ) : undefined
        }
      />

      <p className="section-intro">{INTRO}</p>

      {reasons.length === 0 ? (
        <EmptyState
          inset
          icon="list-checks"
          title="No predefined reasons"
          actions={
            <Button tone="primary" size="sm" icon="plus" onClick={add}>
              Add reason
            </Button>
          }
        >
          {EMPTY}
        </EmptyState>
      ) : (
        <Rows>
          {reasons.map((reason, index) => (
            <ReasonRow
              key={reason.id}
              reasons={reasons}
              index={index}
              problems={problems}
              focus={focused === reason.id}
              className={recent.enter(reason.id)}
              onChange={(next) =>
                setReasons(reasons.map((current, at) => (at === index ? next : current)))
              }
              onMove={(delta) => move(index, delta)}
              onRemove={() => setReasons(reasons.filter((_, at) => at !== index))}
            />
          ))}
        </Rows>
      )}
    </Section>
  );
}
