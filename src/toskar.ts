// Talking to Toskar: its models, the one running, a raw chat
// (toskar-core#843), and its assistant's chats, which @toskar uses.
// Nothing here imports vscode.

import { fetch as pinnedFetch, type Dispatcher } from 'undici'
import { pinnedAgent, type Pin } from './pin'
import type { SwarmMode, SwarmNode, SwarmRecord } from './swarm'

/** A model as Toskar's /api/v1/models lists it; only what's read here. */
export interface ToskarModel {
  id: string
  display_name?: string
  family?: string
  parameters?: string
  installed?: boolean
  support_role?: string
  context_window?: number
  capabilities?: { tool_calling?: boolean; vision?: boolean }
}

/** A model running on Toskar, as /api/v1/models/running lists it. */
export interface RunningModel {
  model_id: string
  display_name?: string
  node_name?: string
  acceleration?: { state?: string; backend?: string }
}

/** What reaching Toskar failed with, said for a person. */
export class ToskarError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message)
  }
}

export class Toskar {
  private readonly agent?: Dispatcher

  /** pin is Toskar's certificate, when it was connected to over HTTPS. */
  constructor(
    readonly url: string,
    private readonly key: string | undefined,
    pin?: Pin,
  ) {
    if (pin) this.agent = pinnedAgent(pin)
  }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {}
    if (this.key) h.Authorization = `Bearer ${this.key}`
    if (json) h['Content-Type'] = 'application/json'
    return h
  }

  private async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const resp = await this.fetch(path, { headers: this.headers(), signal })
    return (await resp.json()) as T
  }

  private async fetch(path: string, init: RequestInit): Promise<Response> {
    let resp: Response
    const url = this.url.replace(/\/+$/, '') + path
    try {
      resp = this.agent ? ((await pinnedFetch(url, { ...(init as object), dispatcher: this.agent })) as unknown as Response) : await fetch(url, init)
    } catch (err) {
      if (init.signal?.aborted) throw err
      // Pinned, any certificate but Toskar's fails here: one another
      // authority vouches for, or none does.
      const cause = (err as { cause?: { code?: string; message?: string } }).cause
      if (this.agent && (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(cause?.code ?? '') || cause?.message?.includes('certificate changed'))) {
        throw new ToskarError("Toskar's certificate isn't the one this editor connected with. If Toskar was set up again on that computer, connect again with Toskar: Connect to Another Computer.")
      }
      throw new ToskarError(`Toskar isn't answering at ${this.url}. Start Toskar, or set where it runs with Toskar: Manage.`)
    }
    if (!resp.ok) throw new ToskarError(await explain(resp), resp.status)
    return resp
  }

  /**
   * The chat models installed on the computer Toskar runs on. A model on a
   * server Toskar connects to (ext:) is listed as installed, but raw mode
   * can't drive it.
   */
  async chatModels(signal?: AbortSignal): Promise<ToskarModel[]> {
    const all = await this.get<ToskarModel[]>('/api/v1/models', signal)
    return all.filter((m) => m.installed && !m.support_role && !m.id.startsWith('ext:'))
  }

  async running(signal?: AbortSignal): Promise<RunningModel[]> {
    return this.get<RunningModel[]>('/api/v1/models/running', signal)
  }

  /** Streams a raw chat with modelID: its own tools, no assistant. */
  async chat(modelID: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const resp = await this.fetch('/v1/chat/completions', {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({ ...body, model: `raw:${modelID}`, stream: true }),
      signal,
    })
    if (!resp.body) throw new ToskarError('Toskar answered without a stream')
    return resp.body
  }

  /** Posts body as JSON. */
  post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    return this.fetch(path, { method: 'POST', headers: this.headers(true), body: JSON.stringify(body), signal })
  }

  /** A new chat, which the apps list in History as well. */
  async createConversation(title: string, profile?: string, model?: string, signal?: AbortSignal): Promise<Conversation> {
    const body: Record<string, string> = { title }
    if (profile) body.profile_id = profile
    if (model) body.model_id = model
    const resp = await this.post('/api/v1/conversations', body, signal)
    return (await resp.json()) as Conversation
  }

  /** Streams Toskar's answer to a message in a chat, as server-sent events. */
  async ask(o: AskOptions, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const body: Record<string, unknown> = { conversation_id: o.conversationID, message: o.message, stream: true, client: 'editor' }
    if (o.model) body.model_id = o.model
    if (o.profile) body.profile_id = o.profile
    if (o.swarm) body.swarm = o.swarm
    const resp = await this.post('/api/v1/chat', body, signal)
    if (!resp.body) throw new ToskarError('Toskar answered without a stream')
    return resp.body
  }

  /**
   * Stops a chat's running turn, as Stop in the apps does. On a swarm's
   * coordinator chat, it stops every agent too.
   */
  async stop(conversationID: string): Promise<void> {
    await this.post('/api/v1/chat/stop', { conversation_id: conversationID })
  }

  /**
   * The client contract Toskar speaks, such as "1.88", from /api/v1/version,
   * or the header every answer carries. Empty when it doesn't say.
   */
  async contract(signal?: AbortSignal): Promise<string> {
    const resp = await this.fetch('/api/v1/version', { headers: this.headers(), signal })
    const header = resp.headers.get('Toskar-Contract') ?? resp.headers.get('Yggdrasil-Contract') ?? ''
    try {
      const body = (await resp.json()) as { contract?: { version?: string } }
      return body.contract?.version || header
    } catch {
      return header
    }
  }

  /** A swarm's record: its agents, how each went, and the winner of a race. */
  async swarm(id: string, signal?: AbortSignal): Promise<SwarmRecord> {
    return this.get<SwarmRecord>(`/api/v1/swarms/${encodeURIComponent(id)}`, signal)
  }

  /** The computers Toskar knows, to name where a swarm's agents run. */
  async nodes(signal?: AbortSignal): Promise<SwarmNode[]> {
    return this.get<SwarmNode[]>('/api/v1/nodes', signal)
  }

  /** Toskar's events as they happen, such as a tool waiting for a yes. */
  async events(signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const resp = await this.fetch('/api/v1/events', { headers: this.headers(), signal })
    if (!resp.body) throw new ToskarError('Toskar answered without a stream')
    return resp.body
  }

  /**
   * Answers a tool waiting for a yes, as the apps' approval card does;
   * forChat lets it run for the rest of the chat without asking.
   */
  async decide(requestID: string, allow: boolean, forChat = false): Promise<void> {
    await this.post('/api/v1/tools/decide', { request_id: requestID, allow, allow_session: forChat })
  }
}

/** A key from connecting, as POST /api/v1/devices/pair answers. */
export interface Paired {
  api_key: string
  key: { id: string; name: string; permissions?: { raw?: boolean } }
  tls_fingerprint?: string
  tls_short?: string
}

/**
 * Connects this editor like a device, with the code Toskar's Connect a
 * device shows, asking for raw access for the model picker
 * (toskar-core#960). url is https:// with pin, the certificate read first.
 */
export async function pair(url: string, pin: Pin | undefined, code: string, deviceName: string): Promise<Paired> {
  const toskar = new Toskar(url, undefined, pin)
  const resp = await toskar.post('/api/v1/devices/pair', { code, device_name: deviceName, raw: true })
  const paired = (await resp.json()) as Paired
  // The answer names the certificate too; it must be the one pinned.
  if (pin && paired.tls_fingerprint && paired.tls_fingerprint !== pin.fingerprint) {
    throw new ToskarError("Toskar's certificate isn't the one it says it has. Connect on your own network, and check the code on Toskar.")
  }
  return paired
}

/** What @toskar sends with a message: who answers it. */
export interface AskOptions {
  conversationID: string
  message: string
  model?: string
  profile?: string
  /** Runs the turn as a swarm (contract 1.88). */
  swarm?: SwarmMode
}

export interface Conversation {
  id: string
  title?: string
}

/** A Toskar event, as /api/v1/events streams them. */
export interface ToskarEvent {
  type: string
  payload?: Record<string, unknown>
}

/** An error answer, said for a person: Toskar's message, with what to do. */
async function explain(resp: Response): Promise<string> {
  let message = `Toskar answered ${resp.status}`
  let code = ''
  try {
    const body = (await resp.json()) as { error?: { message?: string; code?: string } }
    message = body.error?.message || message
    code = body.error?.code || ''
  } catch {
    // Not JSON: the status says enough.
  }
  if (code === 'RAW_NOT_ALLOWED') {
    return `${message}. For the model picker, connect again with Toskar: Connect to Another Computer, using a code an Admin or the Owner shows. With an API key, turn on "Drive models directly, for coding agents" for it in API Access.`
  }
  // Connecting's own errors say what to do.
  if (code.startsWith('PAIRING_')) return message.charAt(0).toUpperCase() + message.slice(1) + '.'

  if (resp.status === 401) return `${message}. Connect with the code from Toskar's Connect a device: run Toskar: Connect to Another Computer.`
  return message
}
