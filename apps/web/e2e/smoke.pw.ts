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
