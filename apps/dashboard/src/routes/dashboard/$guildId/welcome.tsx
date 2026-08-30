import { CARD_PRESETS, DEFAULT_CARD_ACCENT } from '@proton/cards/presets';
import { EMPTY_MESSAGE } from '@proton/core';
import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { SectionCard } from '../../../components/form/section.tsx';
import { WELCOME_AREAS as AREAS } from '../../../components/module/area-index.ts';
import { activeArea } from '../../../components/module/areas.ts';
import type { ModuleForm } from '../../../components/module/form.ts';
import { useModuleForm } from '../../../components/module/form.ts';
import { ChannelField, Choice, Colour, Text, Toggle } from '../../../components/module/inputs.tsx';
import { AreaHub, ModuleChrome, ModuleSettings } from '../../../components/module/page.tsx';
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
      <ModuleChrome guildId={guildId} summary={form.summary} area={area} tabs={[]} />

      {area === undefined ? (
        <AreaHub areas={AREAS} config={form.config} />
      ) : (
        <ModuleSettings form={form}>
          {area.id === 'welcome' ? <WelcomeArea form={form} /> : null}
          {area.id === 'goodbye' ? <GoodbyeArea form={form} /> : null}
          {area.id === 'card' ? <CardArea form={form} /> : null}
        </ModuleSettings>
      )}
    </>
  );
}

function WelcomeArea({ form }: { form: ModuleForm }): ReactElement {
  return (
    <>
      <SectionCard id="welcome:welcome" title="Welcome">
        <ChannelField path="welcomeChannelId" label="Welcome channel" optional />
      </SectionCard>

      <SectionCard id="welcome:panel:welcomeMessage" title="Welcome message">
        <GreetingEditor
          channels={form.channels}
          description="Posted in the welcome channel when somebody joins."
          message={form.value('welcomeMessage', EMPTY_MESSAGE)}
          onChange={(next) => form.set('welcomeMessage', next)}
          roles={form.roles}
        />
      </SectionCard>
    </>
  );
}

function GoodbyeArea({ form }: { form: ModuleForm }): ReactElement {
  return (
    <>
      <SectionCard id="welcome:goodbye" title="Goodbye">
        <ChannelField path="goodbyeChannelId" label="Goodbye channel" optional />
      </SectionCard>

      <SectionCard id="welcome:panel:goodbyeMessage" title="Goodbye message">
        <GreetingEditor
          channels={form.channels}
          description="Posted in the goodbye channel when somebody leaves."
          message={form.value('goodbyeMessage', EMPTY_MESSAGE)}
          onChange={(next) => form.set('goodbyeMessage', next)}
          roles={form.roles}
        />
      </SectionCard>
    </>
  );
}

function CardArea({ form }: { form: ModuleForm }): ReactElement {
  return (
    <>
      <SectionCard id="welcome:card" title="Card">
        <Toggle
          path="card"
          label="Attach a card"
          help="Costs an extra image render per join"
          defaultValue={false}
        />
        <Choice path="preset" label="Card style" options={CARD_PRESETS} defaultValue="midnight" />
        <Colour path="cardAccent" label="Accent colour" defaultValue={CARD_ACCENT_DEFAULT} />
        <Text
          path="cardBackgroundUrl"
          label="Background image"
          help="Only images hosted on Discord’s CDN load"
          maxLength={2048}
          optional
        />
        <Toggle path="cardShowMemberCount" label="Show the member count" defaultValue={true} />
      </SectionCard>

      <SectionCard id="welcome:panel:card-preview" title="Card preview">
        <GreetingCardPreview config={form.live} guildId={form.guildId} />
      </SectionCard>
    </>
  );
}
