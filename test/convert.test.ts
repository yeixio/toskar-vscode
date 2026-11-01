import { describe, expect, it } from 'vitest'
import { estimateTokens, parseInput, StreamReader, toChatMessages, toChatTools } from '../src/convert'

describe('toChatMessages', () => {
  it('turns tool calls and results into Chat Completions turns', () => {
    const out = toChatMessages([
      { role: 'system', parts: [{ kind: 'text', text: 'You are a coding agent.' }] },
      { role: 'user', parts: [{ kind: 'text', text: "What's in main.go?" }] },
      { role: 'assistant', parts: [{ kind: 'text', text: 'Let me look.' }, { kind: 'call', callId: 'c1', name: 'read_file', input: { path: 'main.go' } }] },
      {
        role: 'user',
        parts: [
          { kind: 'result', callId: 'c1', text: 'package main' },
          { kind: 'text', text: 'And this?' },
          { kind: 'image', mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) },
        ],
      },
    ])
    expect(out).toEqual([
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: [{ type: 'text', text: "What's in main.go?" }] },
      { role: 'assistant', content: 'Let me look.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"main.go"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'package main' },
      { role: 'user', content: [{ type: 'text', text: 'And this?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } }] },
    ])
  })

  it('leaves out a user turn that only carried tool results', () => {
    const out = toChatMessages([{ role: 'user', parts: [{ kind: 'result', callId: 'c1', text: 'ok' }] }])
    expect(out).toEqual([{ role: 'tool', tool_call_id: 'c1', content: 'ok' }])
  })
})

describe('toChatTools', () => {
  it('makes function tools, with an empty schema when there is none', () => {
    expect(toChatTools([{ name: 'a', description: 'A', inputSchema: { type: 'object', properties: { x: { type: 'string' } } } }, { name: 'b', description: 'B' }])).toEqual([
      { type: 'function', function: { name: 'a', description: 'A', parameters: { type: 'object', properties: { x: { type: 'string' } } } } },
      { type: 'function', function: { name: 'b', description: 'B', parameters: { type: 'object', properties: {} } } },
    ])
  })
})

describe('StreamReader', () => {
  it('gives text as it comes and each tool call once it is whole', () => {
    const r = new StreamReader()
    const events = [
      ...r.push('data: {"choices":[{"delta":{"content":"I\'ll "}}]}\n\n'),
      // A line split across chunks.
      ...r.push('data: {"choices":[{"delta":{"content":"read'),
      ...r.push(' it."}}]}\n\n'),
      ...r.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_7","function":{"name":"read_file","arguments":"{\\"pa"}}]}}]}\n\n'),
      ...r.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"go.mod\\"}"}}]}}]}\n\n'),
      ...r.push('data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_8","function":{"name":"list","arguments":"{}"}}]}}]}\n\n'),
      ...r.push('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'),
      ...r.push('data: [DONE]\n\n'),
      ...r.finish(),
    ]
    expect(events).toEqual([
      { kind: 'text', text: "I'll " },
      { kind: 'text', text: 'read it.' },
      { kind: 'call', callId: 'call_7', name: 'read_file', input: { path: 'go.mod' } },
      { kind: 'call', callId: 'call_8', name: 'list', input: {} },
    ])
  })

  it('gives a tool call the stream never finished, at the end', () => {
    const r = new StreamReader()
    r.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"x","arguments":"{\\"a\\":1}"}}]}}]}\n')
    expect(r.finish()).toEqual([{ kind: 'call', callId: 'call_0', name: 'x', input: { a: 1 } }])
  })
})

describe('parseInput and estimateTokens', () => {
  it('takes only a JSON object as input', () => {
    expect(parseInput('{"a":1}')).toEqual({ a: 1 })
    expect(parseInput('[1]')).toEqual({})
    expect(parseInput('not json')).toEqual({})
    expect(parseInput('')).toEqual({})
  })
  it('estimates four characters a token', () => {
    expect(estimateTokens('abcdefgh')).toBe(2)
  })
})
