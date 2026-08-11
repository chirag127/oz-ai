# @chirag127/oz-ai

[![npm](https://img.shields.io/npm/v/@chirag127/oz-ai)](https://www.npmjs.com/package/@chirag127/oz-ai)

Single client-side AI client for the whole fleet. Framework-agnostic TS. Primary backend: **`@chirag127/keyless-ai`** (kilo → ovh → pollinations, no API key, Node + browser). Secondary: direct Pollinations fetch + **g4f** (`@gpt4free/g4f.dev`) CDN clients as an extended failover tail.

Built-in: ordered failover chain, max 2 retries/provider, streaming via async-iterable, `AbortSignal`, graceful throw after ALL providers fail so callers can degrade.

## Install

```sh
npm i @chirag127/oz-ai
```

## Use

```ts
import { chat, complete, vision, image, listModels, OzAiError } from '@chirag127/oz-ai'

// one-shot
const answer = await complete('Summarize photosynthesis', { system: 'Be terse.' })

// multi-turn
const reply = await chat([
  { role: 'system', content: 'You are helpful.' },
  { role: 'user', content: 'Hello' },
])

// streaming
const stream = await chat([{ role: 'user', content: 'write a haiku' }], { stream: true })
for await (const chunk of stream) process.stdout.write(chunk)

// vision (data URL or http url)
const desc = await vision('What is in this image?', dataUrl)

// image generation → url
const url = await image('a white siamese cat', { model: 'flux' })

// every model across all providers
const models = await listModels() // string[], [] on total failure

// degrade gracefully
try {
  await complete('...')
} catch (e) {
  if (e instanceof OzAiError) render('AI unavailable')
}
```

## API

| Fn | Signature |
|---|---|
| `chat` | `(messages, { model?, signal?, temperature? }) => Promise<string>` / `(messages, { stream: true, ... }) => Promise<AsyncIterable<string>>` |
| `complete` | `(prompt, { system?, model?, signal?, temperature? }) => Promise<string>` |
| `vision` | `(prompt, imageDataUrl, { model?, signal? }) => Promise<string>` |
| `image` | `(prompt, { model?, signal? }) => Promise<string>` (url) |
| `listModels` | `(signal?) => Promise<string[]>` |
| `setProviders` | `(Provider[] \| null) => void` — override/reset the failover chain |

Also exports pure helpers `buildPayload`, `buildVisionMessages`, `extractContent`, `extractDelta`, `extractImageUrl`, `modelId`, plus types `Message`, `ContentPart`, `ChatOptions`, `RequestPayload`, `Provider`, and `OzAiError`.

## Failover

Chain lives in one place (`src/index.ts`). Order: **keyless-ai** (kilo→ovh→pollinations) → pollinations-direct (raw fetch) → g4f.dev CDN clients. Change the order or set of providers HERE and every site inherits. Each provider gets up to 2 attempts before moving to the next; `OzAiError` throws only when all are exhausted.

## License

MIT
