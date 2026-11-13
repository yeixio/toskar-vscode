import * as vscode from 'vscode'
import { attachedByPerson, chatEventOf, computerOf, conversationOf, dataOf, describeTool, distinct, EventReader, promptFor, titleOf, withData, type Snippet } from './ask'
import { agentOf, contractAtLeast, Lanes, swarmContract, swarmRequest, updateMessage, type SwarmMode } from './swarm'
import type { Toskar, ToskarEvent } from './toskar'

export const participantID = 'toskar.chat'

/**
 * Code "Ask Toskar about this" picked, for the next @toskar message within
 * a few minutes, so it can't ride along with an unrelated one later.
 */
let picked: { snippet: Snippet; at: number } | undefined
const pickLasts = 5 * 60_000

/** Remembers the selection, or the whole file, for the next @toskar message. */
export function pick(editor: vscode.TextEditor | undefined): Snippet | undefined {
  picked = undefined
  if (!editor) return undefined
  const doc = editor.document
  const path = vscode.workspace.asRelativePath(doc.uri)
  const sel = editor.selection
  const snippet = sel.isEmpty ? { label: path, text: doc.getText() } : { label: `${path}, lines ${sel.start.line + 1}–${sel.end.line + 1}`, text: doc.getText(sel) }
  picked = { snippet, at: Date.now() }
  return snippet
}

/** The last answer's speed, for the status bar. */
export const lastSpeed = new vscode.EventEmitter<number>()

/**
 * @toskar in Copilot Chat (toskar-core#960): Toskar's assistant, with its
 * profiles, knowledge, and memory, in a Toskar chat the apps list too. Code
 * picked with "Ask Toskar about this" and #-references go with the message
 * as data. A tool that asks first asks here; when Toskar's events can't be
 * followed, it's refused once Toskar's wait for an answer runs out.
 */
export function handler(connect: () => Promise<Toskar>): vscode.ChatRequestHandler {
  return async (request, context, stream, token) => {
    const toskar = await connect()
    const settings = vscode.workspace.getConfiguration('toskar')
    const model = settings.get<string>('chatModel') || undefined
    const profile = settings.get<string>('profile') || undefined
    const abort = new AbortController()
    // Stop also tells Toskar, so a turn on another computer, or a swarm's
    // agents, stop too, whatever is between here and there.
    let conversationID: string | undefined
    let sent = false
    token.onCancellationRequested(() => {
      abort.abort()
      if (sent && conversationID) void toskar.stop(conversationID).catch(() => undefined)
    })

    // /swarm [race|split]: several agents at once, on a Toskar that has swarms.
    let prompt = request.prompt
    let swarm: SwarmMode | undefined
    if (request.command === 'swarm') {
      const asked = swarmRequest(prompt)
      if (!asked.prompt && !request.references.length && !picked) {
        stream.markdown('Ask a question after `/swarm`, such as `@toskar /swarm race Which of these is faster?` A first word of `race` has several models answer it all; `split`, the default, splits it into parts.')
        return {}
      }
      swarm = asked.mode
      prompt = asked.prompt
      let contract = ''
      try {
        contract = await toskar.contract(abort.signal)
      } catch (err) {
        if (token.isCancellationRequested) return {}
        return { errorDetails: { message: (err as Error).message } }
      }
      if (!contractAtLeast(contract, swarmContract)) {
        stream.markdown(updateMessage(contract, computerOf(toskar.url)))
        return {}
      }
    }

    let snippets = await snippetsOf(request.references)
    if (picked && Date.now() - picked.at < pickLasts) snippets.unshift(picked.snippet)
    snippets = distinct(snippets)
    picked = undefined
    for (const s of snippets) stream.progress(`With ${s.label}`)
    const { data, cut } = dataOf(snippets)
    if (cut) stream.markdown(`*Only the first part of the code fits in one message; the rest was left out.*\n\n`)

    conversationID = conversationOf(
      context.history.map((t) => ({ participant: t.participant, metadata: t instanceof vscode.ChatResponseTurn ? t.result.metadata : undefined })),
      participantID,
    )
    if (!conversationID) {
      try {
        conversationID = (await toskar.createConversation(titleOf(prompt), profile, model, abort.signal)).id
      } catch (err) {
        return { errorDetails: { message: (err as Error).message } }
      }
    }
    const metadata = { conversationId: conversationID }

    // Tools that ask first, tools at work, and a swarm's agents come as
    // Toskar's events, followed from before the message is sent so none is
    // missed. A message that asks for a swarm in words gets lanes too.
    const lanes = new Lanes(conversationID, stream)
    const events = await toskar.events(abort.signal).catch(() => undefined)
    if (events) void watch(toskar, events, lanes, stream, abort.signal)
    try {
      sent = true
      const body = await toskar.ask({ conversationID, message: withData(promptFor(prompt, data), data), model, profile, swarm }, abort.signal)
      const reader = new EventReader()
      const decoder = new TextDecoder()
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        for (const raw of reader.push(decoder.decode(chunk, { stream: true }))) {
          const e = chatEventOf(raw)
          if (e?.kind === 'token') {
            lanes.answer()
            stream.markdown(e.content)
          } else if (e?.kind === 'error') return { errorDetails: { message: e.message }, metadata }
          else if (e?.kind === 'done' && e.tokensPerSecond) lastSpeed.fire(e.tokensPerSecond)
        }
      }
      lanes.answer()
      if (lanes.started && !token.isCancellationRequested) {
        // The record has the last word on each agent, whatever events are still on their way.
        const [id] = lanes.swarmIDs
        const record = await toskar.swarm(id, abort.signal).catch(() => undefined)
        if (record) lanes.record(record)
        stream.markdown(lanes.summary(chatLink(toskar.url, conversationID)))
      }
    } catch (err) {
      if (token.isCancellationRequested) return { metadata }
      return { errorDetails: { message: (err as Error).message }, metadata }
    } finally {
      abort.abort()
    }
    return { metadata }
  }
}

/** A chat in Toskar's web app. */
export function chatLink(url: string, conversationID: string): string {
  return `${url.replace(/\/+$/, '')}/chat?c=${encodeURIComponent(conversationID)}`
}

/** The files, selections, and text a request's #-references name. */
async function snippetsOf(refs: readonly vscode.ChatPromptReference[]): Promise<Snippet[]> {
  const out: Snippet[] = []
  for (const r of refs) {
    if (!attachedByPerson(r.id)) continue
    try {
      if (r.value instanceof vscode.Uri) {
        const doc = await vscode.workspace.openTextDocument(r.value)
        out.push({ label: vscode.workspace.asRelativePath(r.value), text: doc.getText() })
      } else if (r.value instanceof vscode.Location) {
        const doc = await vscode.workspace.openTextDocument(r.value.uri)
        const { start, end } = r.value.range
        out.push({ label: `${vscode.workspace.asRelativePath(r.value.uri)}, lines ${start.line + 1}–${end.line + 1}`, text: doc.getText(r.value.range) })
      } else if (typeof r.value === 'string' && r.value) {
        out.push({ label: r.modelDescription || r.id, text: r.value })
      }
    } catch {
      // A folder or a file that isn't text: there's nothing to send.
    }
  }
  return out
}

/** Follows this chat's events until the answer ends: its tools, and a swarm's lanes. */
async function watch(toskar: Toskar, events: ReadableStream<Uint8Array>, lanes: Lanes, stream: vscode.ChatResponseStream, signal: AbortSignal): Promise<void> {
  let named = false
  try {
    const reader = new EventReader()
    const decoder = new TextDecoder()
    for await (const chunk of events as unknown as AsyncIterable<Uint8Array>) {
      for (const raw of reader.push(decoder.decode(chunk, { stream: true }))) {
        let e: ToskarEvent
        try {
          e = JSON.parse(raw.data) as ToskarEvent
        } catch {
          continue
        }
        const p = e.payload ?? {}
        if (!lanes.owns(p)) continue
        if (e.type === 'swarm.started' && !named) {
          // The computers' names, for where each agent runs; ids without them.
          named = true
          const nodes = await withTimeout(toskar.nodes(signal), 2000).catch(() => undefined)
          if (nodes) lanes.setNodes(nodes)
        }
        if (signal.aborted) return
        if (lanes.push(e.type, p)) continue
        if (e.type === 'tool.requested') void ask(toskar, p, signal)
        // An agent's tools at work come as its lane's progress instead.
        else if (e.type === 'tool.started' && !agentOf(p)) stream.progress(String(p.summary || p.tool_id || 'Working'))
      }
    }
  } catch {
    // The answer ended.
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))])
}

/** Asks whether a tool may run, and tells Toskar. A swarm's agent says which one asks. */
async function ask(toskar: Toskar, p: Record<string, unknown>, signal: AbortSignal): Promise<void> {
  const agent = agentOf(p)
  let { message, detail } = describeTool(String(p.tool_id ?? 'a tool'), p.args, String(p.reason ?? ''), computerOf(toskar.url))
  if (agent) {
    message = `${agent.label}: ${message}`
    if (agent.part) detail = [`${agent.label}'s part: ${agent.part}`, detail].filter(Boolean).join('\n\n')
  }
  // Allowing for the rest of the chat is that agent's chat alone, never the whole swarm.
  const forChat = agent ? 'Allow for This Agent' : 'Allow in This Chat'
  const choice = await vscode.window.showWarningMessage(message, { modal: true, detail }, 'Allow', forChat)
  if (signal.aborted) return
  await toskar.decide(String(p.request_id), choice !== undefined, choice === forChat).catch(() => undefined)
}
