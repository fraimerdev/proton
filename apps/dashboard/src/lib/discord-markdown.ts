export type MarkdownNode =
  | { kind: 'paragraph'; children: MarkdownNode[] }
  | { kind: 'heading'; level: 1 | 2 | 3; children: MarkdownNode[] }
  | { kind: 'subtext'; children: MarkdownNode[] }
  | { kind: 'quote'; children: MarkdownNode[] }
  | { kind: 'list'; ordered: boolean; items: MarkdownNode[][]; start?: number }
  | { kind: 'codeBlock'; language?: string; code: string }
  | { kind: 'text'; value: string }
  | { kind: 'bold'; children: MarkdownNode[] }
  | { kind: 'italic'; children: MarkdownNode[] }
  | { kind: 'underline'; children: MarkdownNode[] }
  | { kind: 'strike'; children: MarkdownNode[] }
  | { kind: 'spoiler'; children: MarkdownNode[] }
  | { kind: 'code'; value: string }
  | { kind: 'link'; url: string; children: MarkdownNode[] }
  | { kind: 'userMention'; id: string }
  | { kind: 'roleMention'; id: string }
  | { kind: 'channelMention'; id: string }
  | { kind: 'slashCommand'; name: string; id: string }
  | { kind: 'emoji'; name: string; id: string; animated: boolean }
  | { kind: 'timestamp'; unix: number; style: string }
  | { kind: 'everyone'; which: 'everyone' | 'here' }
  | { kind: 'guildNav'; target: string; roleId?: string };

const MAX_DEPTH = 24;

interface Ctx {
  depth: number;
  links: boolean;
}

const WORD = /[0-9A-Za-z_]/;
const PUNCTUATION = /[^0-9A-Za-z\s]/;
const SPACE = /\s/;

function isWord(char: string): boolean {
  return char.length > 0 && WORD.test(char);
}

function readCode(input: string, at: number): { value: string; next: number } | null {
  let open = 0;
  while (input.charAt(at + open) === '`') open += 1;
  if (open === 0 || open > 3) return null;

  let i = at + open;
  while (i < input.length) {
    if (input.charAt(i) !== '`') {
      i += 1;
      continue;
    }

    let run = 0;
    while (input.charAt(i + run) === '`') run += 1;
    if (run === open) {
      return i === at + open ? null : { value: input.slice(at + open, i), next: i + open };
    }
    i += run;
  }

  return null;
}

function findCloser(
  input: string,
  from: number,
  delim: string,
  guard: boolean,
  tight: boolean,
): number {
  const char = delim.charAt(0);
  const width = delim.length;
  let i = from;

  while (i < input.length) {
    const current = input.charAt(i);

    if (current === '\\') {
      i += 2;
      continue;
    }

    if (current === '`') {
      const code = readCode(input, i);
      i = code ? code.next : i + 1;
      continue;
    }

    if (current !== char) {
      i += 1;
      continue;
    }

    let run = 1;
    while (input.charAt(i + run) === char) run += 1;

    if (
      run >= width &&
      (width > 1 || run === 1) &&
      !(guard && isWord(input.charAt(i + width))) &&
      !(tight && SPACE.test(input.charAt(i - 1)))
    ) {
      return i;
    }
    i += run;
  }

  return -1;
}

// Only the single asterisk is space-anchored; Discord really does emphasise `** a **` and `|| a ||`.
const EMPHASIS: ReadonlyArray<{
  delim: string;
  guard: boolean;
  tight: boolean;
  wrap: (children: MarkdownNode[]) => MarkdownNode;
}> = [
  {
    delim: '***',
    guard: false,
    tight: false,
    wrap: (c) => ({ kind: 'bold', children: [{ kind: 'italic', children: c }] }),
  },
  { delim: '**', guard: false, tight: false, wrap: (c) => ({ kind: 'bold', children: c }) },
  { delim: '__', guard: false, tight: false, wrap: (c) => ({ kind: 'underline', children: c }) },
  { delim: '~~', guard: false, tight: false, wrap: (c) => ({ kind: 'strike', children: c }) },
  { delim: '||', guard: false, tight: false, wrap: (c) => ({ kind: 'spoiler', children: c }) },
  { delim: '*', guard: false, tight: true, wrap: (c) => ({ kind: 'italic', children: c }) },
  { delim: '_', guard: true, tight: false, wrap: (c) => ({ kind: 'italic', children: c }) },
];

function readEmphasis(
  input: string,
  at: number,
  ctx: Ctx,
): { node: MarkdownNode; next: number } | null {
  for (const rule of EMPHASIS) {
    if (!input.startsWith(rule.delim, at)) continue;
    if (rule.guard && isWord(input.charAt(at - 1))) continue;

    const from = at + rule.delim.length;
    if (rule.tight && SPACE.test(input.charAt(from))) continue;

    const close = findCloser(input, from, rule.delim, rule.guard, rule.tight);
    if (close < 0 || close === from) continue;

    const children = parseInline(input.slice(from, close), { ...ctx, depth: ctx.depth + 1 });
    return { node: rule.wrap(children), next: close + rule.delim.length };
  }

  return null;
}

const ENTITY =
  /<(?:@&(?<role>\d{1,20})|@!?(?<user>\d{1,20})|#(?<channel>\d{1,20})|(?<animated>a)?:(?<emoji>\w{2,32}):(?<emojiId>\d{1,20})|\/(?<command>[\w-]+(?: [\w-]+){0,2}):(?<commandId>\d{1,20})|t:(?<unix>-?\d{1,15})(?::(?<style>[tTdDfFsSR]))?|id:(?:linked-roles:(?<navRole>\d{1,20})|(?<nav>customize|browse|guide|linked-roles)))>/y;

function readEntity(input: string, at: number): { node: MarkdownNode; next: number } | null {
  ENTITY.lastIndex = at;
  const match = ENTITY.exec(input);
  if (!match?.groups) return null;

  const g = match.groups;
  const next = at + match[0].length;

  if (g.role) return { node: { kind: 'roleMention', id: g.role }, next };
  if (g.user) return { node: { kind: 'userMention', id: g.user }, next };
  if (g.channel) return { node: { kind: 'channelMention', id: g.channel }, next };
  if (g.emoji && g.emojiId) {
    return {
      node: { kind: 'emoji', name: g.emoji, id: g.emojiId, animated: g.animated === 'a' },
      next,
    };
  }
  if (g.command && g.commandId) {
    return { node: { kind: 'slashCommand', name: g.command, id: g.commandId }, next };
  }
  if (g.unix) {
    return {
      node: { kind: 'timestamp', unix: Number.parseInt(g.unix, 10), style: g.style ?? 'f' },
      next,
    };
  }
  if (g.navRole) {
    return { node: { kind: 'guildNav', target: 'linked-roles', roleId: g.navRole }, next };
  }
  if (g.nav) return { node: { kind: 'guildNav', target: g.nav }, next };

  return null;
}

const SAFE_SCHEME = /^(?:https?|discord|mailto):/i;

function readLink(
  input: string,
  at: number,
  ctx: Ctx,
): { node: MarkdownNode; next: number } | null {
  let i = at + 1;
  let depth = 0;

  while (i < input.length) {
    const char = input.charAt(i);
    if (char === '\\') {
      i += 2;
      continue;
    }
    if (char === '[') depth += 1;
    if (char === ']') {
      if (depth === 0) break;
      depth -= 1;
    }
    i += 1;
  }

  if (i >= input.length || input.charAt(i + 1) !== '(') return null;

  const label = input.slice(at + 1, i);
  let j = i + 2;
  let parens = 0;

  while (j < input.length) {
    const char = input.charAt(j);
    if (char === '(') parens += 1;
    if (char === ')') {
      if (parens === 0) break;
      parens -= 1;
    }
    if (/\s/.test(char)) return null;
    j += 1;
  }

  if (j >= input.length) return null;

  const raw = input.slice(i + 2, j);
  // Balanced pair only: stripping one end alone rewrites a URL that legitimately holds the other.
  const url = raw.length > 1 && raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
  // Scheme allowlist, not a "looks like a URL" check: the consumer feeds this straight to an
  // href, and widening it to any scheme puts javascript: links in a preview of user text.
  if (!SAFE_SCHEME.test(url)) return null;

  return {
    node: {
      kind: 'link',
      url,
      children: parseInline(label, { depth: ctx.depth + 1, links: false }),
    },
    next: j + 1,
  };
}

function parseInline(input: string, ctx: Ctx): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  let buffer = '';
  let i = 0;

  const push = (node: MarkdownNode): void => {
    if (buffer.length > 0) {
      nodes.push({ kind: 'text', value: buffer });
      buffer = '';
    }
    nodes.push(node);
  };

  while (i < input.length) {
    const char = input.charAt(i);

    if (char === '\\' && PUNCTUATION.test(input.charAt(i + 1))) {
      buffer += input.charAt(i + 1);
      i += 2;
      continue;
    }

    if (char === '`') {
      const code = readCode(input, i);
      if (code) {
        push({ kind: 'code', value: code.value });
        i = code.next;
        continue;
      }
    }

    if (char === '<') {
      const entity = readEntity(input, i);
      if (entity) {
        push(entity.node);
        i = entity.next;
        continue;
      }
    }

    if (char === '@' && !isWord(input.charAt(i - 1))) {
      const which = input.startsWith('@everyone', i)
        ? 'everyone'
        : input.startsWith('@here', i)
          ? 'here'
          : null;
      if (which) {
        push({ kind: 'everyone', which });
        i += which.length + 1;
        continue;
      }
    }

    if (ctx.depth < MAX_DEPTH) {
      if (char === '[' && ctx.links) {
        const link = readLink(input, i, ctx);
        if (link) {
          push(link.node);
          i = link.next;
          continue;
        }
      }

      if (char === '*' || char === '_' || char === '~' || char === '|') {
        const emphasis = readEmphasis(input, i, ctx);
        if (emphasis) {
          push(emphasis.node);
          i = emphasis.next;
          continue;
        }
      }
    }

    buffer += char;
    i += 1;
  }

  if (buffer.length > 0) nodes.push({ kind: 'text', value: buffer });

  return nodes;
}

const HEADING = /^(#{1,3}) +(\S.*)$/;
const SUBTEXT = /^-# +(\S.*)$/;
const BULLET = /^ {0,4}([-*]) +(\S.*)$/;
const ORDERED = /^ {0,4}(\d{1,9})\. +(\S.*)$/;
const FENCE_LANGUAGE = /^[\w+#.-]*$/;

function readFence(lines: string[], at: number): { node: MarkdownNode; resume: number } | null {
  const rest = (lines[at] ?? '').slice(3);
  const sameLine = rest.indexOf('```');

  if (sameLine >= 0) {
    lines[at] = rest.slice(sameLine + 3);
    return { node: { kind: 'codeBlock', code: rest.slice(0, sameLine) }, resume: at };
  }

  let end = at + 1;
  while (end < lines.length && !(lines[end] ?? '').includes('```')) end += 1;
  if (end >= lines.length) return null;

  const token = rest.trim();
  const language = FENCE_LANGUAGE.test(token) && token.length > 0 ? token : undefined;
  const head = FENCE_LANGUAGE.test(token) ? [] : [rest];

  const closing = lines[end] ?? '';
  const fence = closing.indexOf('```');
  const tail = closing.slice(0, fence);
  lines[end] = closing.slice(fence + 3);

  const code = [...head, ...lines.slice(at + 1, end), ...(tail.length > 0 ? [tail] : [])].join(
    '\n',
  );

  return {
    node: { kind: 'codeBlock', code, ...(language === undefined ? {} : { language }) },
    resume: end,
  };
}

function parseBlocks(source: string, quotes: boolean): MarkdownNode[] {
  const lines = source.split('\n');
  const blocks: MarkdownNode[] = [];
  let paragraph: string[] = [];
  let i = 0;

  const flush = (): void => {
    if (paragraph.length === 0) return;
    const value = paragraph.join('\n');
    paragraph = [];
    blocks.push({ kind: 'paragraph', children: parseInline(value, { depth: 0, links: true }) });
  };

  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (line.startsWith('```')) {
      const fence = readFence(lines, i);
      if (fence) {
        flush();
        blocks.push(fence.node);
        i = fence.resume;
        continue;
      }
    }

    if (line.trim().length === 0) {
      flush();
      i += 1;
      continue;
    }

    if (quotes && (line === '>>>' || line.startsWith('>>> '))) {
      flush();
      const first = line === '>>>' ? '' : line.slice(4);
      const inner = [first, ...lines.slice(i + 1)].join('\n');
      blocks.push({ kind: 'quote', children: parseBlocks(inner, false) });
      return blocks;
    }

    if (quotes && (line === '>' || line.startsWith('> '))) {
      flush();
      const inner: string[] = [];
      while (i < lines.length) {
        const quoted = lines[i] ?? '';
        if (quoted === '>') inner.push('');
        else if (quoted.startsWith('> ')) inner.push(quoted.slice(2));
        else break;
        i += 1;
      }
      blocks.push({ kind: 'quote', children: parseBlocks(inner.join('\n'), false) });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const hashes = (heading[1] ?? '#').length;
      blocks.push({
        kind: 'heading',
        level: hashes === 1 ? 1 : hashes === 2 ? 2 : 3,
        children: parseInline(heading[2] ?? '', { depth: 0, links: true }),
      });
      i += 1;
      continue;
    }

    const subtext = SUBTEXT.exec(line);
    if (subtext) {
      flush();
      blocks.push({
        kind: 'subtext',
        children: parseInline(subtext[1] ?? '', { depth: 0, links: true }),
      });
      i += 1;
      continue;
    }

    const ordered = ORDERED.exec(line);
    const bullet = ordered ? null : BULLET.exec(line);

    if (ordered || bullet) {
      flush();
      const isOrdered = ordered !== null;
      const start = Number.parseInt(ordered?.[1] ?? '1', 10);
      const items: MarkdownNode[][] = [];

      while (i < lines.length) {
        const item = (isOrdered ? ORDERED : BULLET).exec(lines[i] ?? '');
        if (!item) break;
        items.push(parseInline(item[2] ?? '', { depth: 0, links: true }));
        i += 1;
      }

      blocks.push({
        kind: 'list',
        ordered: isOrdered,
        items,
        ...(isOrdered ? { start } : {}),
      });
      continue;
    }

    paragraph.push(line);
    i += 1;
  }

  flush();

  return blocks;
}

export function parseDiscordMarkdown(input: string): MarkdownNode[] {
  return parseBlocks(input.replace(/\r\n?/g, '\n'), true);
}
