import {
  NAME_STYLE_FONT_LABELS,
  NAME_STYLE_FONTS,
  type NameStyleFont,
} from '@proton/module-branding/name-style';

export type FaceStatus = 'bundled' | 'substitute' | 'stand-in';

export type FaceSubset = 'latin' | 'latin-ext';

export interface NameStyleFace {
  slug: NameStyleFont;
  label: string;
  discordTypeface: string;
  drawnIn: string;
  status: FaceStatus;
  package: string;
  version: string;
  weight: 400 | 700;
  subsets: readonly FaceSubset[];
  licence: 'OFL-1.1';
  reservedName: string | null;
  family: string;
  generic: 'sans-serif' | 'serif' | 'cursive' | 'monospace';
}

export const FONTSOURCE_VERSION = '5.3.0';

export const FACE_RANGES: Record<FaceSubset, string> = {
  latin:
    'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  'latin-ext':
    'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
};

const LATIN: readonly FaceSubset[] = ['latin', 'latin-ext'];

type FaceSource = Pick<
  NameStyleFace,
  'discordTypeface' | 'drawnIn' | 'status' | 'weight' | 'subsets' | 'reservedName' | 'generic'
> & { id: string };

const SOURCES: Record<NameStyleFont, FaceSource> = {
  'gg-sans': {
    id: 'inter',
    discordTypeface: 'gg sans',
    drawnIn: 'Inter',
    status: 'substitute',
    weight: 700,
    subsets: LATIN,
    reservedName: null,
    generic: 'sans-serif',
  },
  tempo: {
    id: 'zilla-slab',
    discordTypeface: 'Zilla Slab',
    drawnIn: 'Zilla Slab',
    status: 'bundled',
    weight: 700,
    subsets: LATIN,
    reservedName: null,
    generic: 'serif',
  },
  sakura: {
    id: 'cherry-bomb-one',
    discordTypeface: 'Cherry Bomb One',
    drawnIn: 'Cherry Bomb One',
    status: 'bundled',
    weight: 400,
    subsets: LATIN,
    reservedName: null,
    generic: 'cursive',
  },
  jellybean: {
    id: 'chicle',
    discordTypeface: 'Chicle',
    drawnIn: 'Chicle',
    status: 'bundled',
    weight: 400,
    subsets: LATIN,
    reservedName: 'Chicle',
    generic: 'cursive',
  },
  modern: {
    id: 'museomoderno',
    discordTypeface: 'MuseoModerno',
    drawnIn: 'MuseoModerno',
    status: 'bundled',
    weight: 700,
    subsets: LATIN,
    reservedName: null,
    generic: 'sans-serif',
  },
  medieval: {
    id: 'medievalsharp',
    discordTypeface: 'Néo-Castel',
    drawnIn: 'MedievalSharp',
    status: 'stand-in',
    weight: 400,
    subsets: LATIN,
    reservedName: null,
    generic: 'serif',
  },
  '8bit': {
    id: 'pixelify-sans',
    discordTypeface: 'Pixelify Sans',
    drawnIn: 'Pixelify Sans',
    status: 'bundled',
    weight: 700,
    subsets: LATIN,
    reservedName: null,
    generic: 'monospace',
  },
  vampyre: {
    id: 'grenze-gotisch',
    discordTypeface: 'Sinistre',
    drawnIn: 'Grenze Gotisch',
    status: 'stand-in',
    weight: 700,
    subsets: LATIN,
    reservedName: null,
    generic: 'serif',
  },
  'monkey-bars': {
    id: 'playpen-sans',
    discordTypeface: 'Playpen Sans',
    drawnIn: 'Playpen Sans',
    status: 'bundled',
    weight: 700,
    subsets: LATIN,
    reservedName: null,
    generic: 'cursive',
  },
  mainframe: {
    id: 'orbitron',
    discordTypeface: 'Orbitron',
    drawnIn: 'Orbitron',
    status: 'bundled',
    weight: 700,
    subsets: ['latin'],
    reservedName: null,
    generic: 'sans-serif',
  },
  headbang: {
    id: 'new-rocker',
    discordTypeface: 'New Rocker',
    drawnIn: 'New Rocker',
    status: 'bundled',
    weight: 400,
    subsets: LATIN,
    reservedName: 'New Rocker',
    generic: 'serif',
  },
  journal: {
    id: 'kalam',
    discordTypeface: 'Kalam',
    drawnIn: 'Kalam',
    status: 'bundled',
    weight: 700,
    subsets: LATIN,
    reservedName: null,
    generic: 'cursive',
  },
};

export function faceFor(slug: NameStyleFont): NameStyleFace {
  const { id, ...source } = SOURCES[slug];

  return {
    slug,
    label: NAME_STYLE_FONT_LABELS[slug],
    ...source,
    package: `@fontsource/${id}`,
    version: FONTSOURCE_VERSION,
    licence: 'OFL-1.1',
    family: `proton-name-${slug}`,
  };
}

export const NAME_STYLE_FACES: readonly NameStyleFace[] = NAME_STYLE_FONTS.map(faceFor);

export function faceFile(face: NameStyleFace, subset: FaceSubset): string {
  const id = face.package.slice('@fontsource/'.length);
  return `${face.package}/files/${id}-${subset}-${face.weight}-normal.woff2`;
}

export function fontStack(slug: NameStyleFont): string {
  const face = faceFor(slug);
  if (slug === 'gg-sans') return `"${face.family}", ${face.generic}`;

  return `"${face.family}", "${faceFor('gg-sans').family}", ${face.generic}`;
}

export function faceCaption(face: NameStyleFace): string {
  if (face.status === 'bundled') return face.drawnIn;
  return `${face.drawnIn} · ${face.status}`;
}

export function faceSummary(face: NameStyleFace): string {
  if (face.status === 'bundled') return face.label;
  return `${face.label} (shown in ${face.drawnIn})`;
}

export function faceNote(face: NameStyleFace): string | null {
  if (face.status === 'substitute') {
    return `Discord draws ${face.label}, which is Discord’s own font and cannot be shared. This preview uses ${face.drawnIn} instead.`;
  }

  if (face.status === 'stand-in') {
    return `Discord draws ${face.label} in ${face.discordTypeface}, which Proton does not include yet. This preview uses ${face.drawnIn}.`;
  }

  return null;
}
