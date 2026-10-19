import sanitizeHtml from 'sanitize-html';

// Custom HTML is written by an Admin but still treated as untrusted: it is cleaned with an allowlist every time an email is rendered,
// so nothing outside the list (scripts, frames, forms, event handlers, unsafe links, CSS that loads things) can reach a recipient.

const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s,.%]+\)|[a-z]{3,20})$/i;
const SIZE = /^-?\d{1,4}(\.\d+)?(px|%|em|rem)?$/i;
const SIZES = /^(-?\d{1,4}(\.\d+)?(px|%|em|rem)?\s*){1,4}$/i;
const BORDER = /^[\w\s#.,()%-]{1,60}$/;
const SAFE_BORDER = (v: string) => BORDER.test(v) && !/url|expression|javascript/i.test(v);

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'a', 'b', 'strong', 'i', 'em', 'u', 's', 'small', 'span', 'p', 'br', 'hr', 'div', 'blockquote', 'center',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'img',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'rel'],
    img: ['src', 'alt', 'width', 'height'],
    table: ['width', 'border', 'cellpadding', 'cellspacing', 'align', 'role'],
    td: ['colspan', 'rowspan', 'align', 'valign', 'width', 'height', 'bgcolor'],
    th: ['colspan', 'rowspan', 'align', 'valign', 'width', 'height', 'bgcolor', 'scope'],
    '*': ['style', 'align'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https'] }, // no data: pictures
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  allowedStyles: {
    '*': {
      color: [COLOR], 'background-color': [COLOR], 'font-size': [SIZE], 'font-weight': [/^(normal|bold|[1-9]00)$/],
      'font-style': [/^(normal|italic)$/], 'font-family': [/^[\w\s,'"-]{1,80}$/], 'text-align': [/^(left|right|center|justify)$/],
      'text-decoration': [/^(none|underline|line-through)$/], 'line-height': [SIZE], 'letter-spacing': [SIZE], 'vertical-align': [/^(top|middle|bottom)$/],
      padding: [SIZES], 'padding-top': [SIZE], 'padding-right': [SIZE], 'padding-bottom': [SIZE], 'padding-left': [SIZE],
      margin: [SIZES], 'margin-top': [SIZE], 'margin-right': [SIZE], 'margin-bottom': [SIZE], 'margin-left': [SIZE],
      width: [SIZE], 'max-width': [SIZE], height: [SIZE], 'border-radius': [SIZES],
      border: [{ test: SAFE_BORDER } as RegExp], 'border-top': [{ test: SAFE_BORDER } as RegExp], 'border-bottom': [{ test: SAFE_BORDER } as RegExp],
      'border-left': [{ test: SAFE_BORDER } as RegExp], 'border-right': [{ test: SAFE_BORDER } as RegExp],
    },
  },
  transformTags: {
    // links open safely and cannot be used to reach back into the email app
    a: (tag, attribs) => ({ tagName: tag, attribs: { ...attribs, rel: 'noopener noreferrer' } }),
  },
};

export function sanitizeCustomHtml(html: string): string {
  return sanitizeHtml(html, OPTIONS);
}

/** Plain-language notes about things that will be removed, so the Admin is not surprised. */
export function customHtmlWarnings(html: string): string[] {
  const out: string[] = [];
  const has = (re: RegExp) => re.test(html);
  if (has(/<\s*script/i)) out.push('script tags are removed');
  if (has(/<\s*(iframe|object|embed|frame)/i)) out.push('frames and embedded objects are removed');
  if (has(/<\s*(form|input|button|select|textarea)/i)) out.push('forms and inputs are removed');
  if (has(/<\s*style/i) || has(/<\s*link/i)) out.push('style and link tags are removed (use inline styles)');
  if (has(/\son[a-z]+\s*=/i)) out.push('event handlers such as onclick are removed');
  if (has(/(href|src)\s*=\s*["']?\s*(javascript|data|vbscript):/i)) out.push('javascript:/data: links and pictures are removed');
  const cleaned = sanitizeCustomHtml(html);
  if (out.length === 0 && cleaned.replace(/\s+/g, '') !== html.replace(/\s+/g, '').replace(/ rel="noopener noreferrer"/g, '') && html.trim() !== '') {
    const stripped = html.replace(/<[^>]*>/g, '').length;
    if (stripped !== cleaned.replace(/<[^>]*>/g, '').length || /<\s*\/?\s*(?!\/?(a|b|strong|i|em|u|s|small|span|p|br|hr|div|blockquote|center|h[1-6]|ul|ol|li|table|thead|tbody|tfoot|tr|td|th|img)\b)[a-z]/i.test(html)) {
      out.push('some tags, attributes or styles that are not on the allowed list are removed');
    }
  }
  return out;
}
