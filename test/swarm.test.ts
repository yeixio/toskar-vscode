import { createServer, type ServerResponse, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type * as vscode from 'vscode'
import { handler } from '../src/participant'
import { agentOf, contractAtLeast, Lanes, swarmRequest, updateMessage } from '../src/swarm'
import { Toskar } from '../src/toskar'
import { answers, dialogs } from './vscode-stub'

describe('swarmRequest', () => {
  it('reads race or split from the first word, and splits by default', () => {
    expect(swarmRequest('race Which is faster?')).toEqual({ mode: 'race', prompt: 'Which is faster?' })
    expect(swarmRequest(' Split: review this ')).toEqual({ mode: 'split', prompt: 'review this' })
    expect(swarmRequest('Compare these two')).toEqual({ mode: 'split', prompt: 'Compare these two' })
    expect(swarmRequest('racers in history')).toEqual({ mode: 'split', prompt: 'racers in history' })
    expect(swarmRequest('race')).toEqual({ mode: 'race', prompt: '' })
  })
})

describe('contractAtLeast', () => {
  it('compares major and minor as numbers', () => {
    expect(contractAtLeast('1.88', '1.88')).toBe(true)
    expect(contractAtLeast('1.100', '1.88')).toBe(true)
    expect(contractAtLeast('2.0', '1.88')).toBe(true)
    expect(contractAtLeast('1.87', '1.88')).toBe(false)
    expect(contractAtLeast('1.9', '1.88')).toBe(false)
    expect(contractAtLeast('', '1.88')).toBe(false)
  })
  it('tells an older Toskar to update, naming another computer', () => {
    expect(updateMessage('1.87', 'rig.local')).toContain('Toskar on rig.local is older (it speaks contract 1.87, and swarms need 1.88). Update Toskar')
    expect(updateMessage('', '')).toContain('Toskar on this computer is older. Update Toskar')
  })
})

describe('agentOf', () => {
  it("is an agent's number and part from its tool.requested, and nothing for a chat's own", () => {
    expect(agentOf({ swarm_id: 's1', agent: 'Agent 2: Reviews', agent_number: 2 })).toEqual({ label: 'Agent 2', part: 'Reviews' })
    expect(agentOf({ swarm_id: 's1', agent: 'Agent 3' })).toEqual({ label: 'Agent 3', part: '' })
    expect(agentOf({ conversation_id: 'c1' })).toBeUndefined()
  })
})

/** A swarm as Toskar's events tell it, for the coordinator chat coord. */
const swarmEvents: { type: string; payload: Record<string, unknown> }[] = [
  { type: 'chat.started', payload: { conversation_id: 'coord' } },
  { type: 'swarm.started', payload: { conversation_id: 'coord', swarm_id: 's1', mode: 'split', agents: [
    { agent: 1, conversation_id: 'a1', part: 'docs', role: 'agent:1', model: 'qwen3.5-27b', node_id: 'n-local', status: 'running' },
    { agent: 2, conversation_id: 'a2', part: 'tests', role: 'agent:2', model: 'qwen3.5-9b', node_id: 'n-laptop', status: 'queued' },
  ] } },
  { type: 'swarm.agent.started', payload: { conversation_id: 'coord', swarm_id: 's1', agent: 2, agent_conversation_id: 'a2', node_id: 'n-laptop', model: 'qwen3.5-9b' } },
  { type: 'swarm.agent.progress', payload: { conversation_id: 'coord', swarm_id: 's1', agent: 2, step: 1, tool: 'terminal', summary: 'running go test' } },
  // Another person's chat, and another swarm: not this chat's.
  { type: 'swarm.agent.progress', payload: { conversation_id: 'other', swarm_id: 's9', agent: 1, step: 1, tool: 'terminal', summary: 'NOT-OURS' } },
  { type: 'swarm.agent.finished', payload: { conversation_id: 'coord', swarm_id: 's1', agent: 1, status: 'done', summary: 'The docs say | to use v2', tokens: 900, seconds: 12 } },
  { type: 'swarm.agent.finished', payload: { conversation_id: 'coord', swarm_id: 's1', agent: 2, status: 'out_of_budget', summary: '', tokens: 2000, seconds: 30 } },
  { type: 'swarm.merging', payload: { conversation_id: 'coord', swarm_id: 's1', mode: 'split' } },
  { type: 'swarm.finished', payload: { conversation_id: 'coord', swarm_id: 's1', status: 'done', tokens: 2900, seconds: 31 } },
]

const nodes = [
  { id: 'n-local', name: 'desk', is_local: true },
  { id: 'n-laptop', name: 'laptop' },
]

describe('Lanes', () => {
  it('shows each agent update as a compact line, the live line as it goes, and a summary at the end', () => {
    const progress: string[] = []
    let md = ''
    const lanes = new Lanes('coord', { progress: (s) => progress.push(s), markdown: (s) => (md += s) })
    lanes.setNodes(nodes)
    for (const e of swarmEvents) lanes.push(e.type, e.payload)
    expect(md).toBe(
      [
        '**Swarm, split: 2 agents**',
        '',
        '- Agent 1 · docs · this computer · qwen3.5-27b: starting',
        '- Agent 2 · tests · laptop · qwen3.5-9b: waiting for a free slot',
        '- Agent 2 · tests · laptop · qwen3.5-9b: started',
        '- Agent 2 · tests · laptop · qwen3.5-9b: running go test',
        '- Agent 1 · docs · this computer · qwen3.5-27b: finished: The docs say | to use v2',
        '- Agent 2 · tests · laptop · qwen3.5-9b: ran out of budget',
        '- Merging what the agents found',
        '',
      ].join('\n'),
    )
    expect(progress).toContain('Agent 2 · tests · laptop · qwen3.5-9b: running go test')
    expect(progress.at(-1)).toBe('Swarm finished')
    expect(lanes.swarmIDs).toEqual(new Set(['s1']))

    lanes.answer()
    lanes.push('swarm.agent.progress', { conversation_id: 'coord', swarm_id: 's1', agent: 1, summary: 'LATE' })
    expect(md).not.toContain('LATE')
    expect(progress.at(-1)).toContain('LATE')

    lanes.record({ id: 's1', status: 'done', agents: [{ agent: 2, status: 'out_of_budget', summary: 'Ran go test twice' }] })
    expect(lanes.summary('http://127.0.0.1:7331/chat?c=coord')).toBe(
      [
        '',
        '',
        '---',
        '',
        "**The swarm's agents**",
        '',
        '| Agent | Part | Computer | Model | Status |',
        '| --- | --- | --- | --- | --- |',
        '| 1 | docs | this computer | qwen3.5-27b | finished |',
        '| 2 | tests | laptop | qwen3.5-9b | ran out of budget |',
        '',
        "[Open the swarm in Toskar](http://127.0.0.1:7331/chat?c=coord): each agent's chat opens from there.",
        '',
      ].join('\n'),
    )
  })

  it("shows a race's winner, a conflict, and a note", () => {
    let md = ''
    const lanes = new Lanes('coord', { progress: () => {}, markdown: (s) => (md += s) })
    lanes.push('swarm.note', { conversation_id: 'coord', reason: 'one_at_a_time', note: "One agent: this computer can't run more than one at a time with this model." })
    lanes.push('swarm.started', { conversation_id: 'coord', swarm_id: 's2', mode: 'race', agents: [{ agent: 1, part: 'Which is faster?', model: 'a', node_id: 'x' }] })
    lanes.push('swarm.merging', { conversation_id: 'coord', swarm_id: 's2', agent: 1, branch: 'b', conflict: { agent: 1, branch: 'toskar/swarm/s2/agent-1', files: ['a.go'] } })
    lanes.push('swarm.agent.finished', { conversation_id: 'coord', swarm_id: 's2', agent: 1, status: 'done' })
    lanes.push('swarm.finished', { conversation_id: 'coord', swarm_id: 's2', status: 'done', winner: 1 })
    expect(md).toContain("*One agent: this computer can't run more than one at a time with this model.*\n\n")
    expect(md).toContain("- Conflict: Agent 1's change to a.go wasn't merged; it's on the branch toskar/swarm/s2/agent-1\n")
    expect(lanes.summary('')).toContain('| 1 | Which is faster? | x | a | finished, won |')
  })
})

// A Toskar with swarms, or an older one, that keeps what it was sent.
let server: Server
let base = ''
let contract = '1.88'
let chatMode: 'swarm' | 'hang' = 'swarm'
let chatBody: Record<string, unknown> | undefined
let chatClosed: Promise<void> = Promise.resolve()
const posted: { path: string; body: Record<string, unknown> }[] = []
const listeners: ServerResponse[] = []

function send(res: ServerResponse, e: { type: string; payload: Record<string, unknown> }) {
  res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    const path = req.url ?? ''
    if (req.method === 'POST') posted.push({ path, body })
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Toskar-Contract', contract)
    if (path === '/api/v1/version') {
      res.end(JSON.stringify({ version: '1.14.0', contract: { version: contract, major: 1 } }))
    } else if (path === '/api/v1/conversations') {
      res.end(JSON.stringify({ id: 'coord', title: body.title }))
    } else if (path === '/api/v1/events') {
      res.setHeader('Content-Type', 'text/event-stream')
      res.flushHeaders()
      listeners.push(res)
      res.on('close', () => {
        const i = listeners.indexOf(res)
        if (i >= 0) listeners.splice(i, 1)
      })
    } else if (path === '/api/v1/nodes') {
      res.end(JSON.stringify(nodes))
    } else if (path === '/api/v1/swarms/s1') {
      res.end(JSON.stringify({ id: 's1', status: 'done', agents: [{ agent: 2, status: 'out_of_budget', summary: 'Ran go test twice' }] }))
    } else if (path === '/api/v1/chat') {
      chatBody = body
      res.setHeader('Content-Type', 'text/event-stream')
      res.flushHeaders()
      if (chatMode === 'hang') {
        chatClosed = new Promise((resolve) => req.socket.on('close', resolve))
        return
      }
      for (const l of listeners) {
        send(l, swarmEvents[1])
        // An agent's tool asks, in the agent's own chat.
        send(l, { type: 'tool.requested', payload: { conversation_id: 'a2', swarm_id: 's1', agent: 'Agent 2: tests', agent_number: 2, request_id: 'r1', tool_id: 'terminal', args: { command: 'go test ./...' }, reason: 'chat requested tool' } })
        for (const e of swarmEvents.slice(2)) send(l, e)
      }
      await new Promise((r) => setTimeout(r, 150))
      res.end('event: token\ndata: {"content":"Use v2."}\n\nevent: done\ndata: {}\n\n')
    } else if (path === '/api/v1/chat/stop') {
      res.end('{"stopped":true}')
    } else if (path === '/api/v1/tools/decide') {
      res.end('{"ok":true}')
    } else {
      res.statusCode = 404
      res.end('{}')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  for (const l of listeners) l.end()
  server.close()
})

beforeEach(() => {
  contract = '1.88'
  chatMode = 'swarm'
  chatBody = undefined
  posted.length = 0
  dialogs.length = 0
  answers.next = undefined
})

/** A cancellation token that cancels when cancel is called. */
function cancellation() {
  const callbacks: (() => void)[] = []
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: (cb: () => void) => {
      callbacks.push(cb)
      return { dispose: () => {} }
    },
  }
  return { token: token as unknown as vscode.CancellationToken, cancel: () => ((token.isCancellationRequested = true), callbacks.forEach((cb) => cb())) }
}

async function turn(prompt: string, command: string | undefined, token = cancellation().token) {
  let md = ''
  const progress: string[] = []
  const stream = { markdown: (s: string) => (md += s), progress: (s: string) => progress.push(s) } as unknown as vscode.ChatResponseStream
  const request = { prompt, command, references: [] } as unknown as vscode.ChatRequest
  const context = { history: [] } as unknown as vscode.ChatContext
  const result = await handler(async () => new Toskar(base, undefined))(request, context, stream, token)
  return { md, progress, result }
}

describe('@toskar /swarm', () => {
  it('sends the turn as a race, shows the lanes and then the answer, and asks for an agent by its number', async () => {
    answers.next = 'Allow for This Agent'
    const { md, progress, result } = await turn('race Which is faster?', 'swarm')
    expect(chatBody).toMatchObject({ conversation_id: 'coord', message: 'Which is faster?', swarm: 'race', client: 'editor' })
    expect(posted.find((p) => p.path === '/api/v1/conversations')?.body.title).toBe('Which is faster?')
    expect(result).toEqual({ metadata: { conversationId: 'coord' } })

    expect(md).toContain('- Agent 2 · tests · laptop · qwen3.5-9b: running go test\n')
    expect(md).not.toContain('NOT-OURS')
    // Lanes, then the answer, then the agents.
    const lanes = md.indexOf('Merging what the agents found')
    const answer = md.indexOf('Use v2.')
    const agents = md.indexOf("**The swarm's agents**")
    expect(lanes).toBeGreaterThan(0)
    expect(answer).toBeGreaterThan(lanes)
    expect(agents).toBeGreaterThan(answer)
    expect(md).toContain('| 2 | tests | laptop | qwen3.5-9b | ran out of budget |')
    expect(md).toContain(`[Open the swarm in Toskar](${base}/chat?c=coord)`)
    expect(progress).toContain('Merging what the agents found')

    expect(dialogs).toEqual([{ message: 'Agent 2: Toskar wants to run terminal', detail: "Agent 2's part: tests\n\n{\n  \"command\": \"go test ./...\"\n}", buttons: ['Allow', 'Allow for This Agent'] }])
    expect(posted.find((p) => p.path === '/api/v1/tools/decide')?.body).toEqual({ request_id: 'r1', allow: true, allow_session: true })
  })

  it('splits by default, and a turn without /swarm sends no swarm', async () => {
    await turn('Review this', 'swarm')
    expect(chatBody).toMatchObject({ message: 'Review this', swarm: 'split' })
    await turn('Review this', undefined)
    expect(chatBody).not.toHaveProperty('swarm')
  })

  it('tells an older Toskar to update, without starting a chat', async () => {
    contract = '1.87'
    const { md, result } = await turn('race Which is faster?', 'swarm')
    expect(md).toContain('Swarms need a newer Toskar. Toskar on this computer is older (it speaks contract 1.87, and swarms need 1.88). Update Toskar')
    expect(result).toEqual({})
    expect(posted).toEqual([])
  })

  it('says how to use /swarm without a question', async () => {
    const { md } = await turn('race', 'swarm')
    expect(md).toContain('Ask a question after `/swarm`')
    expect(posted).toEqual([])
  })

  it("stops the whole swarm through the coordinator chat's stop when VS Code cancels", async () => {
    chatMode = 'hang'
    const { token, cancel } = cancellation()
    const done = turn('Which is faster?', 'swarm', token)
    for (let i = 0; i < 100 && !chatBody; i++) await new Promise((r) => setTimeout(r, 10))
    expect(chatBody).toMatchObject({ swarm: 'split' })
    cancel()
    const { result } = await done
    expect(result).toEqual({ metadata: { conversationId: 'coord' } })
    await chatClosed
    for (let i = 0; i < 100 && !posted.some((p) => p.path === '/api/v1/chat/stop'); i++) await new Promise((r) => setTimeout(r, 10))
    expect(posted.find((p) => p.path === '/api/v1/chat/stop')?.body).toEqual({ conversation_id: 'coord' })
  })
})
