// Talking to Toskar: its models, the one running, and a raw chat
// (toskar-core#843). Nothing here imports vscode.

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
  constructor(
    readonly url: string,
    private readonly key: string | undefined,
  ) {}

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
    try {
      resp = await fetch(this.url.replace(/\/+$/, '') + path, init)
    } catch (err) {
      if (init.signal?.aborted) throw err
      throw new ToskarError(`Toskar isn't answering at ${this.url}. Start Toskar, or set where it runs with Toskar: Manage.`)
    }
    if (!resp.ok) throw new ToskarError(await explain(resp), resp.status)
    return resp
  }

  /** The chat models installed on the computer Toskar runs on. */
  async chatModels(signal?: AbortSignal): Promise<ToskarModel[]> {
    const all = await this.get<ToskarModel[]>('/api/v1/models', signal)
    return all.filter((m) => m.installed && !m.support_role)
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
    return `${message}. In Toskar, open API Access, turn on "Drive models directly, for coding agents" for your key, and set it here with Toskar: Set API Key.`
  }
  if (resp.status === 401) return `${message}. Set your Toskar API key with Toskar: Set API Key.`
  return message
}
