import { defineConfig } from 'vitest/config';

// Keep the glob explicit so vitest never crawls the ./codex symlink.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
