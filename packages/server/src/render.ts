import mjml2html from 'mjml';
import { ASSET_REF, defaultBrand, normalizeContent, paletteOf, type BlockInstance, type EmailContent, type Palette, type Props } from '@cl/shared';

// Turns the stored structured content into email HTML (via MJML).
// Every text and URL value is escaped here; content is also validated before it is ever saved.
// Colors are never read from block properties: they all come from the campaign's template palette.

const esc = (s: unknown): string =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const para = (s: unknown): string => esc(s).replace(/\r?\n/g, '<br/>');
const s = (p: Props, k: string): string => String(p[k] ?? '');
const n = (p: Props, k: string): number => Number(p[k] ?? 0);
const b = (p: Props, k: string): boolean => p[k] === true;
const hasText = (v: string): boolean => v.trim() !== '';
const href = (v: string): string => (v.trim() === '' ? '#' : esc(v));

type Ctx = { width: number; c: Palette };

function button(label: string, url: string, bg: string, color: string, o: { align?: string; radius?: number; container?: string; padding?: string; full?: boolean; cssClass?: string } = {}): string {
  return `<mj-button${o.cssClass ? ` css-class="${o.cssClass}"` : ''} href="${href(url)}" background-color="${bg}" color="${color}" border-radius="${o.radius ?? 6}px" align="${o.align ?? 'center'}" font-size="16px" font-weight="700" inner-padding="12px 28px" padding="${o.padding ?? '8px 24px'}"${o.container ? ` container-background-color="${o.container}"` : ''}${o.full ? ' width="100%"' : ''}>${esc(label)}</mj-button>`;
}

function imageOrPlaceholder(ctx: Ctx, src: string, alt: string, widthPx: number, link: string, o: { align?: string; padding?: string; cssClass?: string } = {}): string {
  if (!hasText(src)) {
    return `<mj-text${o.cssClass ? ` css-class="${o.cssClass}"` : ''} align="center" color="${ctx.c.muted}" font-size="14px" padding="${o.padding ?? '0'}" container-background-color="${ctx.c.placeholder}"><div style="padding:32px 12px">Image placeholder: add a picture</div></mj-text>`;
  }
  return `<mj-image${o.cssClass ? ` css-class="${o.cssClass}"` : ''} src="${esc(src)}" alt="${esc(alt)}" width="${widthPx}px" align="${o.align ?? 'center'}" padding="${o.padding ?? '0'}"${hasText(link) ? ` href="${esc(link)}"` : ''} />`;
}

function section(bg: string, py: number, px: number, inner: string): string {
  return `<mj-section background-color="${bg}" padding="${py}px ${px}px"><mj-column>${inner}</mj-column></mj-section>`;
}

/** Marks content that is centered on phones (see the phone-only rules in the email head). */
const MOBILE_CENTER = 'mobile-center';

const RENDERERS: Record<string, (p: Props, ctx: Ctx) => string> = {
  header: (p, ctx) => {
    const inner = hasText(s(p, 'logoUrl'))
      ? imageOrPlaceholder(ctx, s(p, 'logoUrl'), s(p, 'logoAlt'), n(p, 'logoWidth'), s(p, 'linkUrl'), { align: s(p, 'align') })
      : `<mj-text align="${s(p, 'align')}" color="${ctx.c.text}" font-size="24px" font-weight="700" padding="0">${hasText(s(p, 'linkUrl')) ? `<a href="${esc(s(p, 'linkUrl'))}" style="color:${ctx.c.text};text-decoration:none">${esc(s(p, 'brandName'))}</a>` : esc(s(p, 'brandName'))}</mj-text>`;
    return section(ctx.c.surface, n(p, 'paddingY'), 24, inner);
  },

  hero: (p, ctx) => {
    const c = ctx.c;
    const py = n(p, 'paddingY');
    const al = s(p, 'align');
    const img = hasText(s(p, 'imageUrl')) ? imageOrPlaceholder(ctx, s(p, 'imageUrl'), s(p, 'imageAlt'), ctx.width, '', { padding: '0' }) : '';
    const head = hasText(s(p, 'headline')) ? `<mj-text align="${al}" color="${c.onPrimary}" font-size="32px" font-weight="700" line-height="1.25" padding="${py}px 24px 8px">${para(s(p, 'headline'))}</mj-text>` : '';
    const sub = hasText(s(p, 'subheadline')) ? `<mj-text align="${al}" color="${c.onPrimary}" font-size="18px" line-height="1.5" padding="0 24px 8px">${para(s(p, 'subheadline'))}</mj-text>` : '';
    const btn = hasText(s(p, 'buttonText')) ? button(s(p, 'buttonText'), s(p, 'buttonUrl'), c.heroButton, c.onHeroButton, { align: al, padding: `8px 24px ${py}px` }) : `<mj-spacer height="${py}px" />`;
    return `<mj-section background-color="${c.primary}" padding="0"><mj-column>${img}${head}${sub}${btn}</mj-column></mj-section>`;
  },

  text: (p, ctx) => {
    const al = s(p, 'align');
    const col = ctx.c.text;
    const head = hasText(s(p, 'heading')) ? `<mj-text align="${al}" color="${col}" font-size="${n(p, 'fontSize') + 6}px" font-weight="700" line-height="1.3" padding="0 0 8px">${para(s(p, 'heading'))}</mj-text>` : '';
    const body = hasText(s(p, 'body')) ? `<mj-text align="${al}" color="${col}" font-size="${n(p, 'fontSize')}px" line-height="1.6" padding="0">${para(s(p, 'body'))}</mj-text>` : '';
    return section(ctx.c.surface, n(p, 'paddingY'), n(p, 'paddingX'), head + body || '<mj-spacer height="1px" />');
  },

  image: (p, ctx) => {
    const px = Math.round((ctx.width * n(p, 'widthPercent')) / 100);
    const alt = b(p, 'decorative') ? '' : s(p, 'alt');
    return section(ctx.c.surface, n(p, 'paddingY'), 0, imageOrPlaceholder(ctx, s(p, 'src'), alt, px, s(p, 'linkUrl'), { align: s(p, 'align') }));
  },

  button: (p, ctx) =>
    section(ctx.c.surface, n(p, 'paddingY'), 24, button(s(p, 'label'), s(p, 'url'), ctx.c.button, ctx.c.onButton, { align: s(p, 'align'), radius: n(p, 'borderRadius'), container: ctx.c.surface, padding: '0', full: b(p, 'fullWidth') })),

  two_column: (p, ctx) => {
    const c = ctx.c;
    const col = (side: 'left' | 'right'): string => {
      const k = (x: string) => `${side}${x}`;
      const half = Math.floor(ctx.width / 2);
      return [
        hasText(s(p, k('Image'))) ? imageOrPlaceholder(ctx, s(p, k('Image')), s(p, k('ImageAlt')), half, '', { padding: '0 0 12px', cssClass: MOBILE_CENTER }) : '',
        hasText(s(p, k('Heading'))) ? `<mj-text css-class="${MOBILE_CENTER}" color="${c.text}" font-size="20px" font-weight="700" padding="0 0 6px">${para(s(p, k('Heading')))}</mj-text>` : '',
        hasText(s(p, k('Body'))) ? `<mj-text css-class="${MOBILE_CENTER}" color="${c.text}" font-size="15px" line-height="1.5" padding="0 0 10px">${para(s(p, k('Body')))}</mj-text>` : '',
        hasText(s(p, k('ButtonText'))) ? button(s(p, k('ButtonText')), s(p, k('ButtonUrl')), c.button, c.onButton, { align: 'left', padding: '0', cssClass: MOBILE_CENTER }) : '',
      ].join('');
    };
    const py = n(p, 'paddingY');
    // 24px under each column: when they stack on a phone the two items do not touch (desktop spacing is unchanged)
    const gap = 24;
    return `<mj-section background-color="${c.surface}" padding="${py}px 12px ${Math.max(0, py - gap)}px"><mj-column padding="0 12px ${gap}px">${col('left') || '<mj-spacer height="1px" />'}</mj-column><mj-column padding="0 12px ${gap}px">${col('right') || '<mj-spacer height="1px" />'}</mj-column></mj-section>`;
  },

  divider: (p, ctx) => `<mj-section background-color="${ctx.c.surface}" padding="0"><mj-column><mj-divider border-color="${ctx.c.divider}" border-width="${n(p, 'thickness')}px" width="${n(p, 'widthPercent')}%" padding="${n(p, 'paddingY')}px 24px" /></mj-column></mj-section>`,

  spacer: (p, ctx) => `<mj-section background-color="${ctx.c.surface}" padding="0"><mj-column><mj-spacer height="${n(p, 'height')}px" /></mj-column></mj-section>`,

  social: (p, ctx) => {
    const nets: [string, string][] = [['facebook', 'Facebook'], ['instagram', 'Instagram'], ['x', 'X'], ['linkedin', 'LinkedIn'], ['youtube', 'YouTube']];
    const links = nets
      .filter(([k]) => hasText(s(p, k)))
      .map(([k, label]) => `<a href="${esc(s(p, k))}" style="color:${ctx.c.link};text-decoration:underline">${label}</a>`);
    const inner = links.length ? `<mj-text align="${s(p, 'align')}" font-size="15px" padding="0">${links.join(' &nbsp;·&nbsp; ')}</mj-text>` : '<mj-spacer height="1px" />';
    return section(ctx.c.surface, n(p, 'paddingY'), 24, inner);
  },

  footer: (p, ctx) => {
    const c = ctx.c;
    const nets: [string, string][] = [['facebook', 'Facebook'], ['instagram', 'Instagram'], ['x', 'X'], ['linkedin', 'LinkedIn'], ['youtube', 'YouTube']];
    const social = nets.filter(([k]) => hasText(s(p, k))).map(([k, label]) => `<a href="${esc(s(p, k))}" style="color:${c.footerLink};text-decoration:underline">${label}</a>`);
    const lines = [
      social.length ? social.join(' &nbsp;·&nbsp; ') : '',
      hasText(s(p, 'companyName')) ? `<strong>${esc(s(p, 'companyName'))}</strong>` : '',
      hasText(s(p, 'address')) ? esc(s(p, 'address')) : '',
      hasText(s(p, 'notice')) ? para(s(p, 'notice')) : '',
      hasText(s(p, 'unsubscribeText')) ? `<a href="${href(s(p, 'unsubscribeUrl'))}" style="color:${c.footerLink};text-decoration:underline">${esc(s(p, 'unsubscribeText'))}</a>` : '',
    ].filter(Boolean);
    return section(c.footerBg, n(p, 'paddingY'), 24, `<mj-text align="${s(p, 'align')}" color="${c.footerText}" font-size="13px" line-height="1.6" padding="0">${lines.join('<br/>')}</mj-text>`);
  },
};

// ---------- Template-specific blocks ----------

/**
 * Email apps cannot crop pictures, so library pictures used in fixed shapes (round speaker photos, equal-height cards)
 * are requested as ready-made crops of the right shape. Pictures from other websites are left as they are.
 */
const crop = (url: string, variant: string): string => url.replace(/(\/media\/[0-9a-f-]{36})$/i, `$1/${variant}`);

const sectionHeading = (t: string, c: Palette, bg: string, color: string, py: number): string =>
  hasText(t) ? `<mj-section background-color="${bg}" padding="${py}px 24px 8px"><mj-column><mj-text align="center" color="${color}" font-size="24px" font-weight="700" line-height="1.3" padding="0">${para(t)}</mj-text></mj-column></mj-section>` : '';

/** A row of up to three equal columns (they stack on phones). Empty columns are left out. */
function columnsRow(bg: string, cols: string[], py: number, topPad = 0): string {
  const used = cols.filter((x) => x.trim() !== '');
  if (!used.length) return `<mj-section background-color="${bg}" padding="0"><mj-column><mj-spacer height="${py}px" /></mj-column></mj-section>`;
  // each column keeps 16px below it, so cards that stack on a phone do not touch
  return `<mj-section background-color="${bg}" padding="${topPad}px 12px ${Math.max(0, py - 16)}px">${used.map((x) => `<mj-column padding="0 12px 16px">${x}</mj-column>`).join('')}</mj-section>`;
}

/** Cards (destinations, products): picture, name, detail, price and a button. */
function cardsBlock(p: Props, ctx: Ctx, noun: 'c'): string {
  const c = ctx.c;
  const third = Math.floor(ctx.width / 3);
  const cols = [1, 2, 3].map((i) => {
    const k = (x: string) => `${noun}${i}${x}`;
    if (!['Image', 'Name', 'Detail', 'Price', 'ButtonText'].some((x) => hasText(s(p, k(x))))) return '';
    return [
      imageOrPlaceholder(ctx, crop(s(p, k('Image')), 'card-480.jpg'), s(p, k('ImageAlt')), third, '', { padding: '0 0 12px' }),
      hasText(s(p, k('Name'))) ? `<mj-text align="center" color="${c.text}" font-size="18px" font-weight="700" padding="0 0 2px">${para(s(p, k('Name')))}</mj-text>` : '',
      hasText(s(p, k('Detail'))) ? `<mj-text align="center" color="${c.muted}" font-size="14px" padding="0 0 4px">${para(s(p, k('Detail')))}</mj-text>` : '',
      hasText(s(p, k('Price'))) ? `<mj-text align="center" color="${c.link}" font-size="17px" font-weight="700" padding="0 0 10px">${para(s(p, k('Price')))}</mj-text>` : '',
      hasText(s(p, k('ButtonText'))) ? button(s(p, k('ButtonText')), s(p, k('ButtonUrl')), c.button, c.onButton, { align: 'center', padding: '0' }) : '',
    ].join('');
  });
  const py = n(p, 'paddingY');
  return sectionHeading(s(p, 'heading'), c, c.surface, c.text, py) + columnsRow(c.surface, cols, py, 12);
}

/** Closing call to action (booking, registration, shopping). */
function ctaBlock(p: Props, ctx: Ctx): string {
  const c = ctx.c;
  const al = s(p, 'align');
  const inner = [
    hasText(s(p, 'heading')) ? `<mj-text align="${al}" color="${c.text}" font-size="28px" font-weight="700" line-height="1.25" padding="0 0 8px">${para(s(p, 'heading'))}</mj-text>` : '',
    hasText(s(p, 'text')) ? `<mj-text align="${al}" color="${c.text}" font-size="16px" line-height="1.6" padding="0 0 16px">${para(s(p, 'text'))}</mj-text>` : '',
    hasText(s(p, 'buttonText')) ? button(s(p, 'buttonText'), s(p, 'buttonUrl'), c.button, c.onButton, { align: al, padding: '0 0 10px' }) : '',
    hasText(s(p, 'note')) ? `<mj-text align="${al}" color="${c.muted}" font-size="13px" padding="0">${para(s(p, 'note'))}</mj-text>` : '',
  ].join('');
  return section(c.surface, n(p, 'paddingY'), 24, inner || '<mj-spacer height="1px" />');
}

const SPECIALTY_RENDERERS: Record<string, (p: Props, ctx: Ctx) => string> = {
  // ----- Travel -----
  destinations: (p, ctx) => cardsBlock(p, ctx, 'c'),

  fares: (p, ctx) => {
    const c = ctx.c;
    const py = n(p, 'paddingY');
    const rows = [1, 2, 3, 4, 5]
      .filter((i) => hasText(s(p, `r${i}Route`)) || hasText(s(p, `r${i}Price`)))
      .map((i) => `<tr style="border-bottom:1px solid ${c.divider}"><td style="padding:12px 0;color:${c.text}">${esc(s(p, `r${i}Route`))}</td><td align="right" style="padding:12px 0;font-weight:700;color:${c.text}">${esc(s(p, `r${i}Price`))}</td></tr>`)
      .join('');
    const table = rows ? `<mj-table padding="0 0 8px" font-size="16px" cellpadding="0" cellspacing="0" width="100%">${rows}</mj-table>` : '';
    const note = hasText(s(p, 'note')) ? `<mj-text align="center" color="${c.muted}" font-size="13px" padding="0 0 14px">${para(s(p, 'note'))}</mj-text>` : '';
    const btn = hasText(s(p, 'buttonText')) ? button(s(p, 'buttonText'), s(p, 'buttonUrl'), c.button, c.onButton, { align: 'center', padding: '0' }) : '';
    return sectionHeading(s(p, 'heading'), c, c.surface, c.text, py) + section(c.surface, 4, 40, table + note + btn || '<mj-spacer height="1px" />') + `<mj-section background-color="${c.surface}" padding="0"><mj-column><mj-spacer height="${py}px" /></mj-column></mj-section>`;
  },

  travel_offer: (p, ctx) => {
    const c = ctx.c;
    const al = s(p, 'align');
    const inner = [
      hasText(s(p, 'eyebrow')) ? `<mj-text align="${al}" color="${c.onDark}" font-size="13px" font-weight="700" letter-spacing="2px" padding="0 0 6px">${esc(s(p, 'eyebrow').toUpperCase())}</mj-text>` : '',
      hasText(s(p, 'highlight')) ? `<mj-text align="${al}" color="${c.primary}" font-size="34px" font-weight="700" line-height="1.2" padding="0 0 6px">${para(s(p, 'highlight'))}</mj-text>` : '',
      hasText(s(p, 'headline')) ? `<mj-text align="${al}" color="${c.onDark}" font-size="18px" line-height="1.5" padding="0 0 14px">${para(s(p, 'headline'))}</mj-text>` : '',
      hasText(s(p, 'buttonText')) ? button(s(p, 'buttonText'), s(p, 'buttonUrl'), c.primary, c.onPrimary, { align: al, padding: '0' }) : '',
    ].join('');
    return section(c.dark, n(p, 'paddingY'), 24, inner || '<mj-spacer height="1px" />');
  },

  booking_cta: ctaBlock,

  // ----- Events -----
  event_details: (p, ctx) => {
    const c = ctx.c;
    const py = n(p, 'paddingY');
    const head = [
      hasText(s(p, 'eyebrow')) ? `<mj-text align="center" color="${c.onPrimary}" font-size="13px" font-weight="700" letter-spacing="2px" padding="0 0 6px">${esc(s(p, 'eyebrow').toUpperCase())}</mj-text>` : '',
      hasText(s(p, 'title')) ? `<mj-text align="center" color="${c.onPrimary}" font-size="32px" font-weight="700" line-height="1.2" padding="0">${para(s(p, 'title'))}</mj-text>` : '',
    ].join('');
    const fact = (label: string, value: string) =>
      hasText(value) ? `<mj-text align="center" color="${c.onPrimary}" font-size="12px" font-weight="700" letter-spacing="1.5px" padding="0 0 4px">${esc(label.toUpperCase())}</mj-text><mj-text align="center" color="${c.onPrimary}" font-size="18px" font-weight="700" padding="0 0 12px">${para(value)}</mj-text>` : '';
    const facts = [fact(s(p, 'dateLabel'), s(p, 'dateValue')), fact(s(p, 'timeLabel'), s(p, 'timeValue')), fact(s(p, 'placeLabel'), s(p, 'placeValue'))];
    const foot = [
      hasText(s(p, 'address')) ? `<mj-text align="center" color="${c.onPrimary}" font-size="14px" padding="0 0 14px">${para(s(p, 'address'))}</mj-text>` : '',
      hasText(s(p, 'buttonText')) ? button(s(p, 'buttonText'), s(p, 'buttonUrl'), c.heroButton, c.onHeroButton, { align: 'center', padding: '0' }) : '',
    ].join('');
    return `<mj-section background-color="${c.primary}" padding="${py}px 24px 16px"><mj-column>${head || '<mj-spacer height="1px" />'}</mj-column></mj-section>`
      + columnsRow(c.primary, facts, 0, 4)
      + `<mj-section background-color="${c.primary}" padding="4px 24px ${py}px"><mj-column>${foot || '<mj-spacer height="1px" />'}</mj-column></mj-section>`;
  },

  agenda: (p, ctx) => {
    const c = ctx.c;
    const py = n(p, 'paddingY');
    const rows = [1, 2, 3, 4, 5, 6]
      .filter((i) => hasText(s(p, `s${i}Title`)) || hasText(s(p, `s${i}Time`)))
      .map((i) => `<mj-section background-color="${c.surface}" padding="12px 24px" border-bottom="1px solid ${c.divider}">`
        + `<mj-column width="24%"><mj-text color="${c.link}" font-size="16px" font-weight="700" padding="0">${esc(s(p, `s${i}Time`))}</mj-text></mj-column>`
        + `<mj-column width="76%"><mj-text color="${c.text}" font-size="16px" font-weight="700" padding="0 0 2px">${para(s(p, `s${i}Title`))}</mj-text>${hasText(s(p, `s${i}Text`)) ? `<mj-text color="${c.muted}" font-size="14px" line-height="1.5" padding="0">${para(s(p, `s${i}Text`))}</mj-text>` : ''}</mj-column></mj-section>`)
      .join('');
    return sectionHeading(s(p, 'heading'), c, c.surface, c.text, py) + (rows || '') + `<mj-section background-color="${c.surface}" padding="0"><mj-column><mj-spacer height="${Math.round(py / 2)}px" /></mj-column></mj-section>`;
  },

  speakers: (p, ctx) => {
    const c = ctx.c;
    const py = n(p, 'paddingY');
    const cols = [1, 2, 3].map((i) => {
      const k = (x: string) => `p${i}${x}`;
      if (!['Image', 'Name', 'Role', 'Bio'].some((x) => hasText(s(p, k(x))))) return '';
      const img = hasText(s(p, k('Image')))
        ? `<mj-image src="${esc(crop(s(p, k('Image')), 'square-240.jpg'))}" alt="${esc(s(p, k('ImageAlt')))}" width="120px" height="120px" border-radius="999px" align="center" padding="0 0 10px" />`
        : `<mj-text align="center" color="${c.muted}" font-size="13px" padding="0 0 10px"><div style="width:120px;height:120px;line-height:120px;margin:0 auto;border-radius:60px;background:${c.placeholder}">Photo</div></mj-text>`;
      return img
        + (hasText(s(p, k('Name'))) ? `<mj-text align="center" color="${c.text}" font-size="18px" font-weight="700" padding="0 0 2px">${para(s(p, k('Name')))}</mj-text>` : '')
        + (hasText(s(p, k('Role'))) ? `<mj-text align="center" color="${c.link}" font-size="14px" font-weight="700" padding="0 0 6px">${para(s(p, k('Role')))}</mj-text>` : '')
        + (hasText(s(p, k('Bio'))) ? `<mj-text align="center" color="${c.muted}" font-size="14px" line-height="1.5" padding="0">${para(s(p, k('Bio')))}</mj-text>` : '');
    });
    return sectionHeading(s(p, 'heading'), c, c.surface, c.text, py) + columnsRow(c.surface, cols, py, 12);
  },

  registration_cta: ctaBlock,

  // ----- Cosmetics -----
  products: (p, ctx) => cardsBlock(p, ctx, 'c'),

  benefits: (p, ctx) => {
    const c = ctx.c;
    const py = n(p, 'paddingY');
    const cols = [1, 2, 3].map((i) => {
      if (!hasText(s(p, `b${i}Title`)) && !hasText(s(p, `b${i}Text`))) return '';
      return `<mj-text align="center" color="${c.secondary}" font-size="18px" padding="0 0 8px"><span style="display:inline-block;width:36px;height:36px;line-height:36px;border-radius:18px;background:${c.onSecondary};color:${c.secondary};font-weight:700">✓</span></mj-text>`
        + (hasText(s(p, `b${i}Title`)) ? `<mj-text align="center" color="${c.onSecondary}" font-size="17px" font-weight="700" padding="0 0 4px">${para(s(p, `b${i}Title`))}</mj-text>` : '')
        + (hasText(s(p, `b${i}Text`)) ? `<mj-text align="center" color="${c.onSecondary}" font-size="14px" line-height="1.5" padding="0">${para(s(p, `b${i}Text`))}</mj-text>` : '');
    });
    return `<mj-section background-color="${c.secondary}" padding="${py}px 24px 8px"><mj-column>${hasText(s(p, 'heading')) ? `<mj-text align="center" color="${c.onSecondary}" font-size="24px" font-weight="700" padding="0 0 8px">${para(s(p, 'heading'))}</mj-text>` : '<mj-spacer height="1px" />'}</mj-column></mj-section>`
      + columnsRow(c.secondary, cols, py, 8);
  },

  promo_offer: (p, ctx) => {
    const c = ctx.c;
    const al = s(p, 'align');
    const code = hasText(s(p, 'code'))
      ? `<mj-text align="${al}" color="${c.onAccent}" font-size="15px" padding="0 0 12px">${hasText(s(p, 'codeLabel')) ? `${esc(s(p, 'codeLabel'))}&nbsp; ` : ''}<span style="display:inline-block;padding:8px 16px;border-radius:6px;background:${c.surface};color:${c.text};font-weight:700;letter-spacing:2px">${esc(s(p, 'code'))}</span></mj-text>`
      : '';
    const inner = [
      hasText(s(p, 'eyebrow')) ? `<mj-text align="${al}" color="${c.onAccent}" font-size="13px" font-weight="700" letter-spacing="2px" padding="0 0 6px">${esc(s(p, 'eyebrow').toUpperCase())}</mj-text>` : '',
      hasText(s(p, 'headline')) ? `<mj-text align="${al}" color="${c.onAccent}" font-size="34px" font-weight="700" line-height="1.2" padding="0 0 12px">${para(s(p, 'headline'))}</mj-text>` : '',
      code,
      hasText(s(p, 'buttonText')) ? button(s(p, 'buttonText'), s(p, 'buttonUrl'), c.dark, c.onDark, { align: al, padding: '0 0 10px' }) : '',
      hasText(s(p, 'terms')) ? `<mj-text align="${al}" color="${c.onAccent}" font-size="12px" padding="0">${para(s(p, 'terms'))}</mj-text>` : '',
    ].join('');
    return section(c.accent, n(p, 'paddingY'), 24, inner || '<mj-spacer height="1px" />');
  },

  shopping_cta: ctaBlock,
};
Object.assign(RENDERERS, SPECIALTY_RENDERERS);

export function renderBlock(block: BlockInstance, ctx: Ctx): string {
  const r = RENDERERS[block.type];
  if (!r) throw new Error(`No renderer for block type ${block.type}`);
  return r(block.props, ctx);
}

export type BrandParts = { header: Props; footer: Props };
export type RenderOptions = { baseUrl?: string; brand?: BrandParts };

/** Pictures from the asset library are stored as "asset:<id>"; emails need real web addresses. */
function resolveAssets<T>(value: T, baseUrl: string): T {
  if (typeof value === 'string') {
    const m = ASSET_REF.exec(value);
    return (m ? `${baseUrl}/media/${m[1]!.toLowerCase()}` : value) as T;
  }
  if (Array.isArray(value)) return value.map((v) => resolveAssets(v, baseUrl)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveAssets(v, baseUrl)])) as T;
  return value;
}

export function buildMjml(input: EmailContent, opts: RenderOptions = {}): string {
  const baseUrl = (opts.baseUrl ?? 'http://localhost:3000').replace(/\/+$/, '');
  const content = resolveAssets(normalizeContent(input), baseUrl); // older saved emails may still hold color properties; they are ignored
  const { settings: st, blocks } = content;
  const c = paletteOf(st.palette);
  const ctx: Ctx = { width: st.contentWidth, c };
  // Every email of a template starts with that template's shared header and ends with its shared footer.
  const brand = resolveAssets(opts.brand ?? defaultBrand(c.id), baseUrl);
  const body = [RENDERERS.header!(brand.header, ctx), ...blocks.map((x) => renderBlock(x, ctx)), RENDERERS.footer!(brand.footer, ctx)].join('\n');
  return `<mjml>
<mj-head>
  <mj-title>${esc(st.subject)}</mj-title>
  <mj-preview>${esc(st.preheader)}</mj-preview>
  <mj-style>
    /* Phones (below 480px, where columns stack): center the content of blocks that ask for it. Wider screens are not affected. */
    @media only screen and (max-width: 479px) {
      .mobile-center, .mobile-center div, .mobile-center td, .mobile-center p { text-align: center !important; }
      .mobile-center table { margin-left: auto !important; margin-right: auto !important; }
      .mobile-center img { margin-left: auto !important; margin-right: auto !important; }
    }
  </mj-style>
  <mj-attributes><mj-all font-family="${esc(st.fontFamily)}" /><mj-text padding="0" /></mj-attributes>
</mj-head>
<mj-body width="${st.contentWidth}px" background-color="${c.page}">
<mj-wrapper padding="0" background-color="${c.surface}">
${body}
</mj-wrapper>
</mj-body>
</mjml>`;
}

/** The one place that produces email HTML: preview, QA and sending all use this output. */
export async function renderEmail(content: EmailContent, opts: RenderOptions = {}): Promise<{ html: string; warnings: string[] }> {
  const out = await mjml2html(buildMjml(content, opts), { validationLevel: 'soft', minify: false });
  return { html: out.html, warnings: out.errors.map((e) => e.formattedMessage ?? e.message ?? 'Unknown MJML warning') };
}
