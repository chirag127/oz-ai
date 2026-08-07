import { describe, expect, it } from 'vitest'
import {
	buildPayload,
	buildVisionMessages,
	extractContent,
	extractDelta,
	extractImageUrl,
	modelId,
} from './payload'

describe('buildPayload', () => {
	it('defaults model to gpt-4o-mini', () => {
		const p = buildPayload([{ role: 'user', content: 'hi' }])
		expect(p.model).toBe('gpt-4o-mini')
		expect(p.messages).toHaveLength(1)
		expect(p.temperature).toBeUndefined()
		expect(p.stream).toBeUndefined()
	})

	it('honors model + temperature + stream', () => {
		const p = buildPayload([{ role: 'user', content: 'hi' }], {
			model: 'deepseek-v3',
			temperature: 0.2,
			stream: true,
		})
		expect(p.model).toBe('deepseek-v3')
		expect(p.temperature).toBe(0.2)
		expect(p.stream).toBe(true)
	})

	it('omits temperature + stream when unset', () => {
		const p = buildPayload([{ role: 'user', content: 'hi' }], { model: 'x' })
		expect('temperature' in p).toBe(false)
		expect('stream' in p).toBe(false)
	})
})

describe('buildVisionMessages', () => {
	it('builds a single user message with text + image parts', () => {
		const msgs = buildVisionMessages(
			'what is this',
			'data:image/png;base64,AAA',
		)
		expect(msgs).toHaveLength(1)
		expect(msgs[0].role).toBe('user')
		const parts = msgs[0].content as Array<Record<string, unknown>>
		expect(parts[0]).toEqual({ type: 'text', text: 'what is this' })
		expect(parts[1]).toEqual({
			type: 'image_url',
			image_url: { url: 'data:image/png;base64,AAA' },
		})
	})
})

describe('extractContent', () => {
	it('pulls choices[0].message.content', () => {
		expect(
			extractContent({ choices: [{ message: { content: 'hello' } }] }),
		).toBe('hello')
	})
	it('throws on malformed', () => {
		expect(() => extractContent({})).toThrow('malformed response')
		expect(() => extractContent({ choices: [{}] })).toThrow('malformed')
	})
})

describe('extractDelta', () => {
	it('pulls choices[0].delta.content', () => {
		expect(extractDelta({ choices: [{ delta: { content: 'x' } }] })).toBe('x')
	})
	it('returns empty when no delta', () => {
		expect(extractDelta({})).toBe('')
		expect(extractDelta({ choices: [{ delta: {} }] })).toBe('')
	})
})

describe('extractImageUrl', () => {
	it('pulls data[0].url', () => {
		expect(extractImageUrl({ data: [{ url: 'http://x/y.png' }] })).toBe(
			'http://x/y.png',
		)
	})
	it('throws when missing', () => {
		expect(() => extractImageUrl({ data: [] })).toThrow('malformed')
	})
})

describe('modelId', () => {
	it('handles string, {id}, {name}, junk', () => {
		expect(modelId('gpt-4o')).toBe('gpt-4o')
		expect(modelId({ id: 'a' })).toBe('a')
		expect(modelId({ name: 'b' })).toBe('b')
		expect(modelId({})).toBe('')
		expect(modelId(null)).toBe('')
	})
})
