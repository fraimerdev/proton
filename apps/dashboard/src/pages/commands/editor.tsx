import {
  COMMAND_DESCRIPTION_MAX,
  COMMAND_SIZE_MAX,
  type CommandField,
  type CommandOptionType,
  type CommandView,
  codePointLength,
} from '@proton/core';
import type { ReactElement, ReactNode } from 'react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  Button,
  cx,
  Field,
  PrefixedInput,
  Switch,
  TextInput,
} from '../../components/ui/controls.tsx';
import { StatusBanner } from '../../components/ui/feedback.tsx';
import { Icon } from '../../components/ui/icon.tsx';
import { RowDetail, Rows, SettingRow } from '../../components/ui/layout.tsx';
import {
  type CommandDraft,
  collapsesSections,
  type DraftIssues,
  draftName,
  draftSize,
  issueFor,
  nameCaret,
  nameInput,
  type ReplySummary,
  replyShown,
  replySummary,
  rootOptions,
  type ServerIssues,
  SIZE_NOTE_FROM,
  sectionGroups,
  sectionHasIssue,
  sectionHasOverride,
  showCounter,
  spokenPath,
} from './draft.ts';

export const OPTION_TYPE_LABELS: Readonly<Record<CommandOptionType, string>> = {
  string: 'Text',
  integer: 'Whole number',
  number: 'Number',
  boolean: 'True or false',
  user: 'User',
  channel: 'Channel',
  role: 'Role',
  mentionable: 'User or role',
  attachment: 'File',
};

export const RESPOND_PRIVATELY = 'Only the person using the command can see its reply.';

export const DESCRIPTION_HINT = 'Leave blank to use Proton’s default.';

export const RENAME_CAVEAT =
  'Renaming removes the permissions set for this command in Server Settings → Integrations. ' +
  'Proton’s own messages use the new name once Discord has it.';

const useIsomorphicLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

function optionMeta(field: CommandField): string {
  const type = field.optionType ? OPTION_TYPE_LABELS[field.optionType] : 'Option';
  return field.required ? `${type} · required` : type;
}

function Counter({ value }: { value: string }): ReactElement {
  return (
    <span className="command-counter">
      {codePointLength(value)} / {COMMAND_DESCRIPTION_MAX}
    </span>
  );
}

function DescriptionField({
  field,
  label,
  hiddenLabel,
  value,
  error,
  onChange,
}: {
  field: CommandField;
  label: string;
  hiddenLabel: string;
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
}): ReactElement {
  const id = useId();
  const [focused, setFocused] = useState(false);
  const counter = showCounter(focused, value);
  const describedBy = error !== undefined || counter ? `${id}-hint` : undefined;

  return (
    <div className="field command-option">
      <div className="field-label-line">
        <label className={cx('field-label', field.kind === 'option' && 'mono')} htmlFor={id}>
          {label}
          <span className="visually-hidden">{hiddenLabel}</span>
        </label>
        {field.kind === 'option' ? (
          <span className="command-option-meta">{optionMeta(field)}</span>
        ) : null}
      </div>
      <TextInput
        id={id}
        value={value}
        placeholder={field.description}
        invalid={error !== undefined}
        aria-describedby={describedBy}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {error !== undefined ? (
        <span className="field-error" id={describedBy}>
          {error}
        </span>
      ) : counter ? (
        <span className="field-hint" id={describedBy}>
          <Counter value={value} />
        </span>
      ) : null}
    </div>
  );
}

interface EditorHandlers {
  onName: (value: string) => void;
  onClearSavedName: () => void;
  onDescription: (value: string) => void;
  onOption: (path: string, value: string) => void;
  onPrivateReply: (value: boolean | null) => void;
}

function SubcommandSection({
  command,
  section,
  draft,
  live,
  server,
  collapsible,
  open,
  onToggle,
  onOption,
}: {
  command: CommandView;
  section: CommandField;
  draft: CommandDraft;
  live: DraftIssues;
  server: ServerIssues;
  collapsible: boolean;
  open: boolean;
  onToggle: () => void;
  onOption: (path: string, value: string) => void;
}): ReactElement {
  const id = useId();
  const spoken = spokenPath(draftName(command, draft), section.path);
  const customized = sectionHasOverride(section, draft);

  const body = (
    <div className="command-section-body">
      <DescriptionField
        field={section}
        label="Description"
        hiddenLabel={` of ${spoken}`}
        value={draft.options[section.path] ?? ''}
        error={issueFor(live, server, { option: section.path })}
        onChange={(value) => onOption(section.path, value)}
      />
      {section.children.map((option) => (
        <DescriptionField
          key={option.path}
          field={option}
          label={option.name}
          hiddenLabel={` in ${spoken}`}
          value={draft.options[option.path] ?? ''}
          error={issueFor(live, server, { option: option.path })}
          onChange={(value) => onOption(option.path, value)}
        />
      ))}
    </div>
  );

  return (
    <section className="command-section">
      <h3 className="command-section-title">
        {collapsible ? (
          <button
            type="button"
            className="command-section-toggle"
            aria-expanded={open}
            aria-controls={id}
            onClick={onToggle}
          >
            <span className="mono">{spoken}</span>
            {customized ? <span className="command-section-note">Customized</span> : null}
            <Icon name="caret-down" size={14} weight="fill" className="command-section-caret" />
          </button>
        ) : (
          <span className="mono">{spoken}</span>
        )}
      </h3>
      {collapsible ? (
        <RowDetail open={open} id={id}>
          {body}
        </RowDetail>
      ) : (
        body
      )}
    </section>
  );
}

function Options({
  command,
  draft,
  live,
  server,
  onOption,
}: {
  command: CommandView;
  draft: CommandDraft;
  live: DraftIssues;
  server: ServerIssues;
  onOption: (path: string, value: string) => void;
}): ReactElement | null {
  const collapsible = collapsesSections(command.fields);
  const [opened] = useState(
    () =>
      new Set(
        sectionGroups(command.fields)
          .flatMap((group) => group.sections)
          .filter((section) => !collapsible || sectionHasOverride(section, draft))
          .map((section) => section.path),
      ),
  );
  const [toggled, setToggled] = useState<Readonly<Record<string, boolean>>>({});

  const flat = rootOptions(command.fields);
  const name = draftName(command, draft);

  if (flat.length > 0) {
    return (
      <section className="command-section">
        <h3 className="command-section-title">Options</h3>
        <div className="command-section-body">
          {flat.map((option) => (
            <DescriptionField
              key={option.path}
              field={option}
              label={option.name}
              hiddenLabel={` in /${name}`}
              value={draft.options[option.path] ?? ''}
              error={issueFor(live, server, { option: option.path })}
              onChange={(value) => onOption(option.path, value)}
            />
          ))}
        </div>
      </section>
    );
  }

  const groups = sectionGroups(command.fields);
  if (groups.length === 0) return null;

  const isOpen = (section: CommandField): boolean =>
    !collapsible ||
    sectionHasIssue(section, live, server) ||
    (toggled[section.path] ?? opened.has(section.path));

  return (
    <div className="command-sections">
      {groups.map(({ group, sections }) => (
        <div key={group?.path ?? sections[0]?.path ?? 'root'} className="command-group">
          {group !== null ? (
            <>
              <p className="command-group-label mono">{spokenPath(name, group.path)}</p>
              <DescriptionField
                field={group}
                label="Group description"
                hiddenLabel={` of ${spokenPath(name, group.path)}`}
                value={draft.options[group.path] ?? ''}
                error={issueFor(live, server, { option: group.path })}
                onChange={(value) => onOption(group.path, value)}
              />
            </>
          ) : null}
          {sections.map((section) => (
            <SubcommandSection
              key={section.path}
              command={command}
              section={section}
              draft={draft}
              live={live}
              server={server}
              collapsible={collapsible}
              open={isOpen(section)}
              onToggle={() =>
                setToggled((current) => ({ ...current, [section.path]: !isOpen(section) }))
              }
              onOption={onOption}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function visibilityWord(summary: ReplySummary): string {
  if (summary.defaultPrivate === 'mixed') return 'depends on the subcommand';
  return summary.defaultPrivate ? 'private' : 'public';
}

export function replyDefaultNote(command: CommandView, summary: ReplySummary): string {
  const inherits = command.reply?.inheritsFrom;
  const word = visibilityWord(summary);
  return inherits ? `Default: ${word} (follows ${inherits.label})` : `Default: ${word}`;
}

function ReplyHelp({ name, summary }: { name: string; summary: ReplySummary }): ReactElement {
  const list = (paths: readonly string[]) => paths.map((path) => spokenPath(name, path)).join(', ');

  return (
    <>
      {summary.alwaysPrivate.length > 0 ? (
        <p>Always private: {list(summary.alwaysPrivate)}.</p>
      ) : null}
      {summary.alwaysPublic.length > 0 ? <p>Always public: {list(summary.alwaysPublic)}.</p> : null}
      <p>
        This only changes the reply to the person who used the command. Announcements and log
        entries it posts aren’t affected.
      </p>
    </>
  );
}

function ReplyRow({
  command,
  draft,
  onPrivateReply,
}: {
  command: CommandView;
  draft: CommandDraft;
  onPrivateReply: (value: boolean | null) => void;
}): ReactElement | null {
  if (command.reply?.supported !== true) return null;

  const summary = replySummary(command.reply);

  return (
    <Rows>
      <SettingRow
        title="Respond privately"
        description={RESPOND_PRIVATELY}
        help={<ReplyHelp name={draftName(command, draft)} summary={summary} />}
        note={
          <span className="command-reply-note">
            {replyDefaultNote(command, summary)}
            {draft.privateReply !== null ? (
              <Button tone="ghost" size="sm" onClick={() => onPrivateReply(null)}>
                Use default
              </Button>
            ) : null}
          </span>
        }
      >
        <Switch
          label="Respond privately"
          checked={replyShown(draft, summary)}
          onChange={(next) => onPrivateReply(next)}
        />
      </SettingRow>
    </Rows>
  );
}

function CommandNameInput({
  field,
  value,
  invalid,
  onName,
}: {
  field: { id: string; 'aria-describedby': string | undefined };
  value: string;
  invalid: boolean;
  onName: (value: string) => void;
}): ReactElement {
  const input = useRef<HTMLInputElement>(null);
  const caret = useRef<readonly [number, number] | null>(null);

  useIsomorphicLayoutEffect(() => {
    const kept = caret.current;
    caret.current = null;
    if (kept !== null) input.current?.setSelectionRange(kept[0], kept[1]);
  });

  return (
    <PrefixedInput
      {...field}
      ref={input}
      prefix="/"
      width="lg"
      className="command-name"
      value={value}
      invalid={invalid}
      autoFocus
      autoComplete="off"
      autoCapitalize="none"
      spellCheck={false}
      onChange={(event) => {
        const typed = event.currentTarget;
        const next = nameInput(typed.value);
        const end = typed.value.length;

        caret.current =
          next === typed.value
            ? null
            : [
                nameCaret(typed.value, typed.selectionStart ?? end),
                nameCaret(typed.value, typed.selectionEnd ?? end),
              ];
        onName(next);
      }}
    />
  );
}

function SavedNameNote({
  command,
  savedName,
  onClear,
}: {
  command: CommandView;
  savedName: string;
  onClear: () => void;
}): ReactElement {
  return (
    <p className="field-warning command-caveat command-saved-name">
      <span>
        Saved name <span className="mono">/{savedName}</span> isn’t in use
        {command.ignored !== null ? `: ${command.ignored}` : '.'}
      </span>
      <Button tone="ghost" size="sm" onClick={onClear}>
        Clear saved name
      </Button>
    </p>
  );
}

export function CommandEditor({
  command,
  draft,
  live,
  server,
  notice,
  onName,
  onClearSavedName,
  onDescription,
  onOption,
  onPrivateReply,
}: {
  command: CommandView;
  draft: CommandDraft;
  live: DraftIssues;
  server: ServerIssues;
  notice?: ReactNode;
} & EditorHandlers): ReactElement {
  const [descriptionFocused, setDescriptionFocused] = useState(false);
  const renamed = draftName(command, draft) !== command.effectiveName;
  const alerts = [
    ...(live.size !== undefined ? [live.size] : server.size !== undefined ? [server.size] : []),
    ...server.other,
  ];

  return (
    <div className="command-editor">
      {notice}

      {alerts.length > 0 ? (
        <StatusBanner tone="danger" live="assertive">
          {alerts.map((alert) => (
            <p key={alert}>{alert}</p>
          ))}
        </StatusBanner>
      ) : null}

      <Field
        label="Command name"
        hint={`Default: /${command.name}`}
        error={issueFor(live, server, 'name')}
      >
        {(props) => (
          <CommandNameInput
            field={props}
            value={draft.name}
            invalid={issueFor(live, server, 'name') !== undefined}
            onName={onName}
          />
        )}
      </Field>
      {renamed ? (
        <p className="field-warning command-caveat">{RENAME_CAVEAT}</p>
      ) : draft.savedName !== null ? (
        <SavedNameNote command={command} savedName={draft.savedName} onClear={onClearSavedName} />
      ) : null}

      <Field
        label="Description"
        hint={
          <span className="command-hint-line">
            <span>{DESCRIPTION_HINT}</span>
            {showCounter(descriptionFocused, draft.description) ? (
              <Counter value={draft.description} />
            ) : null}
          </span>
        }
        error={issueFor(live, server, 'description')}
      >
        {(props) => (
          <TextInput
            {...props}
            value={draft.description}
            placeholder={command.description}
            invalid={issueFor(live, server, 'description') !== undefined}
            onFocus={() => setDescriptionFocused(true)}
            onBlur={() => setDescriptionFocused(false)}
            onChange={(event) => onDescription(event.currentTarget.value)}
          />
        )}
      </Field>

      <Options command={command} draft={draft} live={live} server={server} onOption={onOption} />

      <ReplyRow command={command} draft={draft} onPrivateReply={onPrivateReply} />
    </div>
  );
}

export function commandFooterNote(command: CommandView, draft: CommandDraft): string | undefined {
  const size = draftSize(command, draft);
  return size > SIZE_NOTE_FROM ? `${size} / ${COMMAND_SIZE_MAX}` : undefined;
}

export function CommandEditorActions({
  canReset,
  canSave,
  saving,
  onReset,
  onCancel,
  onSave,
}: {
  canReset: boolean;
  canSave: boolean;
  saving: boolean;
  onReset: () => void;
  onCancel: () => void;
  onSave: () => void;
}): ReactElement {
  return (
    <>
      <Button
        tone="ghost"
        className="command-reset"
        disabled={!canReset || saving}
        onClick={onReset}
      >
        Reset to defaults
      </Button>
      <Button className="push-right" disabled={saving} onClick={onCancel}>
        Cancel
      </Button>
      <Button tone="primary" busy={saving} disabled={!canSave} onClick={onSave}>
        Save changes
      </Button>
    </>
  );
}
