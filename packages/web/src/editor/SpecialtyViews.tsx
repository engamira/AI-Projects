import type { CSSProperties, ReactNode } from 'react';
import type { Palette, Props } from '@cl/shared';
import { pictureSrc } from '../api';

// On-screen views of the template-specific blocks while editing (approximations of the generated email).

const s = (p: Props, k: string) => String(p[k] ?? '');
const n = (p: Props, k: string) => Number(p[k] ?? 0);
const has = (p: Props, k: string) => s(p, k).trim() !== '';
const isImg = (u: string) => /^(https:\/\/|asset:)/i.test(u);
const lines = (v: string) => <span style={{ whiteSpace: 'pre-wrap' }}>{v}</span>;

function Pic({ c, src, alt, round, size }: { c: Palette; src: string; alt: string; round?: boolean; size?: number }) {
  if (!isImg(src)) {
    return <div style={{ background: c.placeholder, color: c.muted, fontSize: 13, textAlign: 'center', padding: round ? 0 : '28px 8px', width: round ? size : undefined, height: round ? size : undefined, lineHeight: round ? `${size}px` : undefined, borderRadius: round ? '50%' : 0, margin: round ? '0 auto' : 0 }}>{round ? 'Photo' : 'Picture'}</div>;
  }
  return <img src={pictureSrc(src)} alt={alt} style={{ display: 'block', maxWidth: '100%', width: round ? size : '100%', height: round ? size : 'auto', objectFit: 'cover', borderRadius: round ? '50%' : 0, margin: round ? '0 auto' : 0 }} />;
}

function Btn({ label, bg, color }: { label: string; bg: string; color: string }) {
  return <span style={{ display: 'inline-block', background: bg, color, borderRadius: 6, padding: '10px 22px', fontWeight: 700 }}>{label}</span>;
}

function Band({ bg, py, children, style }: { bg: string; py: number; children: ReactNode; style?: CSSProperties }) {
  return <div style={{ background: bg, padding: `${py}px 24px`, ...style }}>{children}</div>;
}

function Heading({ text, color, size = 24 }: { text: string; color: string; size?: number }) {
  return text ? <div style={{ textAlign: 'center', fontSize: size, fontWeight: 700, color, margin: '0 0 12px', lineHeight: 1.3 }}>{lines(text)}</div> : null;
}

function Row({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>{children}</div>;
}
const Col = ({ children }: { children: ReactNode }) => <div style={{ flex: '1 1 140px', minWidth: 0, textAlign: 'center' }}>{children}</div>;

function Cards({ p, c }: { p: Props; c: Palette }) {
  return (
    <Band bg={c.surface} py={n(p, 'paddingY')}>
      <Heading text={s(p, 'heading')} color={c.text} />
      <Row>
        {[1, 2, 3].filter((i) => ['Image', 'Name', 'Detail', 'Price', 'ButtonText'].some((x) => has(p, `c${i}${x}`))).map((i) => (
          <Col key={i}>
            <div style={{ marginBottom: 10 }}><Pic c={c} src={s(p, `c${i}Image`)} alt={s(p, `c${i}ImageAlt`)} /></div>
            <div style={{ fontWeight: 700, fontSize: 18, color: c.text }}>{s(p, `c${i}Name`)}</div>
            <div style={{ fontSize: 14, color: c.muted }}>{s(p, `c${i}Detail`)}</div>
            <div style={{ fontWeight: 700, color: c.link, margin: '2px 0 8px' }}>{s(p, `c${i}Price`)}</div>
            {has(p, `c${i}ButtonText`) && <Btn label={s(p, `c${i}ButtonText`)} bg={c.button} color={c.onButton} />}
          </Col>
        ))}
      </Row>
    </Band>
  );
}

function Cta({ p, c }: { p: Props; c: Palette }) {
  return (
    <Band bg={c.surface} py={n(p, 'paddingY')} style={{ textAlign: s(p, 'align') as CSSProperties['textAlign'], color: c.text }}>
      <div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1.25, marginBottom: 8 }}>{lines(s(p, 'heading'))}</div>
      <div style={{ marginBottom: 16, lineHeight: 1.6 }}>{lines(s(p, 'text'))}</div>
      {has(p, 'buttonText') && <Btn label={s(p, 'buttonText')} bg={c.button} color={c.onButton} />}
      {has(p, 'note') && <div style={{ fontSize: 13, color: c.muted, marginTop: 10 }}>{s(p, 'note')}</div>}
    </Band>
  );
}

const upper = (v: string) => <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: 2, textTransform: 'uppercase' }}>{v}</span>;

export function SpecialtyView({ type, p, c }: { type: string; p: Props; c: Palette }): ReactNode {
  switch (type) {
    case 'destinations':
    case 'products':
      return <Cards p={p} c={c} />;
    case 'booking_cta':
    case 'registration_cta':
    case 'shopping_cta':
      return <Cta p={p} c={c} />;
    case 'fares':
      return (
        <Band bg={c.surface} py={n(p, 'paddingY')} >
          <Heading text={s(p, 'heading')} color={c.text} />
          <div style={{ padding: '0 16px' }}>
            {[1, 2, 3, 4, 5].filter((i) => has(p, `r${i}Route`) || has(p, `r${i}Price`)).map((i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 0', borderBottom: `1px solid ${c.divider}`, color: c.text }}>
                <span>{s(p, `r${i}Route`)}</span><strong>{s(p, `r${i}Price`)}</strong>
              </div>
            ))}
          </div>
          {has(p, 'note') && <div style={{ textAlign: 'center', fontSize: 13, color: c.muted, margin: '8px 0 14px' }}>{s(p, 'note')}</div>}
          {has(p, 'buttonText') && <div style={{ textAlign: 'center' }}><Btn label={s(p, 'buttonText')} bg={c.button} color={c.onButton} /></div>}
        </Band>
      );
    case 'travel_offer':
      return (
        <Band bg={c.dark} py={n(p, 'paddingY')} style={{ textAlign: s(p, 'align') as CSSProperties['textAlign'], color: c.onDark }}>
          {has(p, 'eyebrow') && <div>{upper(s(p, 'eyebrow'))}</div>}
          <div style={{ fontSize: 34, fontWeight: 700, color: c.primary, lineHeight: 1.2, margin: '4px 0' }}>{s(p, 'highlight')}</div>
          <div style={{ fontSize: 18, marginBottom: 14 }}>{s(p, 'headline')}</div>
          {has(p, 'buttonText') && <Btn label={s(p, 'buttonText')} bg={c.primary} color={c.onPrimary} />}
        </Band>
      );
    case 'event_details':
      return (
        <Band bg={c.primary} py={n(p, 'paddingY')} style={{ textAlign: 'center', color: c.onPrimary }}>
          {has(p, 'eyebrow') && <div>{upper(s(p, 'eyebrow'))}</div>}
          <div style={{ fontSize: 32, fontWeight: 700, lineHeight: 1.2, margin: '4px 0 16px' }}>{s(p, 'title')}</div>
          <Row>
            {([['date', 'Date'], ['time', 'Time'], ['place', 'Place']] as const).filter(([k]) => has(p, `${k}Value`)).map(([k]) => (
              <Col key={k}>
                <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase' }}>{s(p, `${k}Label`)}</div>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{s(p, `${k}Value`)}</div>
              </Col>
            ))}
          </Row>
          {has(p, 'address') && <div style={{ fontSize: 14, margin: '14px 0' }}>{s(p, 'address')}</div>}
          {has(p, 'buttonText') && <div style={{ marginTop: 8 }}><Btn label={s(p, 'buttonText')} bg={c.heroButton} color={c.onHeroButton} /></div>}
        </Band>
      );
    case 'agenda':
      return (
        <Band bg={c.surface} py={n(p, 'paddingY')}>
          <Heading text={s(p, 'heading')} color={c.text} />
          {[1, 2, 3, 4, 5, 6].filter((i) => has(p, `s${i}Title`) || has(p, `s${i}Time`)).map((i) => (
            <div key={i} style={{ display: 'flex', gap: 16, padding: '12px 0', borderBottom: `1px solid ${c.divider}` }}>
              <div style={{ width: 70, fontWeight: 700, color: c.link }}>{s(p, `s${i}Time`)}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, color: c.text }}>{s(p, `s${i}Title`)}</div>
                {has(p, `s${i}Text`) && <div style={{ fontSize: 14, color: c.muted }}>{s(p, `s${i}Text`)}</div>}
              </div>
            </div>
          ))}
        </Band>
      );
    case 'speakers':
      return (
        <Band bg={c.surface} py={n(p, 'paddingY')}>
          <Heading text={s(p, 'heading')} color={c.text} />
          <Row>
            {[1, 2, 3].filter((i) => ['Image', 'Name', 'Role', 'Bio'].some((x) => has(p, `p${i}${x}`))).map((i) => (
              <Col key={i}>
                <div style={{ marginBottom: 10 }}><Pic c={c} src={s(p, `p${i}Image`)} alt={s(p, `p${i}ImageAlt`)} round size={110} /></div>
                <div style={{ fontWeight: 700, fontSize: 18, color: c.text }}>{s(p, `p${i}Name`)}</div>
                <div style={{ fontWeight: 700, fontSize: 14, color: c.link, marginBottom: 6 }}>{s(p, `p${i}Role`)}</div>
                <div style={{ fontSize: 14, color: c.muted, lineHeight: 1.5 }}>{s(p, `p${i}Bio`)}</div>
              </Col>
            ))}
          </Row>
        </Band>
      );
    case 'benefits':
      return (
        <Band bg={c.secondary} py={n(p, 'paddingY')} style={{ color: c.onSecondary }}>
          <Heading text={s(p, 'heading')} color={c.onSecondary} />
          <Row>
            {[1, 2, 3].filter((i) => has(p, `b${i}Title`) || has(p, `b${i}Text`)).map((i) => (
              <Col key={i}>
                <div style={{ display: 'inline-block', width: 36, height: 36, lineHeight: '36px', borderRadius: 18, background: c.onSecondary, color: c.secondary, fontWeight: 700, marginBottom: 8 }}>✓</div>
                <div style={{ fontWeight: 700, fontSize: 17 }}>{s(p, `b${i}Title`)}</div>
                <div style={{ fontSize: 14, lineHeight: 1.5 }}>{s(p, `b${i}Text`)}</div>
              </Col>
            ))}
          </Row>
        </Band>
      );
    case 'promo_offer':
      return (
        <Band bg={c.accent} py={n(p, 'paddingY')} style={{ textAlign: s(p, 'align') as CSSProperties['textAlign'], color: c.onAccent }}>
          {has(p, 'eyebrow') && <div>{upper(s(p, 'eyebrow'))}</div>}
          <div style={{ fontSize: 34, fontWeight: 700, lineHeight: 1.2, margin: '4px 0 12px' }}>{s(p, 'headline')}</div>
          {has(p, 'code') && (
            <div style={{ marginBottom: 12 }}>
              {has(p, 'codeLabel') && <span>{s(p, 'codeLabel')}&nbsp; </span>}
              <span style={{ display: 'inline-block', padding: '8px 16px', borderRadius: 6, background: c.surface, color: c.text, fontWeight: 700, letterSpacing: 2 }}>{s(p, 'code')}</span>
            </div>
          )}
          {has(p, 'buttonText') && <Btn label={s(p, 'buttonText')} bg={c.dark} color={c.onDark} />}
          {has(p, 'terms') && <div style={{ fontSize: 12, marginTop: 10 }}>{s(p, 'terms')}</div>}
        </Band>
      );
    default:
      return <div style={{ padding: 12, color: 'red' }}>Unknown block</div>;
  }
}
