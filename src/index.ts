import { chat as keylessChat } from '@chirag127/keyless-ai'
import {
	buildPayload,
	buildVisionMessages,
	type ChatOptions,
	extractContent,
	extractDelta,
	extractImageUrl,
	type Message,
	modelId,
	type RequestPayload,
} from './payload'

export type {
	ChatOptions,
	ContentPart,
	Message,
	RequestPayload,
} from './payload'
export {
	buildPayload,
	buildVisionMessages,
	extractContent,
	extractDelta,
	extractImageUrl,
	modelId,
} from './payload'

/** Thrown only after EVERY provider fails. Callers can catch + degrade. */
export class OzAiError extends Error {
	constructor(
		message: string,
		readonly cause?: unknown,
	) {
		super(message)
		this.name = 'OzAiError'
	}
}

/** Minimal structural type over a g4f.dev client (OpenAI-shape). */
interface G4FClient {
	chat: {
		completions: {
			create(
				params: RequestPayload,
			):
				| Promise<unknown>
				| AsyncGenerator<unknown, void, unknown>
				| Promise<AsyncGenerator<unknown, void, unknown>>
		}
	}
	models?: { list(): Promise<unknown[]> }
	images?: { generate(params: Record<string, unknown>): Promise<unknown> }
}

/** A named provider entry in the failover chain. */
export interface Provider {
	name: string
	client: G4FClient
}

/**
 * Direct OpenAI-compatible provider over `fetch` — no g4f.dev CDN dependency.
 * The g4f.dev-mediated PollinationsAI class + the g4f.space proxies broke
 * upstream (g4f.space now gates on "cake credits", HTTP 402); the raw
 * `text.pollinations.ai/openai` endpoint stays fully keyless. This hits it
 * directly so failover survives the CDN client going bad.
 */
function directProvider(name: string, url: string, forceModel = 'openai'): Provider {
	async function* sse(
		body: ReadableStream<Uint8Array>,
	): AsyncGenerator<unknown, void, unknown> {
		const reader = body.getReader()
		const dec = new TextDecoder()
		let buf = ''
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			buf += dec.decode(value, { stream: true })
			let nl: number
			while ((nl = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, nl).trim()
				buf = buf.slice(nl + 1)
				if (!line.startsWith('data:')) continue
				const data = line.slice(5).trim()
				if (data === '[DONE]') return
				try {
					yield JSON.parse(data)
				} catch {
					/* skip non-JSON keepalive */
				}
			}
		}
	}
	return {
		name,
		client: {
			chat: {
				completions: {
					async create(params: RequestPayload) {
						// Pollinations free tier stalls/402s on requests carrying a
						// `system` turn; fold it into the first user turn so only a
						// plain user message is sent.
						const msgs = foldSystem(params.messages)
						// Abort a hung fetch fast (well under the outer 22s) so
						// failover to the next provider fires quickly.
						const ac = new AbortController()
						const t = setTimeout(() => ac.abort(), DIRECT_FETCH_TIMEOUT_MS)
						try {
							const res = await fetch(url, {
								method: 'POST',
								headers: { 'content-type': 'application/json' },
								body: JSON.stringify({
									...params,
									model: forceModel,
									messages: msgs,
								}),
								signal: ac.signal,
							})
							if (!res.ok)
								throw new OzAiError(`${name} HTTP ${res.status}`)
							if (params.stream && res.body) return sse(res.body)
							return await res.json()
						} finally {
							clearTimeout(t)
						}
					},
				},
			},
		},
	}
}

/** Fold any system messages into the first user message. Pure. */
function foldSystem(messages: Message[]): Message[] {
	const sys = messages
		.filter((m) => m.role === 'system' && typeof m.content === 'string')
		.map((m) => m.content as string)
		.join('\n\n')
	if (!sys) return messages
	const rest = messages.filter((m) => m.role !== 'system')
	const first = rest[0]
	if (first && first.role === 'user' && typeof first.content === 'string')
		return [
			{ role: 'user', content: `${sys}\n\n${first.content}` },
			...rest.slice(1),
		]
	return [{ role: 'user', content: sys }, ...rest]
}

const MAX_RETRIES = 2

let chain: Provider[] | null = null

/**
 * Ordered provider failover chain. Built lazily from @gpt4free/g4f.dev.
 * @chirag127/keyless-ai FIRST (kilo→ovh→pollinations, no key, Node+browser).
 * Then direct Pollinations fetch, then g4f.dev CDN clients.
 * THIS is the one place the fleet's provider strategy lives — reorder here.
 */
async function providers(): Promise<Provider[]> {
	if (chain) return chain
	const built: Provider[] = []
	// @chirag127/keyless-ai FIRST — verified keyless, kilo→ovh→pollinations failover.
	// Adapt its chat(messages, opts)→string into the G4FClient shape.
	// keyless-ai only accepts text content; vision payloads (ContentPart[]) fall
	// through to the g4f tail automatically via normal failover.
	built.push({
		name: 'keyless-ai',
		client: {
			chat: {
				completions: {
					async create(params: RequestPayload) {
						// Reject vision payloads so failover moves to a vision-capable provider.
						if (params.messages.some((m) => typeof m.content !== 'string'))
							throw new OzAiError('keyless-ai: vision not supported')
						const textMsgs = params.messages as Array<{
							role: 'system' | 'user' | 'assistant'
							content: string
						}>
						const text = await keylessChat(textMsgs, {
							model: params.model,
							temperature: params.temperature,
						})
						return { choices: [{ message: { content: text } }] }
					},
				},
			},
		},
	})
	// Direct keyless Pollinations — raw fetch, zero g4f.dev CDN dependency.
	built.push(
		directProvider('pollinations-direct', 'https://text.pollinations.ai/openai'),
	)
	// g4f.dev CDN client is a BONUS layer of providers. Load it time-boxed and
	// non-fatally: a slow/broken CDN must never stall the direct provider above.
	// Browser-safe — the bare npm specifier ('@gpt4free/g4f.dev') would leave an
	// unresolvable import in the bundle; the CDN URL is fetched at runtime.
	const CDN = 'https://g4f.dev/dist/js/client.js'
	type G4FMod = {
		default?: new (opts?: { baseUrl?: string }) => G4FClient
		Client?: new (opts?: { baseUrl?: string }) => G4FClient
		PollinationsAI?: new () => G4FClient
		DeepInfra?: new () => G4FClient
		Puter?: new () => G4FClient
	}
	let g4f: G4FMod | null = null
	try {
		g4f = await Promise.race([
			import(/* @vite-ignore */ CDN) as Promise<G4FMod>,
			new Promise<null>((r) => setTimeout(() => r(null), CDN_IMPORT_TIMEOUT_MS)),
		])
	} catch {
		g4f = null
	}
	if (g4f) {
		const Client = g4f.Client ?? g4f.default
		if (g4f.PollinationsAI)
			built.push({ name: 'PollinationsAI', client: new g4f.PollinationsAI() })
		if (Client) {
			for (const [name, baseUrl] of [
				['g4f.space/pollinations', 'https://g4f.space/api/pollinations'],
				['g4f.space/groq', 'https://g4f.space/api/groq'],
				['g4f.space/gemini', 'https://g4f.space/api/gemini'],
				['llm7', 'https://api.llm7.io/v1'],
				['ovh', 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1'],
			] as const)
				built.push({ name, client: new Client({ baseUrl }) })
			built.push({ name: 'default', client: new Client() })
		}
		if (g4f.DeepInfra)
			built.push({ name: 'DeepInfra', client: new g4f.DeepInfra() })
		if (g4f.Puter) built.push({ name: 'Puter', client: new g4f.Puter() })
	}
	chain = built
	return built
}

/** Override the provider chain (tests / custom order). Pass null to reset. */
export function setProviders(next: Provider[] | null): void {
	chain = next
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const ATTEMPT_TIMEOUT_MS = 22000

/** Cap the g4f.dev CDN import so a hanging CDN never stalls the direct provider. */
const CDN_IMPORT_TIMEOUT_MS = 6000

/** Abort a hung direct-provider fetch fast so failover fires within the outer budget. */
const DIRECT_FETCH_TIMEOUT_MS = 12000

/** Reject if fn outruns ATTEMPT_TIMEOUT_MS so a hung provider can't stall failover. */
function withTimeout<T>(fn: () => Promise<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const t = setTimeout(
			() => reject(new OzAiError('provider timed out')),
			ATTEMPT_TIMEOUT_MS,
		)
		fn().then(
			(v) => {
				clearTimeout(t)
				resolve(v)
			},
			(e) => {
				clearTimeout(t)
				reject(e)
			},
		)
	})
}
const isAsyncIterable = (x: unknown): x is AsyncIterable<unknown> =>
	x != null &&
	typeof (x as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'

let modelCache: string[] | null = null

/** Fetch every g4f model id across all providers once, cached. */
async function allModels(signal?: AbortSignal): Promise<string[]> {
	if (modelCache) return modelCache
	const list = await providers()
	const seen = new Set<string>()
	for (const p of list) {
		if (signal?.aborted) break
		try {
			const models = (await p.client.models?.list()) ?? []
			for (const m of models) {
				const id = modelId(m)
				if (id) seen.add(id)
			}
		} catch {
			/* provider model-list failed — skip */
		}
	}
	modelCache = [...seen]
	return modelCache
}

/**
 * Run fn against each provider (MAX_RETRIES each) on the requested model.
 * If EVERY provider fails and no explicit model was pinned, fall back to
 * trying each fetched g4f model in turn across providers — exhaust the whole
 * model space before giving up. `vary(model)` re-runs fn with a new model.
 */
async function withFailover<T>(
	fn: (p: Provider) => Promise<T>,
	signal?: AbortSignal,
	vary?: {
		explicitModel: boolean
		run: (p: Provider, model: string) => Promise<T>
	},
): Promise<T> {
	const list = await providers()
	let last: unknown
	for (const p of list) {
		for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
			if (signal?.aborted) throw new OzAiError('aborted')
			if (attempt > 0) await sleep(2 ** attempt * 300)
			try {
				return await withTimeout(() => fn(p))
			} catch (e) {
				if (signal?.aborted) throw new OzAiError('aborted')
				last = e
			}
		}
	}
	// All providers failed on the default model. If the caller didn't pin a
	// model, cycle through every g4f model across providers before failing.
	if (vary && !vary.explicitModel) {
		const models = await allModels(signal)
		for (const model of models) {
			for (const p of list) {
				if (signal?.aborted) throw new OzAiError('aborted')
				try {
					return await withTimeout(() => vary.run(p, model))
				} catch (e) {
					last = e
				}
			}
		}
	}
	throw new OzAiError('all providers and models failed', last)
}

async function completion(
	payload: RequestPayload,
	signal?: AbortSignal,
	explicitModel = true,
): Promise<string> {
	return withFailover(
		async (p) =>
			extractContent(await p.client.chat.completions.create(payload)),
		signal,
		{
			explicitModel,
			run: async (p, model) =>
				extractContent(
					await p.client.chat.completions.create({ ...payload, model }),
				),
		},
	)
}

/**
 * Chat completion from messages.
 * `stream:true` → returns an async-iterable of text chunks with failover.
 */
export function chat(
	messages: Message[],
	options: ChatOptions & { stream: true },
): Promise<AsyncIterable<string>>
export function chat(
	messages: Message[],
	options?: ChatOptions,
): Promise<string>
export function chat(
	messages: Message[],
	options: ChatOptions = {},
): Promise<string | AsyncIterable<string>> {
	if (options.stream)
		return streamChat(buildPayload(messages, options), options.signal)
	return completion(
		buildPayload(messages, options),
		options.signal,
		!!options.model,
	)
}

/** One-shot completion from a prompt, with optional system prompt. */
export async function complete(
	prompt: string,
	options: ChatOptions & { system?: string } = {},
): Promise<string> {
	const messages: Message[] = []
	if (options.system) messages.push({ role: 'system', content: options.system })
	messages.push({ role: 'user', content: prompt })
	return completion(buildPayload(messages, options), options.signal, !!options.model)
}

/** Vision: answer over an image (data URL or http url). */
export async function vision(
	prompt: string,
	imageDataUrl: string,
	options: ChatOptions = {},
): Promise<string> {
	return completion(
		buildPayload(buildVisionMessages(prompt, imageDataUrl), options),
		options.signal, !!options.model,
	)
}

/** Streaming chat: async-iterable of text chunks, with provider failover. */
async function streamChat(
	payload: RequestPayload,
	signal?: AbortSignal,
): Promise<AsyncIterable<string>> {
	return withFailover(async (p) => {
		const res = await p.client.chat.completions.create({
			...payload,
			stream: true,
		})
		if (!isAsyncIterable(res))
			throw new OzAiError(`provider ${p.name} did not stream`)
		return (async function* () {
			for await (const chunk of res) {
				if (signal?.aborted) throw new OzAiError('aborted')
				const delta = extractDelta(chunk)
				if (delta) yield delta
			}
		})()
	}, signal)
}

/** Generate an image; returns its URL. Failover across providers. */
export async function image(
	prompt: string,
	options: { model?: string; signal?: AbortSignal } = {},
): Promise<string> {
	return withFailover(async (p) => {
		if (!p.client.images)
			throw new OzAiError(`provider ${p.name} has no images`)
		return extractImageUrl(
			await p.client.images.generate({
				model: options.model ?? 'flux',
				prompt,
			}),
		)
	}, options.signal)
}

/**
 * All model ids across the provider chain (deduped). Empty on total failure.
 * Never throws.
 */
export async function listModels(signal?: AbortSignal): Promise<string[]> {
	let list: Provider[]
	try {
		list = await providers()
	} catch {
		return []
	}
	const ids = new Set<string>()
	for (const p of list) {
		if (signal?.aborted) break
		try {
			const models = (await p.client.models?.list()) ?? []
			for (const m of models) {
				const id = modelId(m)
				if (id) ids.add(id)
			}
		} catch {
			// skip a provider that can't list; others may still work
		}
	}
	return [...ids]
}
