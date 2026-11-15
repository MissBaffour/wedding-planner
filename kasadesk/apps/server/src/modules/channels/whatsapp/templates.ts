/**
 * Template helpers. Template components come from Meta's template API, e.g.
 *   [{ type: 'HEADER', format: 'TEXT', text: 'Order {{1}}' }, { type: 'BODY', text: 'Hi {{1}}, your total is {{2}}' }, ...]
 * Positional {{n}} parameters only; named parameters are not supported yet.
 */
export interface TemplateComponent {
  type: string;
  format?: string;
  text?: string;
  [k: string]: unknown;
}

const PLACEHOLDER = /\{\{(\d+)\}\}/g;

export function countParams(text: string | undefined): number {
  if (!text) return 0;
  let max = 0;
  for (const m of text.matchAll(PLACEHOLDER)) max = Math.max(max, Number(m[1]));
  return max;
}

export function templateParamCounts(components: TemplateComponent[]) {
  const header = components.find((c) => c.type.toUpperCase() === 'HEADER');
  const body = components.find((c) => c.type.toUpperCase() === 'BODY');
  return {
    header: header && (header.format ?? 'TEXT').toUpperCase() === 'TEXT' ? countParams(header.text) : 0,
    body: countParams(body?.text),
  };
}

export function render(text: string | undefined, values: string[]): string {
  return (text ?? '').replace(PLACEHOLDER, (_, n) => values[Number(n) - 1] ?? `{{${n}}}`);
}

export interface TemplateInput {
  headerParams?: string[];
  bodyParams?: string[];
}

/** Build the send-API `components` array and a plain-text preview for the inbox. */
export function buildTemplateSend(components: TemplateComponent[], input: TemplateInput) {
  const counts = templateParamCounts(components);
  const header = input.headerParams ?? [];
  const body = input.bodyParams ?? [];
  if (header.length !== counts.header) throw new Error(`template header needs ${counts.header} parameter(s), got ${header.length}`);
  if (body.length !== counts.body) throw new Error(`template body needs ${counts.body} parameter(s), got ${body.length}`);
  if ([...header, ...body].some((v) => !v.trim())) throw new Error('template parameters must not be empty');

  const sendComponents: unknown[] = [];
  if (header.length) sendComponents.push({ type: 'header', parameters: header.map((text) => ({ type: 'text', text })) });
  if (body.length) sendComponents.push({ type: 'body', parameters: body.map((text) => ({ type: 'text', text })) });

  const headerText = components.find((c) => c.type.toUpperCase() === 'HEADER' && (c.format ?? 'TEXT').toUpperCase() === 'TEXT')?.text;
  const bodyText = components.find((c) => c.type.toUpperCase() === 'BODY')?.text;
  const footer = components.find((c) => c.type.toUpperCase() === 'FOOTER')?.text;
  const preview = [headerText && render(headerText, header), render(bodyText, body), footer].filter(Boolean).join('\n');
  return { components: sendComponents, preview };
}
