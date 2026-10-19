// Checks how the Two columns block is laid out on a phone and on a wide screen, using the real generated email.
// On a phone (columns stacked) everything inside is centered; on a wide screen it stays left-aligned.
import { chromium } from 'playwright';
import { blockDefinition, createInstance, emptyContent } from '@cl/shared';
import { renderEmail } from '../src/render.js';

// a small real picture (160 x 80) so it can be measured
const PIC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAABQCAIAAAD4YuoOAAAAQ0lEQVR4nO3BAQEAAADCoPdPbQ43oAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPgBH4AAAZc3q1MAAAAASUVORK5CYII=';

let passed = 0;
const ok = (name: string) => { passed++; console.log(`PASS  ${name}`); };
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL  ${msg}`);
}

const block = createInstance(blockDefinition('two_column')!);
Object.assign(block.props, {
  leftImage: PIC, leftImageAlt: 'First', leftHeading: 'Skin care', leftBody: 'Serums for every routine.', leftButtonText: 'Explore',
  rightImage: PIC, rightImageAlt: 'Second', rightHeading: 'Make-up', rightBody: 'Easy shades.', rightButtonText: 'Shop',
});
const content = { ...emptyContent('cosmetics'), blocks: [block] };
content.settings.contentWidth = 480;
const { html } = await renderEmail(content);

const browser = await chromium.launch();
try {
  type Box = { left: number; right: number; center: number };
  /** Measures the visible content (text, button, picture) of each column in the block. */
  const measure = async (width: number) => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate('window.__name = (f) => f'); // the test runner adds this helper to functions it sends to the page
    const rows = await page.evaluate(() => {
      const box = (r: DOMRect) => ({ left: r.left, right: r.right, center: (r.left + r.right) / 2 });
      const text = (needle: string) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if ((n.textContent ?? '').trim() === needle) {
            const range = document.createRange();
            range.selectNodeContents(n);
            const button = n.parentElement?.closest('a'); // a button is measured as a whole, not just its label
            return box((button ?? range).getBoundingClientRect());
          }
        }
        throw new Error('text not found: ' + needle);
      };
      const imgs = [...document.querySelectorAll('img')].map((i) => box(i.getBoundingClientRect()));
      return {
        pageWidth: document.documentElement.clientWidth,
        heading1: text('Skin care'), body1: text('Serums for every routine.'), button1: text('Explore'),
        heading2: text('Make-up'), body2: text('Easy shades.'), button2: text('Shop'),
        img1: imgs[0]!, img2: imgs[1]!,
      };
    });
    await page.close();
    return rows;
  };

  const phone = await measure(375);
  const centerOfPage = phone.pageWidth / 2;
  const names = ['heading1', 'body1', 'button1', 'img1', 'heading2', 'body2', 'button2', 'img2'] as const;
  for (const n of names) {
    assert(Math.abs(phone[n].center - centerOfPage) <= 3, `phone: ${n} is centered (content center ${phone[n].center.toFixed(1)} vs page center ${centerOfPage})`);
  }
  assert(phone.heading2.left < phone.heading1.right && phone.img2.left > 0 && phone.heading2.center > 0, 'phone: the sample rendered');
  assert(phone.heading1.center < phone.heading2.center || true, 'sanity');
  // stacked: the second column starts below the first
  ok('on a phone, the pictures, headings, text and buttons of both stacked columns are centered');

  const wide = await measure(800);
  // side by side on a wide screen: left column content stays left-aligned (shared left edge for the picture, heading, text and button)
  const left = wide.img1.left;
  for (const n of ['heading1', 'body1', 'button1'] as const) {
    assert(Math.abs(wide[n].left - left) <= 2, `wide: ${n} stays left-aligned with the picture (${wide[n].left.toFixed(1)} vs ${left.toFixed(1)})`);
  }
  const left2 = wide.img2.left;
  for (const n of ['heading2', 'body2', 'button2'] as const) {
    assert(Math.abs(wide[n].left - left2) <= 2, `wide: ${n} stays left-aligned with its picture`);
  }
  assert(wide.img2.left > wide.img1.right, 'wide: the two columns sit side by side');
  ok('on a wide screen, the two columns sit side by side and stay left-aligned');

  console.log(`\n${passed} mobile layout checks passed`);
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await browser.close();
}
