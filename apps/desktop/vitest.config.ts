import { defineConfig } from 'vitest/config';
import { inlineImports } from './src/build/inlineImports.ts';

export default defineConfig({
  // `?script` and `?datauri` imports, as the renderer build serves them
  plugins: [inlineImports()],
  test: { include: ['src/**/*.test.{ts,tsx}'] },
});
