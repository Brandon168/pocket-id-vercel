import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  use: {
    baseURL: 'http://localhost:3098',
    httpCredentials: { username: '', password: 'local-test-instructor' },
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
  },
  webServer: {
    command: 'npm run start -- --hostname 127.0.0.1 --port 3098',
    url: 'http://localhost:3098/workshop',
    reuseExistingServer: false,
    env: {
      CONTROLLER_DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/isolated',
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/isolated',
      ENCRYPTION_KEY: 'local-test-encryption',
      STATIC_API_KEY: 'local-test-api',
      WORKSHOP_ADMIN_SECRET: 'local-test-instructor',
      APP_URL: 'http://localhost:3098',
    },
  },
});
