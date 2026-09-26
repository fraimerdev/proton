import type { CommandCatalogueView, CommandView } from '@proton/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { StatusBanner } from '../../components/ui/feedback.tsx';
import { Dialog } from '../../components/ui/overlay.tsx';
import { COMMAND_CHANGED, isCommandChanged, saveFailure } from '../../lib/errors.ts';
import { updateGuildCommandMutation } from '../../lib/queries.ts';
import { queryKeys } from '../../lib/query-keys.ts';
import {
  adoptsFresher,
  atDefaults,
  type CommandEdits,
  defaultEdits,
  draftIssues,
  draftOf,
  hasIssues,
  type IssueField,
  isDirty,
  mapServerIssues,
  NO_EDITS,
  NO_SERVER_ISSUES,
  rebaseEdits,
  type ServerIssues,
  submission,
  withDescription,
  withName,
  withOption,
  withoutServerIssue,
  withPrivateReply,
  withSavedNameCleared,
} from './draft.ts';
import { CommandEditor, CommandEditorActions, commandFooterNote } from './editor.tsx';
import { moduleLabel } from './list.ts';

export const EDIT_DIALOG_TITLE = 'Edit slash command';

export function EditCommandDialog({
  guildId,
  command,
  catalogue,
  onClose,
}: {
  guildId: string;
  command: CommandView | null;
  catalogue: readonly CommandView[];
  onClose: () => void;
}): ReactElement | null {
  const queryClient = useQueryClient();
  const open = command !== null;

  const [shown, setShown] = useState<CommandView | null>(command);
  const [edits, setEdits] = useState<CommandEdits>(NO_EDITS);
  const [server, setServer] = useState<ServerIssues>(NO_SERVER_ISSUES);
  const [changed, setChanged] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [openedKey, setOpenedKey] = useState<string | null>(command?.key ?? null);

  if ((command?.key ?? null) !== openedKey) {
    setOpenedKey(command?.key ?? null);
    if (command !== null) {
      setShown(command);
      setEdits(NO_EDITS);
      setServer(NO_SERVER_ISSUES);
      setChanged(false);
      setFailure(null);
    }
  } else if (command !== null && shown !== null && adoptsFresher(shown, command, edits)) {
    setShown(command);
    setEdits(NO_EDITS);
    setServer(NO_SERVER_ISSUES);
  }

  const save = useMutation(updateGuildCommandMutation(queryClient, guildId));

  if (shown === null) return null;

  const draft = draftOf(shown, edits);
  const live = draftIssues(shown, draft, catalogue);
  const dirty = isDirty(shown, edits);

  const edit = (next: CommandEdits, cleared: IssueField): void => {
    setEdits(next);
    setServer((current) => withoutServerIssue(current, cleared));
  };

  const rebase = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.commands(guildId) });
    const fresh = queryClient
      .getQueryData<CommandCatalogueView>(queryKeys.commands(guildId))
      ?.commands.find((candidate) => candidate.key === shown.key);

    if (fresh !== undefined) {
      setEdits((current) => rebaseEdits(shown, fresh, current));
      setShown(fresh);
    }
    setChanged(true);
  };

  const onSave = (): void => {
    if (!dirty || hasIssues(live)) return;

    setFailure(null);
    setChanged(false);
    save.mutate(
      { key: shown.key, ...submission(shown, edits) },
      {
        onSuccess: (result) => {
          if (result.ok) onClose();
          else setServer(mapServerIssues(shown, result.issues));
        },
        onError: (error) => {
          if (isCommandChanged(error)) void rebase();
          else setFailure(saveFailure(error, 'Couldn’t save your changes'));
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={EDIT_DIALOG_TITLE}
      description={
        <>
          <span className="mono">/{shown.effectiveName}</span> · {moduleLabel(shown)}
        </>
      }
      size="large"
      dismissible={!dirty && !save.isPending}
      footerNote={commandFooterNote(shown, draft)}
      footer={
        <CommandEditorActions
          canReset={!atDefaults(shown, edits)}
          canSave={dirty && !hasIssues(live)}
          saving={save.isPending}
          onReset={() => {
            setEdits(defaultEdits(shown));
            setServer(NO_SERVER_ISSUES);
          }}
          onCancel={onClose}
          onSave={onSave}
        />
      }
    >
      <CommandEditor
        key={shown.key}
        command={shown}
        draft={draft}
        live={live}
        server={server}
        notice={
          changed ? (
            <StatusBanner tone="warning" live="polite">
              {COMMAND_CHANGED}
            </StatusBanner>
          ) : failure !== null ? (
            <StatusBanner tone="danger" live="assertive">
              {failure}
            </StatusBanner>
          ) : undefined
        }
        onName={(value) => edit(withName(edits, value), 'name')}
        onClearSavedName={() => edit(withSavedNameCleared(edits), 'name')}
        onDescription={(value) => edit(withDescription(edits, value), 'description')}
        onOption={(path, value) => edit(withOption(edits, path, value), { option: path })}
        onPrivateReply={(value) => setEdits(withPrivateReply(edits, value))}
      />
    </Dialog>
  );
}
