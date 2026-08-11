import { afterEach, describe, expect, it, vi } from 'vitest'
import { chat, complete, listModels, OzAiError, setProviders } from './index'

// Mock @chirag127/keyless-ai so tests never hit the network.
vi.mock('@chirag127/keyless-ai', () => ({
	chat: vi.fn(async () => 'keyless-reply'),
}))

import { chat as keylessMock } from '@chirag127/keyless-ai'

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

afterEach(() => {
	setProviders(null)
	vi.mocked(keylessMock).mockResolvedValue('keyless-reply')
})

describe('keyless-ai primary backend', () => {
	it('routes chat through keyless-ai and returns its text', async () => {
		vi.mocked(keylessMock).mockResolvedValueOnce('from-keyless')
		// Use setProviders to inject only the keyless-ai adapter, then verify it works.
		// Build a minimal adapter matching what providers() builds for keyless-ai.
		setProviders([
			{
				name: 'keyless-ai',
				client: {
					chat: {
						completions: {
							create: async (params) => {
								const text = await keylessMock(params.messages as never, {
									model: params.model,
									temperature: params.temperature,
								})
								return { choices: [{ message: { content: text } }] }
							},
						},
					},
				},
			},
		])
		expect(await complete('hi')).toBe('from-keyless')
		expect(vi.mocked(keylessMock)).toHaveBeenCalledOnce()
	})

	it('falls through to g4f provider when keyless-ai throws', async () => {
		vi.mocked(keylessMock).mockRejectedValue(new Error('keyless down'))
		setProviders([
			{
				name: 'keyless-ai',
				client: {
					chat: {
						completions: {
							create: async (params) => {
								const text = await keylessMock(params.messages as never, {})
								return { choices: [{ message: { content: text } }] }
							},
						},
					},
				},
			},
			{ name: 'g4f-fallback', client: ok('g4f-reply') },
		])
		expect(await complete('hi')).toBe('g4f-reply')
	})
})

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
