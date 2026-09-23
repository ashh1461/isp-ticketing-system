import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Eagerly fail rather than hang forever if a route stalls.
    testTimeout: 15000,
    hookTimeout: 15000,
    // Tests own the auth/role matrix, so keep the per-IP limiter from
    // turning legitimate sequential calls into 429s.
    clearMocks: true,
  },
});
