import { type FormConfig, questionsOf } from '@proton/module-applications/config';
import { FORM_ID_MAX, FORM_NAME_MAX } from '@proton/module-applications/constants';
import { FORM_TEMPLATES } from '@proton/module-applications/templates';
import type { ReactElement } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { EmojiGlyph } from '../../components/discord/emoji-picker.tsx';
import { CollectionButtonRow } from '../../components/ui/collection.tsx';
import { Button, Field, TextInput } from '../../components/ui/controls.tsx';
import { Rows } from '../../components/ui/layout.tsx';
import { Dialog } from '../../components/ui/overlay.tsx';
import { formIdProblem, fromTemplate, slugify, slugTyping, uniqueId } from './shape.ts';

const SCRATCH = 'scratch';

const ID_HINT = 'Panels and exports refer to the form by its ID. You can’t change it later.';

const TEMPLATES_NOTE =
  'Every template starts closed with no requirements, so nothing reaches members until you ' +
  'publish it and open it.';

interface Starting {
  id: string;
  name: string;
}

function sizeOf(form: FormConfig): string {
  const questions = questionsOf(form).length;
  const sections = form.sections.length;

  return `${questions} questions in ${sections} ${sections === 1 ? 'section' : 'sections'}`;
}

export function CreateFormDialog({
  open,
  taken,
  retired = [],
  onClose,
  onCreate,
}: {
  open: boolean;
  taken: ReadonlySet<string>;
  retired?: readonly string[] | undefined;
  onClose: () => void;
  onCreate: (form: FormConfig) => void;
}): ReactElement | null {
  const [starting, setStarting] = useState<Starting | null>(null);
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [touched, setTouched] = useState(false);
  const [stepped, setStepped] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  const body = useRef<HTMLDivElement>(null);

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setStarting(null);
      setStepped(0);
    }
  }

  const examples = useMemo(
    () =>
      FORM_TEMPLATES.map((template) => {
        const built = template.build('example');
        return { template, emoji: built.emoji, size: sizeOf(built) };
      }),
    [],
  );

  // Dialog moves focus only when it opens; a step change has to move it itself.
  useEffect(() => {
    if (stepped === 0) return;
    body.current?.querySelector<HTMLElement>('input, button:not(:disabled)')?.focus();
  }, [stepped]);

  const choose = (next: Starting | null): void => {
    setStarting(next);
    setName(next?.name ?? '');
    setId('');
    setTouched(false);
    setStepped((count) => count + 1);
  };

  if (starting !== null) {
    const proposed = touched ? id.trim() : uniqueId(slugify(name, FORM_ID_MAX), taken, FORM_ID_MAX);
    const nameError = name.trim() === '' ? 'A form needs a name.' : undefined;
    const idError = formIdProblem(proposed, taken, retired);

    return (
      <Dialog
        open={open}
        onClose={onClose}
        title="Name your form"
        description={
          starting.id === SCRATCH
            ? 'You start with one question and add the rest.'
            : `Starts as a copy of the ${starting.name} template. Change anything you like.`
        }
        size="medium"
        icon="identification-card"
        footer={
          <>
            <Button onClick={() => choose(null)}>Back</Button>
            <Button
              tone="primary"
              disabled={nameError !== undefined || idError !== undefined}
              onClick={() =>
                onCreate(
                  fromTemplate(starting.id === SCRATCH ? null : starting.id, proposed, name.trim()),
                )
              }
            >
              Create form
            </Button>
          </>
        }
      >
        <div ref={body} className="stack stack-16">
          <Field label="Name" error={nameError}>
            {(props) => (
              <TextInput
                {...props}
                width="full"
                maxLength={FORM_NAME_MAX}
                invalid={nameError !== undefined}
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            )}
          </Field>

          <Field label="ID" hint={ID_HINT} error={idError}>
            {(props) => (
              <TextInput
                {...props}
                width="lg"
                className="mono"
                spellCheck={false}
                maxLength={FORM_ID_MAX}
                invalid={idError !== undefined}
                value={proposed}
                onChange={(event) => {
                  setTouched(true);
                  setId(slugTyping(event.currentTarget.value, FORM_ID_MAX));
                }}
              />
            )}
          </Field>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create form"
      description="Templates are ordinary forms with questions filled in. Nothing about them is fixed."
      size="medium"
      icon="identification-card"
    >
      <div ref={body} className="stack stack-16">
        <div className="stack stack-8">
          <p className="section-label">Start from scratch</p>
          <Rows>
            <CollectionButtonRow
              icon="plus"
              title="Blank form"
              meta="One question to start with. You build the rest."
              onSelect={() => choose({ id: SCRATCH, name: 'Application' })}
            />
          </Rows>
        </div>

        <div className="stack stack-8">
          <p className="section-label">Templates</p>
          <Rows>
            {examples.map(({ template, emoji, size }) => (
              <CollectionButtonRow
                key={template.id}
                icon={emoji === undefined ? 'identification-card' : undefined}
                glyph={emoji === undefined ? undefined : <EmojiGlyph emoji={emoji} size={17} />}
                title={template.name}
                meta={
                  <>
                    <span>{template.summary}</span>
                    <span className="applications-meta-part">{size}</span>
                  </>
                }
                onSelect={() => choose({ id: template.id, name: template.name })}
              />
            ))}
          </Rows>
          <p className="text-xs text-muted">{TEMPLATES_NOTE}</p>
        </div>
      </div>
    </Dialog>
  );
}
