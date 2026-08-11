declare module '@chirag127/keyless-ai' {
	export type Message = { role: 'system' | 'user' | 'assistant'; content: string }
	export type ChatOpts = {
		order?: string[]
		model?: string
		temperature?: number
		onError?: (name: string, err: Error) => void
		[k: string]: unknown
	}
	export function chat(messages: string | Message[], opts?: ChatOpts): Promise<string>
	export const PROVIDERS: Record<string, (messages: string | Message[], opts?: ChatOpts) => Promise<string>>
	export const DEFAULT_ORDER: string[]
	export const MODELS: { provider: string; model: string }[]
	export function listProviders(): string[]
}
