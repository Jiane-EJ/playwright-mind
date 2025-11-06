
import { test, expect } from '@playwright/test';

/**
 * End-to-end tests for /login page.
 *
 * NOTE:
 * - Update BASE_URL, VALID_USER, and selectors below to match your app.
 * - You can set BASE_URL via environment variable BASE_URL or PLAYWRIGHT_BASE_URL.
 */

const BASE_URL = process.env.BASE_URL || process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000';

// Replace these with real test credentials or inject via environment variables in CI
const VALID_USER = {
  username: process.env.TEST_USERNAME || 'testuser',
  password: process.env.TEST_PASSWORD || 'correct-password',
};

const INVALID_PASSWORD = process.env.TEST_INVALID_PASSWORD || 'wrong-password';

test.describe('/login page', () => {
  test('successful login should redirect to dashboard (or show authenticated page)', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);

    // Fill username/email — adjust selectors to match your form
    await page.fill('input[name="username"], input[name="email"]', VALID_USER.username);
    await page.fill('input[name="password"]', VALID_USER.password);

    // Click submit — try a couple of common alternatives
    await Promise.race([
      page.click('button[type="submit"]'),
      page.click('button:has-text("Login")'),
      page.click('button:has-text("登录")'),
    ]).catch(() => {
      // If none of the above matched, try pressing Enter in password field
      // (keeps test resilient; remove if your app requires explicit click)
      return page.press('input[name="password"]', 'Enter');
    });

    // Wait for a redirect or visible authenticated UI.
    // Adjust the expected URL or assertion to match your app (e.g., /dashboard, /home)
    await page.waitForTimeout(500); // small pause to allow navigation to start
    await expect(page).toHaveURL(/.*(dashboard|home|profile|\/)$/i, { timeout: 10000 });

    // Also assert a common authenticated indicator (Logout, Profile, Dashboard)
    const authIndicator = page.locator('text=Logout, text=Sign out, text=Dashboard, text=Profile');
    await expect(authIndicator.first()).toBeVisible({ timeout: 10000 });
  });
})
