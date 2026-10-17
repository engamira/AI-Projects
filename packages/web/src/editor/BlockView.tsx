import type { CSSProperties, ReactNode } from 'react';
import type { BlockInstance, EmailSettings, Props } from '@cl/shared';

// An approximate on-screen view of each block while editing. The Preview tab shows the real generated email.

const s = (p: Props, k: string) => String(p[k] ?? '');
const n = (p: Props, k: string) => Number(p[k] ?? 0);
const isImg = (u: string) => /^https:\/\//i.test(u);
const al = (p: Props, k = 'align'): CSSProperties['textAlign'] => (s(p, k) as CSSProperties['textAlign']) || 'left';
const lines = (v: string) => <span style={{ whiteSpace: 'pre-wrap' }}>{v}</span>;

function Img({ src, alt, width, style }: { src: string; alt?: string; width?: number | string; style?: CSSProperties }) {
  if (!isImg(src)) {
    return <div style={{ background: '#e5e7eb', color: '#6b7280', fontSize: 14, textAlign: 'center', padding: '32px 12px', ...style }}>Image placeholder: add a picture</div>;
  }
  return <img src={src} alt={alt ?? ''} style={{ display: 'block', maxWidth: '100%', width, height: 'auto', margin: '0 auto', ...style }} />;
}

function Btn({ label, bg, color, radius = 6, full = false }: { label: string; bg: string; color: string; radius?: number; full?: boolean }) {
  return (
    <span style={{ display: full ? 'block' : 'inline-block', background: bg, color, borderRadius: radius, padding: '12px 28px', fontWeight: 700, textAlign: 'center' }}>
      {label || 'Button'}
    </span>
  );
}

function Wrap({ bg, py, px = 24, align, children }: { bg: string; py: number; px?: number; align?: CSSProperties['textAlign']; children: ReactNode }) {
  return <div style={{ background: bg, padding: `${py}px ${px}px`, textAlign: align }}>{children}</div>;
}

export function BlockView({ block, settings }: { block: BlockInstance; settings: EmailSettings }) {
  const p = block.props;
  switch (block.type) {
    case 'header':
      return (
        <Wrap bg={s(p, 'bgColor')} py={n(p, 'paddingY')} align={al(p)}>
          {isImg(s(p, 'logoUrl')) ? <img src={s(p, 'logoUrl')} alt={s(p, 'logoAlt')} width={n(p, 'logoWidth')} style={{ maxWidth: '100%', height: 'auto' }} /> : <strong style={{ fontSize: 24, color: s(p, 'textColor') }}>{s(p, 'brandName')}</strong>}
        </Wrap>
      );
    case 'hero':
      return (
        <div style={{ background: s(p, 'bgColor'), textAlign: al(p), color: s(p, 'textColor') }}>
          {isImg(s(p, 'imageUrl')) && <Img src={s(p, 'imageUrl')} alt={s(p, 'imageAlt')} />}
          <div style={{ padding: `${n(p, 'paddingY')}px 24px` }}>
            {s(p, 'headline') && <div style={{ fontSize: 32, fontWeight: 700, lineHeight: 1.25 }}>{lines(s(p, 'headline'))}</div>}
            {s(p, 'subheadline') && <div style={{ fontSize: 18, margin: '8px 0 16px' }}>{lines(s(p, 'subheadline'))}</div>}
            {s(p, 'buttonText') && <Btn label={s(p, 'buttonText')} bg={s(p, 'buttonColor')} color={s(p, 'buttonTextColor')} />}
          </div>
        </div>
      );
    case 'text':
      return (
        <Wrap bg={s(p, 'bgColor')} py={n(p, 'paddingY')} px={n(p, 'paddingX')} align={al(p)}>
          <div style={{ color: s(p, 'textColor'), fontSize: n(p, 'fontSize'), lineHeight: 1.6 }}>
            {s(p, 'heading') && <div style={{ fontSize: n(p, 'fontSize') + 6, fontWeight: 700, marginBottom: 8 }}>{lines(s(p, 'heading'))}</div>}
            {lines(s(p, 'body'))}
          </div>
        </Wrap>
      );
    case 'image':
      return (
        <Wrap bg={s(p, 'bgColor')} py={n(p, 'paddingY')} px={0} align={al(p)}>
          <Img src={s(p, 'src')} alt={s(p, 'alt')} width={`${n(p, 'widthPercent')}%`} />
        </Wrap>
      );
    case 'button':
      return (
        <Wrap bg={s(p, 'containerBg')} py={n(p, 'paddingY')} align={al(p)}>
          <Btn label={s(p, 'label')} bg={s(p, 'bgColor')} color={s(p, 'textColor')} radius={n(p, 'borderRadius')} full={p.fullWidth === true} />
        </Wrap>
      );
    case 'two_column': {
      const col = (side: 'left' | 'right') => (
        <div style={{ flex: '1 1 0', minWidth: 0, padding: '0 12px', color: s(p, 'textColor') }}>
          {s(p, `${side}Image`) && <Img src={s(p, `${side}Image`)} alt={s(p, `${side}ImageAlt`)} style={{ marginBottom: 12 }} />}
          {s(p, `${side}Heading`) && <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 6 }}>{lines(s(p, `${side}Heading`))}</div>}
          {s(p, `${side}Body`) && <div style={{ fontSize: 15, lineHeight: 1.5, marginBottom: 10 }}>{lines(s(p, `${side}Body`))}</div>}
          {s(p, `${side}ButtonText`) && <Btn label={s(p, `${side}ButtonText`)} bg={s(p, 'buttonColor')} color={s(p, 'buttonTextColor')} />}
        </div>
      );
      return <div style={{ background: s(p, 'bgColor'), padding: `${n(p, 'paddingY')}px 12px`, display: 'flex', gap: 0 }}>{col('left')}{col('right')}</div>;
    }
    case 'divider':
      return (
        <div style={{ padding: `${n(p, 'paddingY')}px 24px` }}>
          <hr style={{ border: 0, borderTop: `${n(p, 'thickness')}px solid ${s(p, 'color')}`, width: `${n(p, 'widthPercent')}%`, margin: '0 auto' }} />
        </div>
      );
    case 'spacer':
      return <div style={{ height: n(p, 'height'), background: 'repeating-linear-gradient(45deg, transparent 0 6px, rgba(128,128,128,.12) 6px 12px)' }} aria-label={`Spacer ${n(p, 'height')} pixels`} />;
    case 'social': {
      const links = ['facebook', 'instagram', 'x', 'linkedin', 'youtube'].filter((k) => s(p, k));
      return (
        <Wrap bg={s(p, 'bgColor')} py={n(p, 'paddingY')} align={al(p)}>
          {links.length ? links.map((k, i) => <span key={k} style={{ color: s(p, 'textColor'), textDecoration: 'underline' }}>{i > 0 && <span style={{ color: '#888' }}> · </span>}{({ x: 'X', linkedin: 'LinkedIn', youtube: 'YouTube' } as Record<string, string>)[k] ?? k[0]!.toUpperCase() + k.slice(1)}</span>) : <em style={{ color: '#888' }}>Social links (add addresses to show them)</em>}
        </Wrap>
      );
    }
    case 'footer':
      return (
        <Wrap bg={s(p, 'bgColor')} py={n(p, 'paddingY')} align={al(p)}>
          <div style={{ color: s(p, 'textColor'), fontSize: 13, lineHeight: 1.6 }}>
            <strong>{s(p, 'companyName')}</strong><br />{s(p, 'address')}<br />{lines(s(p, 'notice'))}<br />
            <span style={{ color: s(p, 'linkColor'), textDecoration: 'underline' }}>{s(p, 'unsubscribeText')}</span>
          </div>
        </Wrap>
      );
    default:
      return <div style={{ padding: 12, color: 'red' }}>Unknown block</div>;
  }
  void settings;
}
