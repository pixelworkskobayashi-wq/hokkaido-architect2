// @ts-check
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 90000,
  retries: 1,
  expect: {
    timeout: 15000,
  },
  use: {
    baseURL: 'http://localhost:3000',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: {
        ...devices['Desktop Chrome'],
        headless: false,
        viewport: { width: 1280, height: 720 },
      },
      testMatch: '**/zoom-coordinate.spec.js',
    },
    {
      name: 'ipad-pro',
      use: {
        headless: false,
        browserName: 'chromium',
        viewport: { width: 1024, height: 1366 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
      },
      testMatch: ['**/ipad-touch.spec.js', '**/ipad-diagnostic.spec.js', '**/file-picker-fix.spec.js', '**/viewport-resize.spec.js', '**/viewport-restore.spec.js', '**/wall-after-load.spec.js'],
    },
  ],
});
