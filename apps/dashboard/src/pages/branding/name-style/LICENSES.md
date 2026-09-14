# Font licences — Branding display name style preview

The display name style preview on the Branding page draws Proton’s name in twelve fonts. The
dashboard serves those font files itself, so OFL 1.1 §2 requires this licence to travel with them.

Every file is taken byte-identical from the `@fontsource/*` npm package named in its section.
Vite copies each one into `/assets/` under a content-hashed name, except a file under its 4 KB
inline limit (today only `files/chicle-latin-ext-400-normal.woff2`, 1,700 bytes), whose same bytes
it embeds as a base64 `data:` URI in the lazily loaded font chunk. No font is subset, instanced or
renamed, and only the files listed here are ever loaded.

Each face is registered through the FontFace API under a CSS family named `proton-name-<font>`.
That is a stylesheet identifier, not a font name: the name table inside every binary is untouched.

## Reserved Font Names

Chicle and New Rocker carry a Reserved Font Name. Both are served exactly as their packages ship
them, with no subsetting, instancing or renaming, so no Modified Version exists under either name.
Every other face listed here declares no Reserved Font Name in its shipped `LICENSE`.

## Fonts Discord draws that Proton does not ship

- **gg sans** — not shipped. It is proprietary to Discord. The preview shows it in Inter and labels
  it as a substitute.
- **Néo-Castel** (Discord’s Medieval) — not shipped. The preview shows it in MedievalSharp, labelled
  as a stand-in, until the owner decides whether to vendor it with verified OFL text.
- **Sinistre** (Discord’s Vampyre) — not shipped. The preview shows it in Grenze Gotisch, labelled
  as a stand-in, until the owner decides whether to vendor it with verified OFL text.

## Inter (substitute for gg sans)

- Files: `files/inter-latin-700-normal.woff2`, `files/inter-latin-ext-700-normal.woff2`
- Upstream: Google Fonts, https://github.com/google/fonts (the package’s `metadata.json`)
- Obtained from: `@fontsource/inter@5.3.0`, unmodified
- Licence: SIL Open Font License, Version 1.1
- Reserved Font Name: none
- Copyright notice, as shipped:

Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter) Inter-Italic[opsz,wght].ttf: Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)

## Zilla Slab (Tempo)

- Files: `files/zilla-slab-latin-700-normal.woff2`, `files/zilla-slab-latin-ext-700-normal.woff2`
- Upstream: Google Fonts, https://github.com/google/fonts (the package’s `metadata.json`)
- Obtained from: `@fontsource/zilla-slab@5.3.0`, unmodified
- Licence: SIL Open Font License, Version 1.1
- Reserved Font Name: none
- Copyright notice, as shipped:

Copyright 2017, The Mozilla Foundation ZillaSlab-LightItalic.ttf: Copyright 2017, The Mozilla Foundation ZillaSlab-Regular.ttf: Copyright 2017, The Mozilla Foundation ZillaSlab-Italic.ttf: Copyright 2017, The Mozilla Foundation ZillaSlab-Medium.ttf: Copyright 2017, The Mozilla Foundation ZillaSlab-MediumItalic.ttf: Copyright 2017, The Mozilla Foundation ZillaSlab-SemiBold.ttf: Copyright 2017, The Mozilla Foundation ZillaSlab-SemiBoldItalic.ttf: Copyright 2017, The Mozilla Foundation ZillaSlab-Bold.ttf: Copyright 2017, The Mozilla Foundation ZillaSlab-BoldItalic.ttf: Copyright 2017, The Mozilla Foundation

## Cherry Bomb One (Sakura)

- Files: `files/cherry-bomb-one-latin-400-normal.woff2`, `files/cherry-bomb-one-latin-ext-400-normal.woff2`
- Upstream: Google Fonts, https://github.com/google/fonts (the package’s `metadata.json`)
- Obtained from: `@fontsource/cherry-bomb-one@5.3.0`, unmodified
- Licence: SIL Open Font License, Version 1.1
- Reserved Font Name: none
- Copyright notice, as shipped:

Copyright 2019 The Cherry Bomb Project Authors (https://github.com/satsuyako/CherryBomb)

## Chicle (Jellybean)

- Files: `files/chicle-latin-400-normal.woff2`, `files/chicle-latin-ext-400-normal.woff2`
- Upstream: Google Fonts, https://github.com/google/fonts (the package’s `metadata.json`)
- Obtained from: `@fontsource/chicle@5.3.0`, unmodified
- Licence: SIL Open Font License, Version 1.1
- Reserved Font Name: "Chicle"
- Copyright notice, as shipped:

Copyright (c) 2007 Angel Koziupa (sudtipos@sudtipos.com), Copyright (c) 2007 Alejandro Paul (sudtipos@sudtipos.com), with Reserved Font Name "Chicle"

## MuseoModerno (Modern)

- Files: `files/museomoderno-latin-700-normal.woff2`, `files/museomoderno-latin-ext-700-normal.woff2`
- Upstream: Google Fonts, https://github.com/google/fonts (the package’s `metadata.json`)
- Obtained from: `@fontsource/museomoderno@5.3.0`, unmodified
- Licence: SIL Open Font License, Version 1.1
- Reserved Font Name: none
- Copyright notice, as shipped:

Copyright 2020 The MuseoModerno Project Authors (https://github.com/Omnibus-Type/MuseoModerno) MuseoModerno-Italic[wght].ttf: Copyright 2020 The MuseoModerno Project Authors (https://github.com/Omnibus-Type/MuseoModerno)

## MedievalSharp (stand-in for Medieval)

- Files: `files/medievalsharp-latin-400-normal.woff2`, `files/medievalsharp-latin-ext-400-normal.woff2`
- Upstream: Google Fonts, https://github.com/google/fonts (the package’s `metadata.json`)
- Obtained from: `@fontsource/medievalsharp@5.3.0`, unmodified
- Licence: SIL Open Font License, Version 1.1
- Reserved Font Name: none
- Copyright notice, as shipped:

Copyright (c) 2011, Wojciech 'wmk69' Kalinowski (wmk69@o2.pl)

## Pixelify Sans (8Bit)

- Files: `files/pixelify-sans-latin-700-normal.woff2`, `files/pixelify-sans-latin-ext-700-normal.woff2`
- Upstream: Google Fonts, https://github.com/google/fonts (the package’s `metadata.json`)
- Obtained from: `@fontsource/pixelify-sans@5.3.0`, unmodified
- Licence: SIL Open Font License, Version 1.1
- Reserved Font Name: none
- Copyright notice, as shipped:

Copyright 2021 The Pixelify Sans Project Authors (https://github.com/eifetx/Pixelify-Sans)

## Grenze Gotisch (stand-in for Vampyre)

- Files: `files/grenze-gotisch-latin-700-normal.woff2`, `files/grenze-gotisch-latin-ext-700-normal.woff2`
- Upstream: Google Fonts, https://github.com/google/fonts (the package’s `metadata.json`)
- Obtained from: `@fontsource/grenze-gotisch@5.3.0`, unmodified
- Licence: SIL Open Font License, Version 1.1
- Reserved Font Name: none
- Copyright notice, as shipped:

Copyright 2020 The Grenze Gotisch Project Authors (https://github.com/Omnibus-Type/Grenze-Gotisch)

## Playpen Sans (Monkey Bars)

- Files: `files/playpen-sans-latin-700-normal.woff2`, `files/playpen-sans-latin-ext-700-normal.woff2`
- Upstream: Google Fonts, https://github.com/google/fonts (the package’s `metadata.json`)
- Obtained from: `@fontsource/playpen-sans@5.3.0`, unmodified
- Licence: SIL Open Font License, Version 1.1
- Reserved Font Name: none
- Copyright notice, as shipped:

Copyright 2023 The Playpen Sans Project Authors (https://github.com/TypeTogether/Playpen-Sans)

## Orbitron (Mainframe)

- Files: `files/orbitron-latin-700-normal.woff2` (the package ships no latin-ext subset)
- Upstream: Google Fonts, https://github.com/google/fonts (the package’s `metadata.json`)
- Obtained from: `@fontsource/orbitron@5.3.0`, unmodified
- Licence: SIL Open Font License, Version 1.1
- Reserved Font Name: none
- Copyright notice, as shipped:

Copyright 2018 The Orbitron Project Authors (https://github.com/theleagueof/orbitron)

## New Rocker (Headbang)

- Files: `files/new-rocker-latin-400-normal.woff2`, `files/new-rocker-latin-ext-400-normal.woff2`
- Upstream: Google Fonts, https://github.com/google/fonts (the package’s `metadata.json`)
- Obtained from: `@fontsource/new-rocker@5.3.0`, unmodified
- Licence: SIL Open Font License, Version 1.1
- Reserved Font Name: 'New Rocker'
- Copyright notice, as shipped:

Copyright (c) 2012, Pablo Impallari (www.impallari.com|impallari@gmail.com), Copyright (c) 2012, Brenda Gallo (gbrenda1987@gmail.com), Copyright (c) 2012, Rodrigo Fuenzalida (www.rfuenzalida.com|hello@rfuenzalida.com), with Reserved Font Name 'New Rocker'

## Kalam (Journal)

- Files: `files/kalam-latin-700-normal.woff2`, `files/kalam-latin-ext-700-normal.woff2`
- Upstream: Google Fonts, https://github.com/google/fonts (the package’s `metadata.json`)
- Obtained from: `@fontsource/kalam@5.3.0`, unmodified
- Licence: SIL Open Font License, Version 1.1
- Reserved Font Name: none
- Copyright notice, as shipped:

Copyright (c) 2014 Indian Type Foundry (info@indiantypefoundry.com) Kalam-Regular.ttf: Copyright (c) 2014 Indian Type Foundry (info@indiantypefoundry.com) Kalam-Bold.ttf: Copyright (c) 2014 Indian Type Foundry (info@indiantypefoundry.com)

---

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
