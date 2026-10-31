// Every screen renders in both themes and at phone width, with no automatic accessibility violation and no sideways
// page scroll. Screenshots go to test-results for a person to look at; nothing here compares pixels.
import { expect, test, type Browser, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const sizes = [{ name: 'desktop', width: 1440, height: 900 }, { name: 'phone', width: 390, height: 844 }];

async function check(page: Page, name: string) {
  await page.waitForLoadState('networkidle');
  await page.addStyleTag({ content: '* { transition: none !important; animation: none !important; }' }); // measure final colours, not mid-fade
  expect(await page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => !e.closest('[tabindex="0"]') && e.getBoundingClientRect().right > window.innerWidth + 1).map((e) => `${e.tagName} ${(e.textContent ?? '').slice(0, 30)}`))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/shots/${name}.png`, fullPage: true });
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => `${n.target} ${n.any[0]?.message ?? ''}`).join(' | ')}`)).toEqual([]);
}

for (const colorScheme of ['light', 'dark'] as const) {
  for (const size of sizes) {
    test(`screens: ${colorScheme} ${size.name}`, async ({ browser }) => {
      const page = await (await browser.newContext({ colorScheme, viewport: size })).newPage();
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Referrals', level: 1 })).toBeVisible();
      await check(page, `${colorScheme}-${size.name}-queue`);

      await page.getByRole('button', { name: 'New referral' }).click();
      await expect(page.getByRole('heading', { name: 'Recommendation', exact: true })).toBeVisible();
      await page.getByRole('listitem').filter({ hasText: 'ventilator use' }).getByRole('button', { name: 'Enter' }).click();
      const form = page.getByRole('form', { name: /ventilator use/ });
      await form.getByRole('radio', { name: 'yes' }).check();
      await form.getByLabel('Note').fill('SYNTHETIC ZZTEST note');
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByText('Do Not Admit', { exact: true }).first()).toBeVisible();
      await check(page, `${colorScheme}-${size.name}-referral`);

      await page.getByRole('button', { name: 'Facility settings' }).click();
      await page.getByRole('button', { name: 'Load', exact: true }).click();
      await expect(page.getByText('Capabilities')).toBeVisible();
      await check(page, `${colorScheme}-${size.name}-settings`);

      await page.getByRole('button', { name: /Dashboard/ }).click();
      await check(page, `${colorScheme}-${size.name}-placeholder`);
    });
  }
}

// AI facts need the pipeline, which needs AWS: this overlays synthetic ones on the real API's answer.
const aiFact = (key: string, value: string, verified: boolean, band: string) => ({ id: key, key, value: { type: 'tri_state', value }, source: 'ai', note: null, as_of_date: null, confidence_band: band, single_source: true,
  evidence: { document_id: 'zz', page: 3, quote: 'ZZTEST <img src=x onerror=alert(1)> not on a ventilator', verified } });

test('evidence: quotes stay text, and what did not verify says so in words', async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: sizes[0] })).newPage();
  await page.route('**/api/facilities/*/referrals', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: route.request().method() === 'POST' ? { ...body, facts: [aiFact('ventilator_use', 'no', true, 'high'), aiFact('recent_aggression', 'yes', false, 'high'), aiFact('daily_skilled_need', 'yes', true, 'low')] } : body });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'New referral' }).click();
  await expect(page.getByRole('heading', { name: 'Facts the recommendation rests on' })).toBeVisible();
  await expect(page.getByText('Quote not found on the page')).toBeVisible();
  await expect(page.getByText('Low confidence')).toBeVisible();
  await expect(page.getByText('<img src=x onerror=alert(1)>', { exact: false }).first()).toBeVisible();
  expect(await page.locator('img[src="x"]').count()).toBe(0);
  await expect(page.getByRole('button', { name: 'Confirm this reading' })).toHaveCount(0); // nothing is confirmable until its page is opened
  await expect(page.getByText('Open the page to confirm this reading.').first()).toBeVisible();
  await check(page, 'light-desktop-evidence');
});

/** A new referral whose answer is overlaid with synthetic content, and a page context to open it in. */
async function overlaid(browser: Browser, overlay: Record<string, unknown>) {
  const page = await (await browser.newContext({ viewport: sizes[0], acceptDownloads: true })).newPage();
  await page.route('**/api/facilities/*/referrals', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    const { referral, ...rest } = overlay as { referral?: object };
    await route.fulfill({ response: res, json: route.request().method() === 'POST' ? { ...body, ...rest, referral: { ...body.referral, ...referral } } : body });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'New referral' }).click();
  return page;
}

test('a reading can be confirmed once its page is opened, and only while the link was live', async ({ browser }) => {
  const page = await overlaid(browser, { facts: [aiFact('ventilator_use', 'no', true, 'high')] });
  await page.route('**/documents/*/view*', (route) => route.fulfill({ json: { url: 'http://127.0.0.1:5173/zz-page', expires_in: 1 } }));
  const fact = page.getByRole('listitem').filter({ hasText: 'ventilator use' });
  await fact.getByRole('button', { name: 'View document' }).click();
  await expect(fact.getByRole('link')).toBeVisible();
  await expect(fact.getByRole('link')).toHaveCount(0, { timeout: 3000 }); // an expired link is gone, so it cannot count as opening the page
  await expect(fact.getByRole('button', { name: 'Confirm this reading' })).toHaveCount(0);

  await page.unroute('**/documents/*/view*');
  await page.route('**/documents/*/view*', (route) => route.fulfill({ json: { url: 'http://127.0.0.1:5173/zz-page', expires_in: 120 } }));
  await fact.getByRole('button', { name: 'View document' }).click();
  const [popup] = await Promise.all([page.waitForEvent('popup'), fact.getByRole('link').click()]);
  await popup.close();
  const saved = page.waitForRequest((r) => r.method() === 'POST' && r.url().includes('/facts'));
  await fact.getByRole('button', { name: 'Confirm this reading' }).click();
  expect((await saved).postDataJSON().key).toBe('ventilator_use');
});

test('a failed document: a refused copy says so, and a good one downloads, never as a fact view', async ({ browser }) => {
  const doc = { id: 'zzdoc', type: 'discharge_summary', status: 'failed', pages: null, not_applicable_reason: null, created_at: '2001-01-10T09:00:00Z' };
  const page = await overlaid(browser, { referral: { status: 'partial_failure' }, documents: [doc], actions: ['upload'] });
  await page.route('**/documents/zzdoc/view*', (route) => route.fulfill({ status: 503, json: { error: 'storage_unavailable' } }));
  await page.getByRole('button', { name: /Get a copy/ }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'could not be fetched' })).toBeVisible();

  await page.unroute('**/documents/zzdoc/view*');
  const asked: string[] = [];
  await page.route('**/documents/zzdoc/view*', (route) => { asked.push(route.request().url()); return route.fulfill({ json: { url: 'http://127.0.0.1:5173/zz-copy', expires_in: 120 } }); });
  await page.route('**/zz-copy', (route) => route.fulfill({ body: 'SYNTHETIC', headers: { 'Content-Disposition': 'attachment; filename="zz.pdf"' } }));
  await page.getByRole('button', { name: /Get a copy/ }).click();
  await expect(page.getByText('could not be fetched')).toHaveCount(0);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: /Save the file/ }).click()]);
  expect(download.suggestedFilename()).toBe('zz.pdf');
  expect(asked[0]).not.toContain('?fact=');
});

test('the queue is home: a referral replaces it, Back returns, and the facility picker never shows another facility list', async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: sizes[0] })).newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'New referral' }).click();
  await expect(page.getByRole('heading', { name: 'Recommendation', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Referral / })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Needs staff' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to referrals' }).click();
  await expect(page.getByRole('button', { name: 'Needs staff' })).toBeVisible();
  await page.getByLabel('Facility').selectOption({ label: 'ZZTEST Beta Facility 1' });
  await expect(page.getByText('Not a facility this user belongs to.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open' })).toHaveCount(0);
});

test('while documents are read the screen shows progress, and it follows the referral to review', async ({ browser }) => {
  const context = await browser.newContext({ viewport: sizes[0] });
  const page = await context.newPage();
  await page.clock.install();
  const docs = [{ id: 'a', type: 'face_sheet', status: 'processed', pages: 2, not_applicable_reason: null, created_at: '2026-10-30T00:00:00Z' }, { id: 'b', type: 'face_sheet', status: 'uploaded', pages: null, not_applicable_reason: null, created_at: '2026-10-30T00:00:00Z' }];
  let reads = 0;
  await page.route('**/api/facilities/*/referrals*', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: route.request().method() === 'POST' ? { ...body, referral: { ...body.referral, status: 'processing' }, documents: docs } : body });
  });
  await page.route('**/api/facilities/*/referrals/*', async (route) => {
    reads += 1;
    const res = await route.fetch();
    await route.fulfill({ response: res, json: await res.json() });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'New referral' }).click();
  await expect(page.getByText('Reading documents: 1 of 2 done.')).toBeVisible();
  await check(page, 'light-desktop-processing');
  await page.clock.runFor(10_500);
  await expect.poll(() => reads).toBeGreaterThan(0);
  await expect(page.getByText('Reading documents')).toHaveCount(0); // the real referral is a draft: the poll brought the screen up to date
});
