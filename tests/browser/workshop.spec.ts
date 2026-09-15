import { test, expect } from '@playwright/test';

// Real built Next.js pages/auth, with API responses intercepted. Provider
// mutations and SQL are covered by the separate service/provider tests.
test('choose Passport, prepare, copy credentials, and share the laptop signup link', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let options = { mode: 'app', expectedAttendees: 100, requireEmail: false, emailDomain: null, ownerEmail: null };
  let prepared = false;
  let passportFailure = true;
  const setup = { adminUsername: 'instructor', joinUrl: 'http://localhost:3098/join', capacity: 1200, expiresAt: '2026-09-12T12:00:00.000Z' };
  await page.route('**/api/workshop{,/**}', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/workshop') {
      const tokenCount = Math.ceil(options.expectedAttendees * 1.2 / 100);
      return route.fulfill({ json: { options, setup: prepared ? setup : null, preparing: false, plan: { capacity: tokenCount * 100, tokenCount, estimatedSeconds: 10 } } });
    }
    if (path === '/api/workshop/options') {
      expect(request.method()).toBe('PUT');
      options = request.postDataJSON();
      return route.fulfill({ json: options });
    }
    if (path === '/api/workshop/setup') {
      expect(request.method()).toBe('POST');
      expect(options).toMatchObject({ mode: 'passport', expectedAttendees: 1000 });
      prepared = true;
      return route.fulfill({ json: setup });
    }
    if (path === '/api/workshop/passport') {
      if (passportFailure) { passportFailure = false; return route.fulfill({ status: 500, json: { error: 'Simulated outage' } }); }
      return route.fulfill({ json: { clientId: 'workshop-passport', clientSecret: 'browser-test-secret', issuer: 'http://localhost:3098', discoveryUrl: 'http://localhost:3098/.well-known/openid-configuration', callbackUrl: 'https://connect.vercel.com/callback' } });
    }
    if (path === '/api/workshop/signups') return route.fulfill({ json: { used: 0, capacity: 1200, sandboxRunning: true } });
    if (path === '/api/workshop/attendees') return route.fulfill({ json: { idle: true } });
    if (path === '/api/workshop/qr') return route.continue(); // Real QR route.
    throw new Error(`Unexpected request: ${request.method()} ${path}`);
  });
  await page.goto('/workshop');
  await page.getByRole('button', { name: 'Change options', exact: true }).click();
  await page.getByText('Deployed apps with Vercel Passport', { exact: true }).click();
  await expect(page.getByRole('radio', { name: /Deployed apps with Vercel Passport/ })).toBeChecked();
  await page.getByText('1,000', { exact: true }).click();
  await expect(page.getByRole('radio', { name: '1,000', exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Save options' }).click();
  await expect(page.getByText('Deployed apps with Vercel Passport', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Prepare workshop', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connect Vercel Passport' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Could not load Passport credentials' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText('https://connect.vercel.com/callback', { exact: true })).toBeVisible();
  await expect(page.getByText('browser-test-secret', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show Passport secret' }).click();
  await expect(page.getByText('browser-test-secret', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Copy Passport secret' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('browser-test-secret');
  await page.getByRole('button', { name: 'Hide Passport secret' }).click();
  await expect(page.getByText('browser-test-secret', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Copy URL' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(setup.joinUrl);
  await expect(page.getByRole('img', { name: /QR code for/ })).not.toBeVisible();
  await page.getByText('Show optional QR code', { exact: true }).click();
  await expect(page.getByRole('img', { name: /QR code for/ })).toBeVisible();
  expect(await page.getByRole('img', { name: /QR code for/ }).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await page.getByText('Show optional QR code', { exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: 'test-results/workshop-passport-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Copy URL' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/workshop-passport-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});
