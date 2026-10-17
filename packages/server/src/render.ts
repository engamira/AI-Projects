import mjml2html from 'mjml';
import type { BlockInstance, EmailContent, Props } from '@cl/shared';

// Turns the stored structured content into email HTML (via MJML).
// Every text and URL value is escaped here; content is also validated before it is ever saved.

const esc = (s: unknown): string =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const para = (s: unknown): string => esc(s).replace(/\r?\n/g, '<br/>');
const s = (p: Props, k: string): string => String(p[k] ?? '');
const n = (p: Props, k: string): number => Number(p[k] ?? 0);
const b = (p: Props, k: string): boolean => p[k] === true;
const hasText = (v: string): boolean => v.trim() !== '';
const href = (v: string): string => (v.trim() === '' ? '#' : esc(v));

type Ctx = { width: number };

function button(label: string, url: string, bg: string, color: string, o: { align?: string; radius?: number; container?: string; padding?: string; full?: boolean } = {}): string {
  return `<mj-button href="${href(url)}" background-color="${bg}" color="${color}" border-radius="${o.radius ?? 6}px" align="${o.align ?? 'center'}" font-size="16px" font-weight="700" inner-padding="12px 28px" padding="${o.padding ?? '8px 24px'}"${o.container ? ` container-background-color="${o.container}"` : ''}${o.full ? ' width="100%"' : ''}>${esc(label)}</mj-button>`;
}

function imageOrPlaceholder(src: string, alt: string, widthPx: number, link: string, o: { align?: string; padding?: string; bg?: string } = {}): string {
  if (!hasText(src)) {
    return `<mj-text align="center" color="#6b7280" font-size="14px" padding="${o.padding ?? '0'}" container-background-color="#e5e7eb"><div style="padding:32px 12px">Image placeholder: add a picture</div></mj-text>`;
  }
  return `<mj-image src="${esc(src)}" alt="${esc(alt)}" width="${widthPx}px" align="${o.align ?? 'center'}" padding="${o.padding ?? '0'}"${hasText(link) ? ` href="${esc(link)}"` : ''} />`;
}

function section(bg: string, py: number, px: number, inner: string): string {
  return `<mj-section background-color="${bg}" padding="${py}px ${px}px"><mj-column>${inner}</mj-column></mj-section>`;
}

const RENDERERS: Record<string, (p: Props, ctx: Ctx) => string> = {
  header: (p) => {
    const inner = hasText(s(p, 'logoUrl'))
      ? imageOrPlaceholder(s(p, 'logoUrl'), s(p, 'logoAlt'), n(p, 'logoWidth'), s(p, 'linkUrl'), { align: s(p, 'align') })
      : `<mj-text align="${s(p, 'align')}" color="${s(p, 'textColor')}" font-size="24px" font-weight="700" padding="0">${hasText(s(p, 'linkUrl')) ? `<a href="${esc(s(p, 'linkUrl'))}" style="color:${s(p, 'textColor')};text-decoration:none">${esc(s(p, 'brandName'))}</a>` : esc(s(p, 'brandName'))}</mj-text>`;
    return section(s(p, 'bgColor'), n(p, 'paddingY'), 24, inner);
  },

  hero: (p, ctx) => {
    const py = n(p, 'paddingY');
    const al = s(p, 'align');
    const img = hasText(s(p, 'imageUrl')) ? imageOrPlaceholder(s(p, 'imageUrl'), s(p, 'imageAlt'), ctx.width, '', { padding: '0' }) : '';
    const head = hasText(s(p, 'headline')) ? `<mj-text align="${al}" color="${s(p, 'textColor')}" font-size="32px" font-weight="700" line-height="1.25" padding="${py}px 24px 8px">${para(s(p, 'headline'))}</mj-text>` : '';
    const sub = hasText(s(p, 'subheadline')) ? `<mj-text align="${al}" color="${s(p, 'textColor')}" font-size="18px" line-height="1.5" padding="0 24px 8px">${para(s(p, 'subheadline'))}</mj-text>` : '';
    const btn = hasText(s(p, 'buttonText')) ? button(s(p, 'buttonText'), s(p, 'buttonUrl'), s(p, 'buttonColor'), s(p, 'buttonTextColor'), { align: al, padding: `8px 24px ${py}px` }) : `<mj-spacer height="${py}px" />`;
    return `<mj-section background-color="${s(p, 'bgColor')}" padding="0"><mj-column>${img}${head}${sub}${btn}</mj-column></mj-section>`;
  },

  text: (p) => {
    const al = s(p, 'align');
    const col = s(p, 'textColor');
    const px = n(p, 'paddingX');
    const head = hasText(s(p, 'heading')) ? `<mj-text align="${al}" color="${col}" font-size="${n(p, 'fontSize') + 6}px" font-weight="700" line-height="1.3" padding="0 0 8px">${para(s(p, 'heading'))}</mj-text>` : '';
    const body = hasText(s(p, 'body')) ? `<mj-text align="${al}" color="${col}" font-size="${n(p, 'fontSize')}px" line-height="1.6" padding="0">${para(s(p, 'body'))}</mj-text>` : '';
    return section(s(p, 'bgColor'), n(p, 'paddingY'), px, head + body || '<mj-spacer height="1px" />');
  },

  image: (p, ctx) => {
    const px = Math.round((ctx.width * n(p, 'widthPercent')) / 100);
    const alt = b(p, 'decorative') ? '' : s(p, 'alt');
    return section(s(p, 'bgColor'), n(p, 'paddingY'), 0, imageOrPlaceholder(s(p, 'src'), alt, px, s(p, 'linkUrl'), { align: s(p, 'align') }));
  },

  button: (p) =>
    section(s(p, 'containerBg'), n(p, 'paddingY'), 24, button(s(p, 'label'), s(p, 'url'), s(p, 'bgColor'), s(p, 'textColor'), { align: s(p, 'align'), radius: n(p, 'borderRadius'), container: s(p, 'containerBg'), padding: '0', full: b(p, 'fullWidth') })),

  two_column: (p, ctx) => {
    const col = (side: 'left' | 'right'): string => {
      const k = (x: string) => `${side}${x}`;
      const half = Math.floor(ctx.width / 2);
      return [
        hasText(s(p, k('Image'))) ? imageOrPlaceholder(s(p, k('Image')), s(p, k('ImageAlt')), half, '', { padding: '0 0 12px' }) : '',
        hasText(s(p, k('Heading'))) ? `<mj-text color="${s(p, 'textColor')}" font-size="20px" font-weight="700" padding="0 0 6px">${para(s(p, k('Heading')))}</mj-text>` : '',
        hasText(s(p, k('Body'))) ? `<mj-text color="${s(p, 'textColor')}" font-size="15px" line-height="1.5" padding="0 0 10px">${para(s(p, k('Body')))}</mj-text>` : '',
        hasText(s(p, k('ButtonText'))) ? button(s(p, k('ButtonText')), s(p, k('ButtonUrl')), s(p, 'buttonColor'), s(p, 'buttonTextColor'), { align: 'left', padding: '0' }) : '',
      ].join('');
    };
    const py = n(p, 'paddingY');
    return `<mj-section background-color="${s(p, 'bgColor')}" padding="${py}px 12px"><mj-column padding="0 12px">${col('left') || '<mj-spacer height="1px" />'}</mj-column><mj-column padding="0 12px">${col('right') || '<mj-spacer height="1px" />'}</mj-column></mj-section>`;
  },

  divider: (p) => `<mj-section background-color="transparent" padding="0"><mj-column><mj-divider border-color="${s(p, 'color')}" border-width="${n(p, 'thickness')}px" width="${n(p, 'widthPercent')}%" padding="${n(p, 'paddingY')}px 24px" /></mj-column></mj-section>`,

  spacer: (p) => `<mj-section padding="0"><mj-column><mj-spacer height="${n(p, 'height')}px" /></mj-column></mj-section>`,

  social: (p) => {
    const nets: [string, string][] = [['facebook', 'Facebook'], ['instagram', 'Instagram'], ['x', 'X'], ['linkedin', 'LinkedIn'], ['youtube', 'YouTube']];
    const links = nets
      .filter(([k]) => hasText(s(p, k)))
      .map(([k, label]) => `<a href="${esc(s(p, k))}" style="color:${s(p, 'textColor')};text-decoration:underline">${label}</a>`);
    const inner = links.length ? `<mj-text align="${s(p, 'align')}" font-size="15px" padding="0">${links.join(' &nbsp;·&nbsp; ')}</mj-text>` : '<mj-spacer height="1px" />';
    return section(s(p, 'bgColor'), n(p, 'paddingY'), 24, inner);
  },

  footer: (p) => {
    const lines = [
      hasText(s(p, 'companyName')) ? `<strong>${esc(s(p, 'companyName'))}</strong>` : '',
      hasText(s(p, 'address')) ? esc(s(p, 'address')) : '',
      hasText(s(p, 'notice')) ? para(s(p, 'notice')) : '',
      hasText(s(p, 'unsubscribeText')) ? `<a href="${href(s(p, 'unsubscribeUrl'))}" style="color:${s(p, 'linkColor')};text-decoration:underline">${esc(s(p, 'unsubscribeText'))}</a>` : '',
    ].filter(Boolean);
    return section(s(p, 'bgColor'), n(p, 'paddingY'), 24, `<mj-text align="${s(p, 'align')}" color="${s(p, 'textColor')}" font-size="13px" line-height="1.6" padding="0">${lines.join('<br/>')}</mj-text>`);
  },
};

export function renderBlock(block: BlockInstance, ctx: Ctx): string {
  const r = RENDERERS[block.type];
  if (!r) throw new Error(`No renderer for block type ${block.type}`);
  return r(block.props, ctx);
}

export function buildMjml(content: EmailContent): string {
  const { settings: st, blocks } = content;
  const ctx: Ctx = { width: st.contentWidth };
  const body = blocks.length ? blocks.map((x) => renderBlock(x, ctx)).join('\n') : '<mj-section><mj-column><mj-text>&nbsp;</mj-text></mj-column></mj-section>';
  return `<mjml>
<mj-head>
  <mj-title>${esc(st.subject)}</mj-title>
  <mj-preview>${esc(st.preheader)}</mj-preview>
  <mj-attributes><mj-all font-family="${esc(st.fontFamily)}" /><mj-text padding="0" /></mj-attributes>
</mj-head>
<mj-body width="${st.contentWidth}px" background-color="${st.backgroundColor}">
<mj-wrapper padding="0" background-color="${st.contentBackground}">
${body}
</mj-wrapper>
</mj-body>
</mjml>`;
}

/** The one place that produces email HTML: preview, QA and sending all use this output. */
export async function renderEmail(content: EmailContent): Promise<{ html: string; warnings: string[] }> {
  const out = await mjml2html(buildMjml(content), { validationLevel: 'soft', minify: false });
  return { html: out.html, warnings: out.errors.map((e) => e.formattedMessage ?? e.message ?? 'Unknown MJML warning') };
}
