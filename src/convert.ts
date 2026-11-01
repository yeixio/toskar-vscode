// Converting between VS Code's language model messages and the Chat
// Completions shape Toskar's raw mode takes (raw:<model>, toskar-core#843).
// Nothing here imports vscode, so it's tested on its own.

/** One piece of a message, as the provider reads VS Code's parts. */
export type Part =
  | { kind: 'text'; text: string }
  | { kind: 'call'; callId: string; name: string; input: unknown }
  | { kind: 'result'; callId: string; text: string }
  | { kind: 'image'; mimeType: string; data: Uint8Array }

export type Role = 'user' | 'assistant' | 'system'

export interface Message {
  role: Role
  parts: Part[]
}

/** A Chat Completions message, as Toskar takes it. */
export type ChatMessage = Record<string, unknown>

/**
 * The messages for Toskar: a user turn's tool results become tool messages,
 * ahead of its text and pictures; an assistant turn's tool calls become its
 * tool_calls.
 */
export function toChatMessages(messages: Message[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of messages) {
    if (m.role === 'system') {
      const text = textOf(m.parts)
      if (text) out.push({ role: 'system', content: text })
      continue
    }
    if (m.role === 'assistant') {
      const calls = m.parts
        .filter((p): p is Extract<Part, { kind: 'call' }> => p.kind === 'call')
        .map((p) => ({ id: p.callId, type: 'function', function: { name: p.name, arguments: JSON.stringify(p.input ?? {}) } }))
      const msg: ChatMessage = { role: 'assistant', content: textOf(m.parts) }
      if (calls.length > 0) msg.tool_calls = calls
      out.push(msg)
      continue
    }
    for (const p of m.parts) {
      if (p.kind === 'result') out.push({ role: 'tool', tool_call_id: p.callId, content: p.text })
    }
    const content: Record<string, unknown>[] = []
    for (const p of m.parts) {
      if (p.kind === 'text' && p.text) content.push({ type: 'text', text: p.text })
      if (p.kind === 'image') {
        content.push({ type: 'image_url', image_url: { url: `data:${p.mimeType};base64,${Buffer.from(p.data).toString('base64')}` } })
      }
    }
    if (content.length > 0) out.push({ role: 'user', content })
  }
  return out
}

function textOf(parts: Part[]): string {
  return parts
    .filter((p): p is Extract<Part, { kind: 'text' }> => p.kind === 'text')
    .map((p) => p.text)
    .join('')
}

export interface Tool {
  name: string
  description: string
  inputSchema?: object
}

/** The tools as Chat Completions function tools. */
export function toChatTools(tools: readonly Tool[]): Record<string, unknown>[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema ?? { type: 'object', properties: {} } },
  }))
}

/** What the model said, as the stream gives it. */
export type StreamEvent = { kind: 'text'; text: string } | { kind: 'call'; callId: string; name: string; input: object }

/**
 * Reads Toskar's Chat Completions stream: text as it comes, and each tool
 * call once it's whole, since VS Code takes a call's input as one object.
 */
export class StreamReader {
  private buffer = ''
  private calls = new Map<number, { id: string; name: string; args: string }>()
  private done = false

  /** Feed received bytes, as text; returns what they finished. */
  push(chunk: string): StreamEvent[] {
    this.buffer += chunk
    const events: StreamEvent[] = []
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      events.push(...this.line(line))
    }
    return events
  }

  /** Call when the stream ends: the tool calls not yet given. */
  finish(): StreamEvent[] {
    const events = this.buffer.trim() ? this.line(this.buffer.trim()) : []
    this.buffer = ''
    return [...events, ...this.flushCalls()]
  }

  private line(line: string): StreamEvent[] {
    if (!line.startsWith('data:') || this.done) return []
    const data = line.slice(5).trim()
    if (data === '[DONE]') {
      this.done = true
      return this.flushCalls()
    }
    let chunk: { choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[] }
    try {
      chunk = JSON.parse(data)
    } catch {
      return []
    }
    const events: StreamEvent[] = []
    for (const choice of chunk.choices ?? []) {
      const text = choice.delta?.content
      if (text) events.push({ kind: 'text', text })
      for (const tc of choice.delta?.tool_calls ?? []) {
        const index = tc.index ?? 0
        const call = this.calls.get(index) ?? { id: '', name: '', args: '' }
        if (tc.id) call.id = tc.id
        if (tc.function?.name) call.name = tc.function.name
        if (tc.function?.arguments) call.args += tc.function.arguments
        this.calls.set(index, call)
      }
      if (choice.finish_reason) events.push(...this.flushCalls())
    }
    return events
  }

  private flushCalls(): StreamEvent[] {
    const events: StreamEvent[] = []
    for (const [index, call] of [...this.calls.entries()].sort((a, b) => a[0] - b[0])) {
      events.push({ kind: 'call', callId: call.id || `call_${index}`, name: call.name, input: parseInput(call.args) })
    }
    this.calls.clear()
    return events
  }
}

/** A tool call's arguments as an object; anything else is an empty one. */
export function parseInput(args: string): object {
  try {
    const v = JSON.parse(args || '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

/** About how many tokens text takes: four characters each, as Toskar estimates. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
