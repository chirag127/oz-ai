import { afterEach, describe, expect, it } from 'vitest'
import { chat, complete, listModels, OzAiError, setProviders } from './index'

const ok = (content: string) => ({
	chat: {
		completions: {
			create: async () => ({ choices: [{ message: { content } }] }),
		},
	},
	models: { list: async () => [{ id: 'm1' }, 'm2'] },
})

const dead = () => ({
	chat: {
		completions: {
			create: async () => {
				throw new Error('provider down')
			},
		},
	},
	models: {
		list: async () => {
			throw new Error('no list')
		},
	},
})

const streamer = (chunks: string[]) => ({
	chat: {
		completions: {
			create: async () =>
				(async function* () {
					for (const c of chunks) yield { choices: [{ delta: { content: c } }] }
				})(),
		},
	},
})

afterEach(() => setProviders(null))

describe('failover', () => {
	it('falls through a dead provider to a live one', async () => {
		setProviders([
			{ name: 'dead', client: dead() },
			{ name: 'live', client: ok('recovered') },
		])
		expect(await complete('hi')).toBe('recovered')
	})

	it('throws OzAiError only after all providers fail', async () => {
		setProviders([
			{ name: 'd1', client: dead() },
			{ name: 'd2', client: dead() },
		])
		await expect(complete('hi')).rejects.toBeInstanceOf(OzAiError)
	})

	it('streams text chunks when stream:true', async () => {
		setProviders([{ name: 's', client: streamer(['a', 'b', 'c']) }])
		const it = await chat([{ role: 'user', content: 'go' }], { stream: true })
		const out: string[] = []
		for await (const t of it) out.push(t)
		expect(out).toEqual(['a', 'b', 'c'])
	})

	it('listModels dedupes across providers, never throws', async () => {
		setProviders([
			{ name: 'a', client: ok('x') },
			{ name: 'b', client: dead() },
		])
		const models = await listModels()
		expect(models.sort()).toEqual(['m1', 'm2'])
	})
})
