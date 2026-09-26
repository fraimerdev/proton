import { parseTemplate } from '../placeholders/grammar.ts';

export const LINK_MESSAGE = 'must be a complete http:// or https:// link';

export function isLiteralLink(value: string): boolean {
  return /^https?:\/\//i.test(value) && URL.canParse(value);
}

export function holdsPlaceholder(value: string): boolean {
  return parseTemplate(value).tokens.some((token) => token.kind === 'placeholder');
}

// A stored link may be a placeholder that renders one; the renderer checks what it becomes.
export function isLinkOrTemplate(value: string): boolean {
  return isLiteralLink(value) || holdsPlaceholder(value);
}
