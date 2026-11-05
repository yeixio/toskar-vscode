#!/usr/bin/env node
// Stands in for llama-server: Core starts it as it would the real one, and it
// answers with a script. "You said: <message>", or, offered tools, a call to
// the first.
const { createServer } = require('node:http')

const port = Number(process.argv[process.argv.indexOf('--port') + 1])
if (process.argv.includes('--help') || process.argv.includes('--version')) process.exit(0)

createServer(async (req, res) => {
  const json = (body) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(body))
  }
  if (req.url === '/health') return json({ status: 'ok' })
  if (req.url === '/props') return json({ default_generation_settings: { n_ctx: 32768 } })
  if (req.url === '/tokenize') return json({ tokens: [1, 2, 3] })
  if (req.method !== 'POST') return json({ object: 'list', data: [{ id: 'scripted', object: 'model' }] })
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw)
  const users = (body.messages ?? []).filter((m) => m.role === 'user')
  const last = users[users.length - 1]?.content
  const text = `You said: ${Array.isArray(last) ? last.map((p) => p.text ?? '').join(' ') : last}`
  if (!body.stream) {
    return json({ id: 'c', object: 'chat.completion', created: 0, model: 'scripted', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] })
  }
  const tool = body.tools?.[0]?.function?.name
  const delta = tool ? { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: tool, arguments: '{"path":"README.md"}' } }] } : { content: text }
  const chunk = (choice) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'scripted', choices: [{ index: 0, ...choice }] })}\n\n`
  res.setHeader('Content-Type', 'text/event-stream')
  res.write(chunk({ delta, finish_reason: null }))
  res.write(chunk({ delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }))
  res.end('data: [DONE]\n\n')
}).listen(port, '127.0.0.1')
