import * as vscode from 'vscode'
import { chatEventOf, computerOf, conversationOf, dataOf, describeTool, EventReader, titleOf, withData, type Snippet } from './ask'
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
    token.onCancellationRequested(() => abort.abort())

    const snippets = await snippetsOf(request.references)
    if (picked && Date.now() - picked.at < pickLasts) snippets.unshift(picked.snippet)
    picked = undefined
    for (const s of snippets) stream.progress(`With ${s.label}`)
    const { data, cut } = dataOf(snippets)
    if (cut) stream.markdown(`*Only the first part of the code fits in one message; the rest was left out.*\n\n`)

    let conversationID = conversationOf(
      context.history.map((t) => ({ participant: t.participant, metadata: t instanceof vscode.ChatResponseTurn ? t.result.metadata : undefined })),
      participantID,
    )
    if (!conversationID) {
      try {
        conversationID = (await toskar.createConversation(titleOf(request.prompt), profile, model, abort.signal)).id
      } catch (err) {
        return { errorDetails: { message: (err as Error).message } }
      }
    }

    // Tools that ask first, and tools at work, come as Toskar's events,
    // followed from before the message is sent so none is missed.
    const events = await toskar.events(abort.signal).catch(() => undefined)
    if (events) void watch(toskar, events, conversationID, stream, abort.signal)
    try {
      const body = await toskar.ask({ conversationID, message: withData(request.prompt, data), model, profile }, abort.signal)
      const reader = new EventReader()
      const decoder = new TextDecoder()
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        for (const raw of reader.push(decoder.decode(chunk, { stream: true }))) {
          const e = chatEventOf(raw)
          if (e?.kind === 'token') stream.markdown(e.content)
          else if (e?.kind === 'error') return { errorDetails: { message: e.message }, metadata: { conversationId: conversationID } }
          else if (e?.kind === 'done' && e.tokensPerSecond) lastSpeed.fire(e.tokensPerSecond)
        }
      }
    } catch (err) {
      if (token.isCancellationRequested) return { metadata: { conversationId: conversationID } }
      return { errorDetails: { message: (err as Error).message }, metadata: { conversationId: conversationID } }
    } finally {
      abort.abort()
    }
    return { metadata: { conversationId: conversationID } }
  }
}

/** The files, selections, and text a request's #-references name. */
async function snippetsOf(refs: readonly vscode.ChatPromptReference[]): Promise<Snippet[]> {
  const out: Snippet[] = []
  for (const r of refs) {
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

/** Follows this chat's events until the answer ends. */
async function watch(toskar: Toskar, events: ReadableStream<Uint8Array>, conversationID: string, stream: vscode.ChatResponseStream, signal: AbortSignal): Promise<void> {
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
        if (p.conversation_id !== conversationID) continue
        if (e.type === 'tool.requested') void ask(toskar, p, signal)
        else if (e.type === 'tool.started') stream.progress(String(p.summary || p.tool_id || 'Working'))
      }
    }
  } catch {
    // The answer ended.
  }
}

/** Asks whether a tool may run, and tells Toskar. */
async function ask(toskar: Toskar, p: Record<string, unknown>, signal: AbortSignal): Promise<void> {
  const { message, detail } = describeTool(String(p.tool_id ?? 'a tool'), p.args, String(p.reason ?? ''), computerOf(toskar.url))
  const choice = await vscode.window.showWarningMessage(message, { modal: true, detail }, 'Allow')
  if (signal.aborted) return
  await toskar.decide(String(p.request_id), choice === 'Allow').catch(() => undefined)
}
