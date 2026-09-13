import { appealsConfigSchema, livePanels, panelFor } from '@proton/module-appeals/config';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useMemo } from 'react';
import { CHANNEL_TYPE, ChannelPicker } from '../../components/discord/channel-picker.tsx';
import { ModuleLink } from '../../components/module/route.tsx';
import { Select, Switch } from '../../components/ui/controls.tsx';
import { Spinner } from '../../components/ui/feedback.tsx';
import { ActionRow, Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { moduleConfigQuery } from '../../lib/queries.ts';
import type { HoneypotForm } from './shape.ts';

const LOG_TYPES = [
  CHANNEL_TYPE.text,
  CHANNEL_TYPE.announcement,
  CHANNEL_TYPE.publicThread,
  CHANNEL_TYPE.privateThread,
] as const;

const QUOTE_NOTE =
  'The message is shown in a code block, with backticks replaced and anything past 900 ' +
  'characters cut off.';

const NO_LOG_CHANNEL =
  'No incident log is set, so Honeypot reports nothing: no incident embed and no quoted message.';

const NO_APPEAL_FORM = 'No appeal form is switched on.';

const UNREADABLE = 'Proton cannot read this server’s appeal forms, so it cannot offer the list.';

function AppealFormRow({ form, guildId }: { form: HoneypotForm; guildId: string }): ReactElement {
  const appeals = useQuery(moduleConfigQuery(guildId, 'appeals'));

  const known = useMemo(() => {
    const parsed = appealsConfigSchema.safeParse(appeals.data?.config);
    return parsed.success ? parsed.data : undefined;
  }, [appeals.data]);

  const chosen = form.value.appealPanelId;
  const panels = known === undefined ? [] : livePanels(known);
  const stored = known !== undefined && chosen !== undefined ? panelFor(known, chosen) : undefined;
  const missing = known !== undefined && chosen !== undefined && stored?.enabled !== true;
  const empty = known !== undefined && panels.length === 0 && !missing;

  return (
    <SettingRow
      title="Appeal form"
      description="Let banned members appeal through this form from the direct message."
      error={form.errorAt('appealPanelId')}
      note={
        appeals.isPending
          ? undefined
          : known === undefined
            ? UNREADABLE
            : empty
              ? NO_APPEAL_FORM
              : undefined
      }
    >
      {appeals.isPending ? (
        <Spinner label="Loading appeal forms" />
      ) : known === undefined || empty ? (
        <ModuleLink
          guildId={guildId}
          moduleId={'appeals'}
          search={{ area: 'forms' }}
          className="button button-secondary button-sm"
        >
          Open Appeals
        </ModuleLink>
      ) : (
        <Select
          aria-label="Appeal form"
          width="md"
          value={chosen ?? ''}
          options={[
            { value: '', label: 'No appeal form' },
            ...(missing && chosen !== undefined
              ? [
                  {
                    value: chosen,
                    label:
                      stored === undefined
                        ? `${chosen} — no longer a form`
                        : `${stored.name} — switched off`,
                  },
                ]
              : []),
            ...panels.map((panel) => ({ value: panel.id, label: panel.name })),
          ]}
          onChange={(value) => form.setValue((c) => ({ ...c, appealPanelId: value || undefined }))}
        />
      )}
    </SettingRow>
  );
}

export function EscalationArea({
  form,
  guildId,
}: {
  form: HoneypotForm;
  guildId: string;
}): ReactElement {
  const config = form.value;

  return (
    <>
      <Section label="Blocking and logging">
        <Rows>
          <SettingRow
            title="Block caught members"
            description="A blocked account cannot pass verification until a moderator lifts it."
          >
            <Switch
              label="Block caught members"
              checked={config.addToBlacklist}
              onChange={(next) => form.setValue((c) => ({ ...c, addToBlacklist: next }))}
            />
          </SettingRow>

          <SettingRow
            title="Quote the message"
            description="Include the member’s message in the incident log."
            note={config.quoteMessage ? QUOTE_NOTE : undefined}
          >
            <Switch
              label="Quote the message"
              checked={config.quoteMessage}
              onChange={(next) => form.setValue((c) => ({ ...c, quoteMessage: next }))}
            />
          </SettingRow>

          <SettingRow
            title="Incident log"
            description="Where Proton reports Honeypot detections."
            error={form.errorAt('logChannelId')}
            note={config.logChannelId === undefined ? NO_LOG_CHANNEL : undefined}
          >
            <ChannelPicker
              guildId={guildId}
              label="Incident log"
              noneLabel="No incident log"
              placeholder="No incident log"
              types={LOG_TYPES}
              invalid={form.errorAt('logChannelId') !== undefined}
              value={config.logChannelId ?? null}
              onChange={(next) => form.setValue((c) => ({ ...c, logChannelId: next ?? undefined }))}
            />
          </SettingRow>
        </Rows>
      </Section>

      {config.action === 'ban' ? (
        <Section label="Appeals">
          <Rows>
            <AppealFormRow form={form} guildId={guildId} />
          </Rows>
        </Section>
      ) : null}

      <Section label="Records">
        <Rows>
          <ActionRow
            icon="prohibit"
            title="Blocked members"
            description="Members Proton has blocked, and blocks that were lifted."
          >
            <ModuleLink
              guildId={guildId}
              moduleId={'moderation'}
              search={{ area: 'blocked' }}
              className="button button-secondary button-sm"
            >
              Open
            </ModuleLink>
          </ActionRow>
        </Rows>
      </Section>
    </>
  );
}
