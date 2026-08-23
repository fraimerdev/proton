import { z } from 'zod';
import { sendPayloadSchema } from '../actions/payloads.ts';

const { content, embeds, components, poll, flags } = sendPayloadSchema.shape;

const NOTHING_TO_RENDER =
  'a message template needs content, an embed, a component or a poll — this one has none of them.';

export const messageTemplateSchema = z
  .object({ content, embeds, components, poll, flags })
  .refine(
    (template) =>
      Boolean(
        template.content?.length ||
          template.embeds?.length ||
          template.components?.length ||
          template.poll,
      ),
    { message: NOTHING_TO_RENDER },
  );

export type MessageTemplate = z.infer<typeof messageTemplateSchema>;

export type TemplateVars = Readonly<Record<string, string | number | boolean>>;

export type RenderedTemplate =
  | { ok: true; template: MessageTemplate; unknown: string[] }
  | { ok: false; humanReason: string; unknown: string[] };

const PLACEHOLDER = /\{([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\}/g;

function renderString(input: string, vars: TemplateVars, unknown: Set<string>): string {
  return input.replace(PLACEHOLDER, (placeholder, name: string) => {
    // Object.hasOwn, not a lookup-and-test: `{constructor}` would otherwise resolve up the
    // prototype chain and render a function body into somebody's welcome message.
    if (!Object.hasOwn(vars, name)) {
      unknown.add(name);
      return placeholder;
    }

    return String(vars[name]);
  });
}

export function substitute(
  value: unknown,
  vars: TemplateVars,
  unknown: Set<string> = new Set(),
): unknown {
  if (typeof value === 'string') return renderString(value, vars, unknown);
  if (Array.isArray(value)) return value.map((item) => substitute(item, vars, unknown));

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, substitute(nested, vars, unknown)]),
    );
  }

  return value;
}

export function renderTemplate(
  template: MessageTemplate,
  vars: TemplateVars = {},
): RenderedTemplate {
  const names = new Set<string>();
  const rendered = messageTemplateSchema.safeParse(substitute(template, vars, names));
  const unknown = [...names];

  if (rendered.success) return { ok: true, template: rendered.data, unknown };

  const detail = rendered.error.issues
    .map((issue) => `${issue.path.map(String).join('.') || 'the template'}: ${issue.message}`)
    .join('; ');

  return {
    ok: false,
    unknown,
    humanReason:
      `the variables rendered into this template made it invalid — ${detail}. A variable's ` +
      'value is longer than the field it was substituted into allows, or emptied it.',
  };
}
