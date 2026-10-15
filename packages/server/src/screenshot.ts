import os from 'node:os';

export type ScreenshotCheck = { bytes: number; ms: number; rssMB: number; freeMemMB: number };

// M0 host check: proves Chromium launches and renders on the hosting plan.
export async function screenshotCheck(): Promise<ScreenshotCheck> {
  const { chromium } = await import('playwright');
  const start = Date.now();
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 600, height: 800 } });
    await page.setContent('<html><body style="font-family:Arial"><h1>Campaign LEGO M0</h1></body></html>');
    const buf = await page.screenshot();
    return {
      bytes: buf.length,
      ms: Date.now() - start,
      rssMB: Math.round(process.memoryUsage().rss / 1048576),
      freeMemMB: Math.round(os.freemem() / 1048576),
    };
  } finally {
    await browser.close();
  }
}
