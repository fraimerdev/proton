import cherryBombOneLatin from '@fontsource/cherry-bomb-one/files/cherry-bomb-one-latin-400-normal.woff2';
import cherryBombOneLatinExt from '@fontsource/cherry-bomb-one/files/cherry-bomb-one-latin-ext-400-normal.woff2';
import chicleLatin from '@fontsource/chicle/files/chicle-latin-400-normal.woff2';
import chicleLatinExt from '@fontsource/chicle/files/chicle-latin-ext-400-normal.woff2';
import grenzeGotischLatin from '@fontsource/grenze-gotisch/files/grenze-gotisch-latin-700-normal.woff2';
import grenzeGotischLatinExt from '@fontsource/grenze-gotisch/files/grenze-gotisch-latin-ext-700-normal.woff2';
import interLatin from '@fontsource/inter/files/inter-latin-700-normal.woff2';
import interLatinExt from '@fontsource/inter/files/inter-latin-ext-700-normal.woff2';
import kalamLatin from '@fontsource/kalam/files/kalam-latin-700-normal.woff2';
import kalamLatinExt from '@fontsource/kalam/files/kalam-latin-ext-700-normal.woff2';
import medievalSharpLatin from '@fontsource/medievalsharp/files/medievalsharp-latin-400-normal.woff2';
import medievalSharpLatinExt from '@fontsource/medievalsharp/files/medievalsharp-latin-ext-400-normal.woff2';
import museoModernoLatin from '@fontsource/museomoderno/files/museomoderno-latin-700-normal.woff2';
import museoModernoLatinExt from '@fontsource/museomoderno/files/museomoderno-latin-ext-700-normal.woff2';
import newRockerLatin from '@fontsource/new-rocker/files/new-rocker-latin-400-normal.woff2';
import newRockerLatinExt from '@fontsource/new-rocker/files/new-rocker-latin-ext-400-normal.woff2';
import orbitronLatin from '@fontsource/orbitron/files/orbitron-latin-700-normal.woff2';
import pixelifySansLatin from '@fontsource/pixelify-sans/files/pixelify-sans-latin-700-normal.woff2';
import pixelifySansLatinExt from '@fontsource/pixelify-sans/files/pixelify-sans-latin-ext-700-normal.woff2';
import playpenSansLatin from '@fontsource/playpen-sans/files/playpen-sans-latin-700-normal.woff2';
import playpenSansLatinExt from '@fontsource/playpen-sans/files/playpen-sans-latin-ext-700-normal.woff2';
import zillaSlabLatin from '@fontsource/zilla-slab/files/zilla-slab-latin-700-normal.woff2';
import zillaSlabLatinExt from '@fontsource/zilla-slab/files/zilla-slab-latin-ext-700-normal.woff2';
import type { NameStyleFont } from '@proton/module-branding/name-style';
import type { FaceSubset } from './faces.ts';

export interface FaceFile {
  subset: FaceSubset;
  url: string;
}

function pair(latin: string, latinExt: string): readonly FaceFile[] {
  return [
    { subset: 'latin', url: latin },
    { subset: 'latin-ext', url: latinExt },
  ];
}

export const FACE_FILES: Record<NameStyleFont, readonly FaceFile[]> = {
  'gg-sans': pair(interLatin, interLatinExt),
  tempo: pair(zillaSlabLatin, zillaSlabLatinExt),
  sakura: pair(cherryBombOneLatin, cherryBombOneLatinExt),
  jellybean: pair(chicleLatin, chicleLatinExt),
  modern: pair(museoModernoLatin, museoModernoLatinExt),
  medieval: pair(medievalSharpLatin, medievalSharpLatinExt),
  '8bit': pair(pixelifySansLatin, pixelifySansLatinExt),
  vampyre: pair(grenzeGotischLatin, grenzeGotischLatinExt),
  'monkey-bars': pair(playpenSansLatin, playpenSansLatinExt),
  mainframe: [{ subset: 'latin', url: orbitronLatin }],
  headbang: pair(newRockerLatin, newRockerLatinExt),
  journal: pair(kalamLatin, kalamLatinExt),
};
