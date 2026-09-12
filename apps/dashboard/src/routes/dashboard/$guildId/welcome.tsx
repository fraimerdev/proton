import { CARD_PRESETS, DEFAULT_CARD_ACCENT } from '@proton/cards/presets';
import { EMPTY_MESSAGE } from '@proton/core';
import { greetingMessageSchema } from '@proton/module-welcome/config';
import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { FieldRow, SectionCard, SettingsGrid } from '../../../components/form/section.tsx';
import { WELCOME_AREAS as AREAS } from '../../../components/module/area-index.ts';
import { activeArea } from '../../../components/module/areas.ts';
import type { ModuleForm } from '../../../components/module/form.ts';
import { useModuleForm } from '../../../components/module/form.ts';
import {
  ChannelField,
  Choice,
  Colour,
  POSTABLE_CHANNEL_TYPES,
  Text,
  Toggle,
  usePanelSchema,
} from '../../../components/module/inputs.tsx';
import { ModuleChrome, ModuleSettings, tabsFor } from '../../../components/module/page.tsx';
import { moduleRoute } from '../../../components/module/route.tsx';

const GreetingEditor = lazyRouteComponent(
  () => import('../../../components/welcome/greeting.tsx'),
  'GreetingEditor',
);

const GreetingCardPreview = lazyRouteComponent(
  () => import('../../../components/cards/card-preview.tsx'),
  'GreetingCardPreview',
);

// cardAccent is stored as an integer, not a hex string; Colour's defaultValue prop is typed string.
const CARD_ACCENT_DEFAULT = DEFAULT_CARD_ACCENT as unknown as string;

export const Route = createFileRoute('/dashboard/$guildId/welcome')({
  ...moduleRoute('welcome', { areas: AREAS, preload: [GreetingEditor, GreetingCardPreview] }),
  component: WelcomePage,
});

function WelcomePage(): ReactElement {
  const { guildId } = Route.useParams();
  const search = Route.useSearch();
  const form = useModuleForm(guildId, 'welcome', true);

  const area = activeArea(AREAS, search.area);

  return (
    <>
      <ModuleChrome
        guildId={guildId}
        summary={form.summary}
        area={area}
        tabs={tabsFor([], search.view, area?.id, AREAS)}
      />

      <ModuleSettings form={form}>
        {area?.id === 'welcome' ? <WelcomeArea form={form} /> : null}
        {area?.id === 'goodbye' ? <GoodbyeArea form={form} /> : null}
        {area?.id === 'card' ? <CardArea form={form} /> : null}
      </ModuleSettings>
    </>
  );
}

function WelcomeArea({ form }: { form: ModuleForm }): ReactElement {
  const message = form.value('welcomeMessage', EMPTY_MESSAGE);

  // The builder checks core's messageSchema, which takes any button; a greeting takes link
  // buttons only. Ungated, a finished non-link button rejected every other welcome edit.
  usePanelSchema('welcomeMessage', 'Welcome message', greetingMessageSchema, message);

  return (
    <SettingsGrid>
      <SectionCard id="welcome:welcome" title="When somebody joins" span="full">
        <ChannelField
          path="welcomeChannelId"
          label="Welcome channel"
          help="Nothing is posted, card included, until this is set"
          channelTypes={POSTABLE_CHANNEL_TYPES}
          optional
        />

        <GreetingEditor
          channels={form.channels}
          description="Posted in the welcome channel when somebody joins."
          message={message}
          onChange={(next) => form.set('welcomeMessage', next)}
          roles={form.roles}
        />
      </SectionCard>
    </SettingsGrid>
  );
}

function GoodbyeArea({ form }: { form: ModuleForm }): ReactElement {
  const message = form.value('goodbyeMessage', EMPTY_MESSAGE);

  // The builder checks core's messageSchema, which takes any button; a greeting takes link
  // buttons only. Ungated, a finished non-link button rejected every other welcome edit.
  usePanelSchema('goodbyeMessage', 'Goodbye message', greetingMessageSchema, message);

  return (
    <SettingsGrid>
      <SectionCard id="welcome:goodbye" title="When somebody leaves" span="full">
        <ChannelField
          path="goodbyeChannelId"
          label="Goodbye channel"
          help="Nothing is posted, card included, until this is set"
          channelTypes={POSTABLE_CHANNEL_TYPES}
          optional
        />

        <GreetingEditor
          channels={form.channels}
          description="Posted in the goodbye channel when somebody leaves."
          message={message}
          onChange={(next) => form.set('goodbyeMessage', next)}
          roles={form.roles}
        />
      </SectionCard>
    </SettingsGrid>
  );
}

function CardArea({ form }: { form: ModuleForm }): ReactElement {
  return (
    <SettingsGrid>
      <SectionCard
        id="welcome:card"
        title="Card"
        hint="The same card is drawn for joins and leaves."
      >
        <Toggle
          path="card"
          label="Attach a card"
          help="Costs an image render on every join and leave"
          defaultValue={false}
        />
        <FieldRow>
          <Choice path="preset" label="Card style" options={CARD_PRESETS} defaultValue="midnight" />
          <Colour path="cardAccent" label="Accent colour" defaultValue={CARD_ACCENT_DEFAULT} />
        </FieldRow>
        <Text
          path="cardBackgroundUrl"
          label="Background image"
          help="Only images hosted on Discord’s CDN load"
          maxLength={2048}
          optional
        />
        <Toggle path="cardShowMemberCount" label="Show the member count" defaultValue={true} />
      </SectionCard>

      {/* Beside the settings, not under them: the card is 530px wide and every control in the
          section to its left changes what it draws. Spanning the grid put a preview the size of
          half a column at the foot of a page the admin had to scroll away from to change it. */}
      <SectionCard id="welcome:panel:card-preview" title="Card preview">
        <GreetingCardPreview config={form.live} guildId={form.guildId} />
      </SectionCard>
    </SettingsGrid>
  );
}
