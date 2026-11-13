import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// @toskar's handler imports vscode, which only VS Code has: tests get the
// little of it the handler uses (test/vscode-stub.ts).
export default defineConfig({
  resolve: {
    alias: { vscode: fileURLToPath(new URL('./test/vscode-stub.ts', import.meta.url)) },
  },
})
