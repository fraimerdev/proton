import { applyTypeface, TYPEFACE_LABELS, TYPEFACES } from '@proton/module-branding/typeface';
import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { BrandingDiscordPreview } from '../../../components/branding/discord-preview.tsx';
import { BrandingMedia } from '../../../components/branding/media.tsx';
import { BrandingPreview } from '../../../components/branding/preview.tsx';
import { SectionCard } from '../../../components/form/section.tsx';
import { useModuleForm } from '../../../components/module/form.ts';
import { Choice, Colour, Text, Toggle } from '../../../components/module/inputs.tsx';
import { ModuleChrome, ModuleSettings } from '../../../components/module/page.tsx';
import { moduleRoute } from '../../../components/module/route.tsx';

export const Route = createFileRoute('/dashboard/$guildId/branding')({
  ...moduleRoute('branding'),
  component: BrandingPage,
});

// The sample is the label: a face named "Fraktur" tells an admin nothing, and the whole point of
// the control is what the letters look like.
const TYPEFACE_LABELS_WITH_SAMPLE: Record<string, string> = Object.fromEntries(
  TYPEFACES.map((face) => [
    face,
    face === 'none'
      ? TYPEFACE_LABELS[face]
      : `${TYPEFACE_LABELS[face]} — ${applyTypeface('Proton', face)}`,
  ]),
);

const EFFECTS = ['none', 'solid', 'gradient', 'holographic'] as const;

const EFFECT_LABELS: Record<string, string> = {
  none: 'None',
  solid: 'Solid',
  gradient: 'Gradient',
  holographic: 'Holographic',
};

function hash(config: Record<string, unknown>, key: string): string | undefined {
  return typeof config[key] === 'string' ? (config[key] as string) : undefined;
}

function BrandingPage(): ReactElement {
  const { guildId } = Route.useParams();
  const form = useModuleForm(guildId, 'branding');

  // The upload route writes the module config itself and BrandingMedia invalidates the query, so
  // this signals nothing: binding it to form.set would make the save bar dirty on every upload.
  const changed = () => undefined;

  return (
    <>
      <ModuleChrome guildId={guildId} summary={form.summary} area={undefined} tabs={[]} />

      <ModuleSettings form={form}>
        <SectionCard id="branding:general" title="General">
          <Toggle
            path="restoreOnDisable"
            label="Undo when switched off"
            help="Clears the nickname, avatar, banner and bio in this server when this module is turned off"
            defaultValue={true}
          />
        </SectionCard>

        <SectionCard id="branding:identity" title="Identity">
          <Text
            path="nickname"
            label="Server nickname"
            help="What Proton is called in this server. Up to 32 characters; leave it empty to use its own name."
            minLength={1}
            maxLength={32}
            optional
          />
          <Text
            path="bio"
            label="Server bio"
            help={`The "About me" on Proton's profile in this server. Up to 190 characters.`}
            maxLength={190}
            optional
          />
        </SectionCard>

        <SectionCard id="branding:style" title="Display name style">
          <Choice
            path="typeface"
            label="Typeface"
            help="Discord has no font setting a bot can use, so a styled name is spelled in Unicode letters that look like one. Mentions still work; searching the member list for the plain name stops finding it, and screen readers read the letters out one at a time."
            options={TYPEFACES}
            optionLabels={TYPEFACE_LABELS_WITH_SAMPLE}
            defaultValue="none"
          />
          <Choice
            path="nameEffect"
            label="Effect"
            help="Colours Proton’s name through a role it holds here. Gradient and holographic need this server to have Discord’s Enhanced Role Colours feature."
            options={EFFECTS}
            optionLabels={EFFECT_LABELS}
            defaultValue="none"
          />
          <Colour path="primaryColor" label="First colour" />
          <Colour path="secondaryColor" label="Second colour" />
        </SectionCard>

        <SectionCard id="branding:panel:media" title="Profile media">
          <div className="branding-media-set">
            <BrandingMedia
              guildId={guildId}
              kind="avatar"
              hash={hash(form.live, 'avatarHash')}
              onChanged={changed}
            />
            <BrandingMedia
              guildId={guildId}
              kind="banner"
              hash={hash(form.live, 'bannerHash')}
              onChanged={changed}
            />
          </div>
        </SectionCard>

        <SectionCard id="branding:panel:preview" title="Preview">
          <div className="branding-previews">
            <BrandingDiscordPreview config={form.live} guildId={guildId} />
            <BrandingPreview config={form.live} guildId={guildId} />
          </div>
        </SectionCard>
      </ModuleSettings>
    </>
  );
}
