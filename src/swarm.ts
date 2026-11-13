// Swarms in @toskar (toskar-core#1135): /swarm sends a turn as several
// agents at once, and the lanes follow them from Toskar's events. Nothing
// here imports vscode, so it's tested on its own.

/** A swarm's mode: split the job into parts, or race models on all of it. */
export type SwarmMode = 'split' | 'race'

/** The contract Toskar's swarms came with. */
export const swarmContract = '1.88'

/**
 * What /swarm asks: its mode, when the first word names one, and the rest.
 * Split is Toskar's default, so without a mode none is named but split.
 */
export function swarmRequest(prompt: string): { mode: SwarmMode; prompt: string } {
  const m = /^\s*(race|split)\b[\s:,]*/i.exec(prompt)
  if (!m) return { mode: 'split', prompt: prompt.trim() }
  return { mode: m[1].toLowerCase() as SwarmMode, prompt: prompt.slice(m[0].length).trim() }
}

/** Whether a contract version, such as "1.88", is at least want. */
export function contractAtLeast(have: string, want: string): boolean {
  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)/.exec(v.trim())
    return m ? [Number(m[1]), Number(m[2])] : undefined
  }
  const h = parse(have)
  const w = parse(want)
  if (!h || !w) return false
  return h[0] > w[0] || (h[0] === w[0] && h[1] >= w[1])
}

/** What an older Toskar is told, with where it runs when that's another computer. */
export function updateMessage(have: string, computer: string): string {
  const where = computer ? `Toskar on ${computer}` : 'Toskar on this computer'
  const is = have ? ` (it speaks contract ${have}, and swarms need ${swarmContract})` : ''
  return `Swarms need a newer Toskar. ${where} is older${is}. Update Toskar, then try /swarm again. Without /swarm, @toskar answers as before.`
}

/** A computer Toskar knows, as /api/v1/nodes lists them. */
export interface SwarmNode {
  id: string
  name?: string
  is_local?: boolean
}

/** One agent's lane: its part, where it runs, and how it's going. */
export interface Lane {
  agent: number
  part: string
  nodeID: string
  model: string
  status: string
  summary: string
}

/** Where lanes are shown: the chat response stream, as far as lanes go. */
export interface LaneSink {
  progress(text: string): void
  markdown(text: string): void
}

/** A swarm's record, as GET /api/v1/swarms/{id} returns it; only what's read here. */
export interface SwarmRecord {
  id: string
  mode?: string
  status?: string
  winner?: number
  note?: string
  agents?: { agent: number; part?: string; model_id?: string; node_id?: string; status?: string; summary?: string }[]
}

const maxSummary = 120

/**
 * Follows one coordinator chat's swarm events and shows them: a live line
 * with stream.progress, and a compact line per agent update. Once the answer
 * starts, updates go to the live line only, so none lands inside it.
 */
export class Lanes {
  /** The swarms this chat's turn started, for their agents' approvals. */
  readonly swarmIDs = new Set<string>()
  private lanes = new Map<number, Lane>()
  private nodes = new Map<string, SwarmNode>()
  private mode = ''
  private answering = false
  private shown = false
  private winner = 0
  private status = ''

  constructor(
    private readonly conversationID: string,
    private readonly sink: LaneSink,
  ) {}

  /** The computers Toskar knows, to name where each agent runs. */
  setNodes(nodes: SwarmNode[]): void {
    for (const n of nodes) this.nodes.set(n.id, n)
  }

  /** Whether a swarm.started has come for this chat. */
  get started(): boolean {
    return this.swarmIDs.size > 0
  }

  /** The agents so far, in order. */
  get agents(): Lane[] {
    return [...this.lanes.values()].sort((a, b) => a.agent - b.agent)
  }

  /** Whether an event is this chat's: the coordinator's, or one of its swarm's agents'. */
  owns(p: Record<string, unknown>): boolean {
    if (p.conversation_id === this.conversationID) return true
    return typeof p.swarm_id === 'string' && this.swarmIDs.has(p.swarm_id)
  }

  /** The answer has started: from here on, only the live line changes. */
  answer(): void {
    if (this.answering) return
    this.answering = true
    // A blank line ends the lanes' list, so the answer is its own paragraph.
    if (this.shown) this.sink.markdown('\n')
  }

  /** Shows a swarm event from Toskar's events. Returns false for any other. */
  push(type: string, p: Record<string, unknown>): boolean {
    if (!type.startsWith('swarm.') || p.conversation_id !== this.conversationID) return false
    if (typeof p.swarm_id === 'string' && p.swarm_id) this.swarmIDs.add(p.swarm_id)
    switch (type) {
      case 'swarm.started': {
        this.mode = str(p.mode)
        const agents = Array.isArray(p.agents) ? (p.agents as Record<string, unknown>[]) : []
        for (const a of agents) {
          const n = num(a.agent)
          if (!n) continue
          this.lanes.set(n, { agent: n, part: str(a.part), nodeID: str(a.node_id), model: str(a.model), status: str(a.status) || 'running', summary: '' })
        }
        const head = `Swarm, ${this.mode || 'split'}: ${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}`
        this.sink.progress(head)
        this.line(`**${head}**\n\n`, false)
        for (const lane of this.agents) this.line(`- ${this.label(lane)}: ${lane.status === 'queued' ? 'waiting for a free slot' : 'starting'}\n`)
        return true
      }
      case 'swarm.agent.started': {
        const lane = this.lane(num(p.agent))
        lane.status = 'running'
        if (str(p.node_id)) lane.nodeID = str(p.node_id)
        if (str(p.model)) lane.model = str(p.model)
        this.update(lane, 'started')
        return true
      }
      case 'swarm.agent.progress': {
        const what = str(p.summary) || str(p.tool)
        if (what) this.update(this.lane(num(p.agent)), what)
        return true
      }
      case 'swarm.agent.finished': {
        const lane = this.lane(num(p.agent))
        lane.status = str(p.status) || 'done'
        lane.summary = clip(str(p.summary))
        this.update(lane, statusText(lane.status) + (lane.summary ? `: ${lane.summary}` : ''))
        return true
      }
      case 'swarm.merging': {
        const conflict = p.conflict as { agent?: unknown; branch?: unknown; files?: unknown } | undefined
        if (conflict && typeof conflict === 'object') {
          const files = Array.isArray(conflict.files) ? (conflict.files as unknown[]).map(String).filter(Boolean) : []
          const text = `Conflict: Agent ${num(conflict.agent)}'s change${files.length ? ` to ${files.join(', ')}` : ''} wasn't merged; it's on the branch ${str(conflict.branch)}`
          this.sink.progress(text)
          this.line(`- ${text}\n`)
        } else {
          const agent = num(p.agent)
          const text = agent ? `Merging Agent ${agent}'s change` : this.mode === 'race' ? 'Comparing what the agents found' : 'Merging what the agents found'
          this.sink.progress(text)
          this.line(`- ${text}\n`)
        }
        return true
      }
      case 'swarm.note': {
        const note = str(p.note)
        if (note) {
          this.sink.progress(note)
          this.line(`*${note}*\n\n`, false)
        }
        return true
      }
      case 'swarm.finished':
        this.status = str(p.status)
        this.winner = num(p.winner)
        this.sink.progress(this.status === 'stopped' ? 'Swarm stopped' : this.status === 'failed' ? 'Swarm failed' : 'Swarm finished')
        return true
    }
    return false
  }

  /** Takes the swarm's record, which has the last word on each agent. */
  record(r: SwarmRecord): void {
    if (r.status) this.status = r.status
    if (r.winner) this.winner = r.winner
    for (const a of r.agents ?? []) {
      const lane = this.lane(a.agent)
      if (a.part) lane.part = a.part
      if (a.model_id) lane.model = a.model_id
      if (a.node_id) lane.nodeID = a.node_id
      if (a.status) lane.status = a.status
      if (a.summary) lane.summary = clip(a.summary)
    }
  }

  /**
   * The agents at the end, compact: part, computer, model, and status, and
   * a link to the coordinator chat in Toskar's web app.
   */
  summary(chatLink: string): string {
    const agents = this.agents
    if (!agents.length) return ''
    const rows = agents.map((a) => `| ${a.agent} | ${cell(a.part)} | ${cell(this.computer(a.nodeID))} | ${cell(a.model)} | ${statusText(a.status)}${this.winner === a.agent ? ', won' : ''} |`)
    const out = ['\n\n---\n\n**The swarm\'s agents**\n', '| Agent | Part | Computer | Model | Status |', '| --- | --- | --- | --- | --- |', ...rows]
    if (this.status === 'stopped') out.push('', 'The swarm was stopped.')
    if (chatLink) out.push('', `[Open the swarm in Toskar](${chatLink}): each agent's chat opens from there.`)
    return out.join('\n') + '\n'
  }

  /** "Agent 2 · tests · laptop · qwen3.5-9b", leaving out what isn't known. */
  label(lane: Lane): string {
    return [`Agent ${lane.agent}`, lane.part, this.computer(lane.nodeID), lane.model].filter(Boolean).join(' · ')
  }

  private computer(nodeID: string): string {
    if (!nodeID) return ''
    const n = this.nodes.get(nodeID)
    if (!n) return nodeID
    if (n.is_local) return 'this computer'
    return n.name || nodeID
  }

  private lane(n: number): Lane {
    let lane = this.lanes.get(n)
    if (!lane) {
      lane = { agent: n, part: '', nodeID: '', model: '', status: 'running', summary: '' }
      this.lanes.set(n, lane)
    }
    return lane
  }

  private update(lane: Lane, what: string): void {
    const text = `${this.label(lane)}: ${what}`
    this.sink.progress(text)
    this.line(`- ${text}\n`)
  }

  /** A line of the lanes, unless the answer has started. */
  private line(md: string, item = true): void {
    if (this.answering) return
    // A paragraph after list items needs a blank line first.
    if (!item && this.shown) md = '\n' + md
    this.sink.markdown(md)
    this.shown = true
  }
}

/** An agent's status, said for a person. */
export function statusText(status: string): string {
  switch (status) {
    case 'done':
    case '':
      return 'finished'
    case 'out_of_budget':
      return 'ran out of budget'
    case 'queued':
      return 'waiting'
  }
  return status
}

/** An agent's tool waiting for a yes: "Agent 2" and its part, from tool.requested. */
export function agentOf(p: Record<string, unknown>): { label: string; part: string } | undefined {
  if (typeof p.swarm_id !== 'string' || !p.swarm_id) return undefined
  const n = num(p.agent_number)
  const full = str(p.agent)
  const m = /^Agent (\d+)(?::\s*(.*))?$/.exec(full)
  const label = n ? `Agent ${n}` : m ? `Agent ${m[1]}` : full || 'An agent'
  return { label, part: m?.[2]?.trim() ?? '' }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function clip(s: string): string {
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > maxSummary ? s.slice(0, maxSummary - 1).trimEnd() + '…' : s
}

/** Text for a Markdown table cell. */
function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() || '–'
}
