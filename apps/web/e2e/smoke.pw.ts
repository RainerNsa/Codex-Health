// Every screen renders in both themes and at phone width, with no automatic accessibility violation and no sideways
// page scroll. Screenshots go to test-results for a person to look at; nothing here compares pixels.
import { expect, test, type Page } from '@playwright/test';
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
      await expect(page.getByRole('heading', { name: 'Recommendation' })).toBeVisible();
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
  await expect(page.getByRole('heading', { name: 'What the documents say' })).toBeVisible();
  await expect(page.getByText('Quote not found on the page')).toBeVisible();
  await expect(page.getByText('Low confidence')).toBeVisible();
  await expect(page.getByText('<img src=x onerror=alert(1)>', { exact: false }).first()).toBeVisible();
  expect(await page.locator('img[src="x"]').count()).toBe(0);
  await expect(page.getByRole('button', { name: 'Confirm this reading' })).toHaveCount(0); // nothing is confirmable until its page is opened
  await expect(page.getByText('Open the page to confirm this reading.').first()).toBeVisible();
  await check(page, 'light-desktop-evidence');
});
