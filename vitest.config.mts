import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // index.ts only wires the real plugin and CapacitorHttp together; web.ts is the browser stub.
      exclude: ['src/index.ts', 'src/web.ts', 'src/definitions.ts'],
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: 'coverage/js',
    },
  },
});
