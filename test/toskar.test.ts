import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Toskar, ToskarError } from '../src/toskar'

// A Toskar that keeps what it was sent and answers as the real one does.
let server: Server
let base = ''
let lastBody: Record<string, unknown> = {}
let lastAuth = ''

beforeAll(async () => {
  server = createServer(async (req: IncomingMessage, res) => {
    lastAuth = req.headers.authorization ?? ''
    let raw = ''
    for await (const chunk of req) raw += chunk
    lastBody = raw ? JSON.parse(raw) : {}
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/v1/models') {
      res.end(JSON.stringify([
        { id: 'qwen2.5-coder-7b-q4', display_name: 'Qwen 2.5 Coder 7B', installed: true, context_window: 32768, capabilities: { tool_calling: true } },
        { id: 'not-here', installed: false },
        { id: 'nomic-embed', installed: true, support_role: 'embedding' },
      ]))
    } else if (req.url === '/api/v1/conversations') {
      res.end(JSON.stringify({ id: 'conv1', title: lastBody.title }))
    } else if (req.url === '/api/v1/chat') {
      res.setHeader('Content-Type', 'text/event-stream')
      res.end('event: token\ndata: {"content":"hi"}\n\nevent: done\ndata: {}\n\n')
    } else if (req.url === '/api/v1/tools/decide') {
      res.end('{"ok":true}')
    } else if (req.url === '/v1/chat/completions' && lastBody.model === 'raw:locked') {
      res.statusCode = 403
      res.end(JSON.stringify({ error: { code: 'RAW_NOT_ALLOWED', message: "this key can't drive a model directly" } }))
    } else if (req.url === '/v1/chat/completions') {
      res.setHeader('Content-Type', 'text/event-stream')
      res.end('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n')
    } else {
      res.statusCode = 404
      res.end('{}')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.close()
})

describe('Toskar', () => {
  it('lists only installed chat models', async () => {
    const models = await new Toskar(base, undefined).chatModels()
    expect(models.map((m) => m.id)).toEqual(['qwen2.5-coder-7b-q4'])
    expect(lastAuth).toBe('')
  })

  it('asks for the model raw, streamed, with the key', async () => {
    const stream = await new Toskar(base, 'ygg_key').chat('qwen2.5-coder-7b-q4', { messages: [{ role: 'user', content: 'hi' }], tools: [] })
    let text = ''
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) text += new TextDecoder().decode(chunk)
    expect(text).toContain('"content":"hi"')
    expect(lastBody).toMatchObject({ model: 'raw:qwen2.5-coder-7b-q4', stream: true, tools: [] })
    expect(lastAuth).toBe('Bearer ygg_key')
  })

  it('says what to do when the key has no raw access', async () => {
    const err = await new Toskar(base, 'ygg_key').chat('locked', { messages: [] }).catch((e) => e)
    expect(err).toBeInstanceOf(ToskarError)
    expect(err.message).toContain('Drive models directly, for coding agents')
    expect(err.status).toBe(403)
  })

  it("asks Toskar's assistant in a new chat, marked as from an editor", async () => {
    const toskar = new Toskar(base, undefined)
    expect(await toskar.createConversation('Why?', 'programming')).toEqual({ id: 'conv1', title: 'Why?' })
    expect(lastBody).toEqual({ title: 'Why?', profile_id: 'programming' })
    let text = ''
    for await (const chunk of (await toskar.ask({ conversationID: 'conv1', message: 'Why?', model: 'qwen2.5-7b-q4' })) as unknown as AsyncIterable<Uint8Array>) text += new TextDecoder().decode(chunk)
    expect(text).toContain('event: done')
    expect(lastBody).toEqual({ conversation_id: 'conv1', message: 'Why?', stream: true, client: 'editor', model_id: 'qwen2.5-7b-q4' })
    await toskar.decide('req1', false)
    expect(lastBody).toEqual({ request_id: 'req1', allow: false, allow_session: false })
    await toskar.decide('req2', true, true)
    expect(lastBody).toEqual({ request_id: 'req2', allow: true, allow_session: true })
  })

  it('says Toskar is not answering when nothing listens', async () => {
    const err = await new Toskar('http://127.0.0.1:1', undefined).chatModels().catch((e) => e)
    expect(err.message).toContain("Toskar isn't answering at http://127.0.0.1:1")
  })
})
