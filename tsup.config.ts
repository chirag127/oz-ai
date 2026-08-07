import { defineConfig } from 'tsup'

export default defineConfig({
	entry: { index: 'src/index.ts' },
	format: ['esm'],
	dts: true,
	clean: true,
	external: ['@gpt4free/g4f.dev'],
})
