import { defineConfig } from 'vitest/config'

// Tests live next to source as src/**/*.test.ts (co-located). The ambient default
// include was resolving to tests/** and silently skipping them — pin it here so the
// failover suite actually runs in CI.
export default defineConfig({
	test: {
		include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
	},
})
