import * as vscode from 'vscode'
import { estimateTokens, StreamReader, toChatMessages, toChatTools, type Message, type Part } from './convert'
import { ToskarError, type Toskar, type ToskarModel } from './toskar'

/** The most of a model's window kept for its answer. */
const answerTokens = 4096

/** The window a model is counted on for when Toskar says nothing. */
const fallbackWindow = 8192

/**
 * The fits at which Toskar makes a model's window bigger when a request
 * needs it (toskar-core#962): past tight, it won't.
 */
const roomyFits = new Set(['excellent', 'good', 'tight'])

/**
 * About what Copilot Chat's Agent mode takes before your question: its
 * instructions and tool definitions. Below it, Copilot stops with "static
 * system messages and tool definitions exceed this model's context budget".
 */
export const agentModeTokens = 32768

/**
 * The most context a model can have on its computer. A model starts with a
 * window that fits its memory well, and Toskar makes it bigger when a
 * request needs it, up to the largest that still fits, so that's what
 * Copilot is told. Copilot counts its tools and instructions against it
 * before it sends anything, and the window a model starts with is often too
 * small for Agent mode.
 */
export function windowOf(m: ToskarModel): number {
  const roomy = (m.context_options ?? []).filter((o) => roomyFits.has(o.fit)).map((o) => o.tokens)
  return Math.max(m.context_window || 0, ...roomy) || fallbackWindow
}

/** A Toskar model, as Copilot Chat's model picker lists it. */
export interface ToskarModelInfo extends vscode.LanguageModelChatInformation {
  readonly toskarID: string
}

export function modelInfo(m: ToskarModel, where: string): ToskarModelInfo {
  const window = windowOf(m)
  const output = Math.min(answerTokens, Math.floor(window / 4))
  const name = m.display_name || m.id
  let tooltip = `${name} on ${where}: up to ${window.toLocaleString('en-US')} tokens of context, run by Toskar.`
  if (window < agentModeTokens) {
    tooltip += ` Copilot's Agent mode needs about ${agentModeTokens.toLocaleString('en-US')}, so use Ask mode with it, or pick a smaller model, which has room for more.`
  }
  return {
    id: m.id,
    toskarID: m.id,
    name,
    family: m.family || m.id,
    version: m.parameters || '',
    detail: window < agentModeTokens ? `Toskar · ${Math.floor(window / 1024)}K, Ask mode` : 'Toskar',
    tooltip,
    maxInputTokens: window - output,
    maxOutputTokens: output,
    capabilities: { toolCalling: Boolean(m.capabilities?.tool_calling), imageInput: Boolean(m.capabilities?.vision) },
  }
}

/** VS Code's message parts, as the converter reads them. */
export function messageOf(m: vscode.LanguageModelChatRequestMessage): Message {
  const role = m.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : m.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'system'
  const parts: Part[] = []
  for (const p of m.content) {
    if (p instanceof vscode.LanguageModelTextPart) parts.push({ kind: 'text', text: p.value })
    else if (p instanceof vscode.LanguageModelToolCallPart) parts.push({ kind: 'call', callId: p.callId, name: p.name, input: p.input })
    else if (p instanceof vscode.LanguageModelToolResultPart) {
      const text = p.content.map((c) => (c instanceof vscode.LanguageModelTextPart ? c.value : '')).join('')
      parts.push({ kind: 'result', callId: p.callId, text })
    } else if (isImage(p)) {
      parts.push({ kind: 'image', mimeType: p.mimeType, data: p.data })
    }
  }
  return { role, parts }
}

/**
 * A picture part. LanguageModelDataPart came after VS Code 1.104, the
 * oldest this runs on, so it's known by its shape.
 */
function isImage(p: unknown): p is { mimeType: string; data: Uint8Array } {
  const d = p as { mimeType?: unknown; data?: unknown }
  return typeof d?.mimeType === 'string' && d.mimeType.startsWith('image/') && d.data instanceof Uint8Array
}

/**
 * Toskar's installed chat models in Copilot Chat's model picker (#960). A
 * request drives the model directly with Copilot's tools, through Toskar's
 * raw mode; the answer streams back as it's written.
 */
export class ToskarChatProvider implements vscode.LanguageModelChatProvider<ToskarModelInfo> {
  private readonly changed = new vscode.EventEmitter<void>()
  readonly onDidChangeLanguageModelChatInformation = this.changed.event

  /**
   * noRaw runs when Toskar says this editor's key can't drive a model
   * directly, so the person can be offered the fix.
   */
  constructor(
    private readonly connect: () => Promise<Toskar>,
    private readonly noRaw: () => void = () => {},
  ) {}

  /** Lists the models again, after the address or key changes. */
  refresh(): void {
    this.changed.fire()
  }

  async provideLanguageModelChatInformation(options: vscode.PrepareLanguageModelChatModelOptions, token: vscode.CancellationToken): Promise<ToskarModelInfo[]> {
    const toskar = await this.connect()
    try {
      const models = await toskar.chatModels(signalOf(token))
      const where = new URL(toskar.url).hostname
      return models.map((m) => modelInfo(m, where === '127.0.0.1' || where === 'localhost' ? 'this computer' : where))
    } catch (err) {
      if (!options.silent) void vscode.window.showWarningMessage(`Toskar: ${(err as Error).message}`)
      return []
    }
  }

  async provideLanguageModelChatResponse(
    model: ToskarModelInfo,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const toskar = await this.connect()
    const body: Record<string, unknown> = { messages: toChatMessages(messages.map(messageOf)) }
    if (options.tools && options.tools.length > 0) {
      body.tools = toChatTools(options.tools)
      body.tool_choice = options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto'
    }
    let stream: ReadableStream<Uint8Array>
    try {
      stream = await toskar.chat(model.toskarID, body, signalOf(token))
    } catch (err) {
      if (err instanceof ToskarError && err.code === 'RAW_NOT_ALLOWED') this.noRaw()
      throw modelError(err)
    }
    const reader = new StreamReader()
    const decoder = new TextDecoder()
    const emit = (events: ReturnType<StreamReader['push']>) => {
      for (const e of events) {
        if (e.kind === 'text') progress.report(new vscode.LanguageModelTextPart(e.text))
        else progress.report(new vscode.LanguageModelToolCallPart(e.callId, e.name, e.input))
      }
    }
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      if (token.isCancellationRequested) return
      emit(reader.push(decoder.decode(chunk, { stream: true })))
    }
    emit(reader.finish())
  }

  async provideTokenCount(_model: ToskarModelInfo, text: string | vscode.LanguageModelChatRequestMessage): Promise<number> {
    if (typeof text === 'string') return estimateTokens(text)
    const m = messageOf(text)
    return m.parts.reduce((n, p) => n + estimateTokens(p.kind === 'text' || p.kind === 'result' ? p.text : p.kind === 'call' ? JSON.stringify(p.input) : ''), 0)
  }
}

/**
 * err as Copilot Chat takes it. A plain error reads to it as the server
 * failing, so it tries again and reports a 502; a key that
 * isn't allowed, or a model that isn't there, won't be fixed by trying again.
 */
export function modelError(err: unknown): unknown {
  if (!(err instanceof ToskarError)) return err
  if (err.status === 401 || err.status === 403) return vscode.LanguageModelError.NoPermissions(err.message)
  if (err.status === 404) return vscode.LanguageModelError.NotFound(err.message)
  return err
}

/** An abort signal that follows a cancellation token. */
export function signalOf(token: vscode.CancellationToken): AbortSignal {
  const controller = new AbortController()
  if (token.isCancellationRequested) controller.abort()
  else token.onCancellationRequested(() => controller.abort())
  return controller.signal
}
