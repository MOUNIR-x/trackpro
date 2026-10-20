const { test, expect } = require('playwright/test');

test('sidebar switches active section', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('trackpro_token', 'demo-token');
    localStorage.setItem('trackpro_session', JSON.stringify({
      name: 'Demo Admin',
      email: 'demo@trackpro.com',
      company: 'Demo Logistics'
    }));
  });

  await page.goto('http://localhost:3000/admin.html', { waitUntil: 'networkidle' });

  await expect(page.locator('#section-dashboard')).toHaveClass(/active/);
  await page.locator('.nav-item[data-section="colis"]').click();

  await expect(page.locator('#section-colis')).toHaveClass(/active/);
  await expect(page.locator('.nav-item[data-section="colis"]')).toHaveClass(/active/);
  await expect(page.locator('#pageTitle')).toHaveText('Mes colis');
});
