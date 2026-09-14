import type { PlaceholderSurface, SurfaceDiagnostic } from '@proton/core/placeholders';
import { HONEYPOT_COLOUR } from '@proton/module-honeypot/config';
import type { ReactElement } from 'react';
import {
  type LayoutBuilderProps,
  LayoutBuilder as MessageLayoutBuilder,
} from '../../components/discord/layout-builder.tsx';
import { placeholderSlot } from '../../components/discord/message-editor.tsx';

export type DiagnosticsAt = (path: string) => readonly SurfaceDiagnostic[];

export function LayoutBuilder({
  surface,
  diagnosticsAt,
  ...props
}: Omit<LayoutBuilderProps, 'accent' | 'taken' | 'placeholders'> & {
  surface: PlaceholderSurface<unknown>;
  diagnosticsAt: DiagnosticsAt;
}): ReactElement {
  return (
    <MessageLayoutBuilder
      {...props}
      accent={HONEYPOT_COLOUR}
      placeholders={placeholderSlot(surface, diagnosticsAt)}
    />
  );
}
