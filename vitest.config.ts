import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Theme tests apply tokens to a real element; syntax tests parse markup.
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
})
