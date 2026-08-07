/** OpenAI-shape chat message. */
export interface Message {
	role: 'system' | 'user' | 'assistant'
	content: string | ContentPart[]
}

export type ContentPart =
	| { type: 'text'; text: string }
	| { type: 'image_url'; image_url: { url: string } }

export interface ChatOptions {
	/** g4f model id. Default 'gpt-4o-mini' (auto-router picks a live provider). */
	model?: string
	/** Abort the request. */
	signal?: AbortSignal
	/** Sampling temperature. */
	temperature?: number
	/** Stream the response as an async-iterable of text chunks. */
	stream?: boolean
}

export interface RequestPayload {
	model: string
	messages: Message[]
	temperature?: number
	stream?: boolean
}

/** Build the OpenAI-shape request body. Pure — no I/O. */
export function buildPayload(
	messages: Message[],
	options: ChatOptions = {},
): RequestPayload {
	const payload: RequestPayload = {
		model: options.model ?? 'gpt-4o-mini',
		messages,
	}
	if (options.temperature !== undefined)
		payload.temperature = options.temperature
	if (options.stream) payload.stream = true
	return payload
}

/** Build a vision message from a prompt + image data URL (or http url). Pure. */
export function buildVisionMessages(
	prompt: string,
	imageDataUrl: string,
): Message[] {
	return [
		{
			role: 'user',
			content: [
				{ type: 'text', text: prompt },
				{ type: 'image_url', image_url: { url: imageDataUrl } },
			],
		},
	]
}

/** Extract assistant text from a non-stream g4f/OpenAI completion. Pure. */
export function extractContent(res: unknown): string {
	const content = (res as { choices?: { message?: { content?: unknown } }[] })
		?.choices?.[0]?.message?.content
	if (typeof content !== 'string')
		throw new Error('malformed response: no choices[0].message.content')
	return content
}

/** Extract a streamed delta text from a g4f/OpenAI chunk. Pure. '' if none. */
export function extractDelta(chunk: unknown): string {
	const delta = (chunk as { choices?: { delta?: { content?: unknown } }[] })
		?.choices?.[0]?.delta?.content
	return typeof delta === 'string' ? delta : ''
}

/** Extract an image URL from a g4f images.generate response. Pure. */
export function extractImageUrl(res: unknown): string {
	const url = (res as { data?: { url?: unknown }[] })?.data?.[0]?.url
	if (typeof url !== 'string')
		throw new Error('malformed response: no data[0].url')
	return url
}

/** Normalize a model list entry to its id. Pure. '' if unusable. */
export function modelId(m: unknown): string {
	if (typeof m === 'string') return m
	const id = (m as { id?: unknown; name?: unknown })?.id
	if (typeof id === 'string') return id
	const name = (m as { name?: unknown })?.name
	return typeof name === 'string' ? name : ''
}
