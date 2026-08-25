import { describe, expect, test } from 'bun:test';
import type { Ticket, TicketMessage } from '../src/store.ts';
import {
  escapeHtml,
  renderTranscriptHtml,
  renderTranscriptText,
  type TranscriptInput,
  transcriptFilename,
} from '../src/transcript.ts';
import { GUILD, HELPER, MEMBER } from './harness.ts';

const PAYLOAD = `"><script>alert('pwn')</script><img src=x onerror=alert(1)>`;

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 't1',
    guildId: GUILD,
    number: 42,
    typeId: 'support',
    panelId: 'support',
    channelId: '500000000000000002',
    openerId: MEMBER,
    ownerId: MEMBER,
    status: 'closed',
    priority: 'high',
    subject: null,
    claimedById: HELPER,
    claimedAt: new Date('2026-08-24T12:05:00Z'),
    assignedToId: null,
    assignedById: null,
    assignedAt: null,
    lockedAt: null,
    lockedById: null,
    waitingOn: null,
    openedAt: new Date('2026-08-24T12:00:00Z'),
    lastActivityAt: new Date('2026-08-24T12:30:00Z'),
    lastUserMessageAt: null,
    lastStaffMessageAt: null,
    firstResponseAt: new Date('2026-08-24T12:05:00Z'),
    closeRequestedById: null,
    closeRequestedAt: null,
    closedAt: new Date('2026-08-24T13:00:00Z'),
    closedBy: HELPER,
    closeReason: null,
    archivedAt: null,
    deletedAt: null,
    messageCount: 1,
    transcriptUrl: null,
    ...overrides,
  };
}

function message(overrides: Partial<TicketMessage> = {}): TicketMessage {
  return {
    id: 'm1',
    ticketId: 't1',
    messageId: '700000000000000001',
    authorId: MEMBER,
    authorName: 'Member',
    authorBot: false,
    content: 'hello',
    attachments: [],
    embeds: [],
    replyToId: null,
    createdAt: new Date('2026-08-24T12:01:00Z'),
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function input(overrides: Partial<TranscriptInput> = {}): TranscriptInput {
  return {
    ticket: ticket(),
    typeName: 'Support',
    guildName: 'Test Guild',
    messages: [message()],
    participants: [],
    answers: [],
    events: [],
    rating: null,
    displayNames: new Map([
      [MEMBER, 'Member'],
      [HELPER, 'Helper'],
    ]),
    ...overrides,
  };
}

interface Parsed {
  elements: Set<string>;
  eventAttributes: string[];
  urls: string[];
}

async function parse(html: string): Promise<Parsed> {
  const elements = new Set<string>();
  const eventAttributes: string[] = [];
  const urls: string[] = [];

  const rewriter = new HTMLRewriter().on('*', {
    element(element) {
      elements.add(element.tagName.toLowerCase());

      for (const [name, value] of element.attributes) {
        if (name.toLowerCase().startsWith('on')) eventAttributes.push(`${name}=${value}`);
        if (name === 'href' || name === 'src') urls.push(value);
      }
    },
  });

  await rewriter.transform(new Response(html)).text();

  return { elements, eventAttributes, urls };
}

describe('escaping', () => {
  test('escapes every character that can end a tag or an attribute', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  test('escapes the ampersand first, or every entity is written twice', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});

describe('a transcript built from hostile input', () => {
  const hostile = input({
    guildName: PAYLOAD,
    typeName: PAYLOAD,
    ticket: ticket({ subject: PAYLOAD, closeReason: PAYLOAD }),
    messages: [message({ authorName: PAYLOAD, content: PAYLOAD })],
    answers: [{ fieldId: 'a', label: PAYLOAD, value: PAYLOAD, position: 0 }],
    rating: {
      ticketId: 't1',
      guildId: GUILD,
      userId: MEMBER,
      rating: 5,
      comment: PAYLOAD,
      createdAt: new Date('2026-08-24T13:05:00Z'),
    },
  });

  test('produces no script, iframe, form or other executable element', async () => {
    const parsed = await parse(renderTranscriptHtml(hostile));

    for (const forbidden of ['script', 'iframe', 'object', 'embed', 'form', 'input', 'base']) {
      expect(parsed.elements.has(forbidden)).toBe(false);
    }
  });

  test('produces no inline event handler anywhere in the document', async () => {
    expect((await parse(renderTranscriptHtml(hostile))).eventAttributes).toEqual([]);
  });

  test('keeps the payload as text, so it is visible to a reader and inert to a browser', () => {
    const html = renderTranscriptHtml(hostile);

    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('attachment and embed urls', () => {
  const withAttachment = (url: string, contentType: string | null = 'image/png') =>
    input({
      messages: [
        message({
          attachments: [{ url, filename: 'evil.png', contentType, size: 10 }],
        }),
      ],
    });

  test('never emits a link or an image for a scheme a browser would execute', async () => {
    for (const url of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      '//evil.example.com/x.png',
      'not a url at all',
    ]) {
      const parsed = await parse(renderTranscriptHtml(withAttachment(url)));

      for (const emitted of parsed.urls) {
        expect(emitted.startsWith('http://') || emitted.startsWith('https://')).toBe(true);
      }
    }
  });

  test('an https image is shown inline, which is why transcripts are worth reading', async () => {
    const parsed = await parse(
      renderTranscriptHtml(withAttachment('https://cdn.discordapp.com/a/b.png')),
    );

    expect(parsed.elements.has('img')).toBe(true);
    expect(parsed.urls).toContain('https://cdn.discordapp.com/a/b.png');
  });

  test('a non-image attachment is a link rather than an image', async () => {
    const parsed = await parse(
      renderTranscriptHtml(withAttachment('https://cdn.discordapp.com/a/b.zip', 'application/zip')),
    );

    expect(parsed.elements.has('a')).toBe(true);
  });

  test('an embed renders only known fields and never raw JSON', () => {
    const html = renderTranscriptHtml(
      input({
        messages: [
          message({
            embeds: [
              {
                title: 'Known title',
                description: 'Known description',
                secret_field: 'must not appear',
                fields: [{ name: 'Field', value: 'Value' }],
              },
            ],
          }),
        ],
      }),
    );

    expect(html).toContain('Known title');
    expect(html).toContain('Known description');
    expect(html).not.toContain('must not appear');
    expect(html).not.toContain('secret_field');
  });
});

describe('mentions', () => {
  test('a known id becomes a readable name rather than a raw snowflake', () => {
    const html = renderTranscriptHtml(
      input({ messages: [message({ content: `hi <@${HELPER}>` })] }),
    );

    expect(html).toContain('Helper');
  });

  test('an unknown id stays as escaped text, so nothing is invented about who it was', () => {
    const html = renderTranscriptHtml(
      input({ messages: [message({ content: 'hi <@100000000000000999>' })] }),
    );

    expect(html).toContain('100000000000000999');
  });
});

describe('the document as an artefact', () => {
  test('is byte-identical when rendered twice, so a test can assert on it at all', () => {
    const spec = input();

    expect(renderTranscriptHtml(spec)).toBe(renderTranscriptHtml(spec));
  });

  test('renders a valid document for a ticket nobody ever wrote in', async () => {
    const parsed = await parse(renderTranscriptHtml(input({ messages: [] })));

    expect(parsed.elements.has('html')).toBe(true);
    expect(parsed.elements.has('body')).toBe(true);
  });

  test('marks an edited message and a deleted one, which is why the record is worth keeping', () => {
    const html = renderTranscriptHtml(
      input({
        messages: [
          message({ messageId: '1', editedAt: new Date('2026-08-24T12:02:00Z') }),
          message({ id: 'm2', messageId: '2', deletedAt: new Date('2026-08-24T12:03:00Z') }),
        ],
      }),
    );

    expect(html.toLowerCase()).toContain('edited');
    expect(html.toLowerCase()).toContain('deleted');
  });

  test('names the file by a zero-padded ticket number and never truncates a longer one', () => {
    expect(transcriptFilename(ticket({ number: 42 }))).toBe('ticket-0042.html');
    expect(transcriptFilename(ticket({ number: 7 }))).toBe('ticket-0007.html');
    expect(transcriptFilename(ticket({ number: 123456 }))).toBe('ticket-123456.html');
  });

  test('the plain-text fallback carries the same facts as the page', () => {
    const text = renderTranscriptText(input());

    expect(text).toContain('42');
    expect(text).toContain('Support');
    expect(text).toContain('hello');
  });
});
