import { expect, test } from '@playwright/test';

test('the preview runs the app in the browser: the demo stories are there, a decision is recorded, the audit chain holds', async ({ page }) => {
  const outside: string[] = [];
  page.on('request', (r) => { if (!r.url().startsWith('http://127.0.0.1:4180/')) outside.push(r.url()); });
  const res = await page.goto('/app.html');
  expect(res!.headers()['content-security-policy']).toContain("script-src 'self' 'wasm-unsafe-eval';"); // served as vercel.json sets it
  await expect(page.getByRole('note')).toContainText('runs entirely in your browser');
  await expect(page.getByRole('heading', { name: 'Sign in', level: 1 })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Referrals', level: 1 })).toBeVisible();
  await expect(page.getByText('Escalated')).toBeVisible();
  // the Admit story: the Reviewer records the decision
  await page.getByRole('row').filter({ hasText: 'Ready for review' }).filter({ hasNotText: /co-sign/i }).getByRole('button', { name: 'Open' }).click();
  await page.getByRole('button', { name: 'Record decision' }).click();
  await page.getByRole('radio', { name: 'Admit', exact: true }).check();
  await page.locator('form').getByRole('button', { name: 'Record decision' }).click();
  await expect(page.getByText('Status: Finalized')).toBeVisible();
  await page.getByRole('button', { name: 'Dashboard' }).click();
  await expect(page.getByText(/^Median .+ across 2 referrals\.$/)).toBeVisible(); // with the hard stop decided at seed time
  await page.getByRole('button', { name: 'Audit trail' }).click();
  await expect(page.getByText('The audit trail is for Admins.')).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('radio', { name: 'ZZTEST Admin', exact: true }).check();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'Audit trail' }).click();
  await expect(page.getByText(/^No inconsistencies found in \d+ entries/)).toBeVisible();
  expect(outside).toEqual([]); // nothing leaves the page
});
