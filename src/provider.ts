import * as vscode from 'vscode'
import { estimateTokens, StreamReader, toChatMessages, toChatTools, type Message, type Part } from './convert'
import type { Toskar, ToskarModel } from './toskar'

/** The most of a model's window kept for its answer. */
const answerTokens = 4096

/** A Toskar model, as Copilot Chat's model picker lists it. */
export interface ToskarModelInfo extends vscode.LanguageModelChatInformation {
  readonly toskarID: string
}

export function modelInfo(m: ToskarModel, where: string): ToskarModelInfo {
  const window = m.context_window || 8192
  const output = Math.min(answerTokens, Math.floor(window / 4))
  return {
    id: m.id,
    toskarID: m.id,
    name: m.display_name || m.id,
    family: m.family || m.id,
    version: m.parameters || '',
    detail: 'Toskar',
    tooltip: `${m.display_name || m.id} on ${where}: ${window.toLocaleString()} tokens of context, run by Toskar.`,
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

  constructor(private readonly connect: () => Promise<Toskar>) {}

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
    const stream = await toskar.chat(model.toskarID, body, signalOf(token))
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

/** An abort signal that follows a cancellation token. */
export function signalOf(token: vscode.CancellationToken): AbortSignal {
  const controller = new AbortController()
  if (token.isCancellationRequested) controller.abort()
  else token.onCancellationRequested(() => controller.abort())
  return controller.signal
}
