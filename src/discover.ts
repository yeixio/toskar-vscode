import makeMdns from 'multicast-dns'
import { networkInterfaces } from 'node:os'

/** How Toskar announces itself on the local network, as the phone app finds it (toskar-core internal/discovery). */
const service = '_localai._tcp.local'

/** A Toskar computer on the local network. */
export interface FoundComputer {
  /** Its name, such as Sam's Mac Studio. */
  name: string
  host: string
  /** Where its API answers. */
  port: number
  /** False while it answers only on itself: Connect a device turns its network access on. */
  onNetwork: boolean
}

/** The parts of an mDNS answer this reads. */
export interface Answer {
  name: string
  type: string
  data: unknown
}

/** One of this computer's IPv4 networks. */
export interface LocalNetwork {
  address: string
  netmask: string
}

/**
 * The computers in a set of mDNS answers: each announcement's SRV record
 * names its host, its TXT record its name and API port, and the host's A
 * records its addresses. A computer announces every address it has, such
 * as Docker's and Kubernetes' as well as its own on the network, so the one
 * on a network this computer is on is used. One without an address or an
 * API port is left out.
 */
export function computersFrom(answers: Answer[], local: LocalNetwork[] = []): FoundComputer[] {
  const txt = new Map<string, Record<string, string>>()
  const addresses = new Map<string, string[]>()
  const srv: { instance: string; target: string }[] = []
  for (const a of answers) {
    if (a.type === 'TXT') {
      const fields: Record<string, string> = {}
      const parts = Array.isArray(a.data) ? a.data : [a.data]
      for (const p of parts) {
        const s = Buffer.isBuffer(p) ? p.toString('utf8') : String(p)
        const eq = s.indexOf('=')
        if (eq > 0) fields[s.slice(0, eq)] = s.slice(eq + 1)
      }
      txt.set(a.name, fields)
    } else if (a.type === 'A' && typeof a.data === 'string') {
      const list = addresses.get(a.name) ?? []
      if (!list.includes(a.data)) list.push(a.data)
      addresses.set(a.name, list)
    } else if (a.type === 'SRV' && a.data && typeof a.data === 'object') {
      srv.push({ instance: a.name, target: String((a.data as { target?: string }).target ?? '') })
    }
  }
  const found = new Map<string, FoundComputer>()
  for (const { instance, target } of srv) {
    const fields = txt.get(instance) ?? {}
    const all = addresses.get(target) ?? []
    const host = all.find((a) => local.some((n) => sameNetwork(a, n))) ?? all[0]
    const port = Number(fields.api_port)
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) continue
    const name = fields.name || instance.replace(`.${service}`, '')
    found.set(fields.node_id || `${host}:${port}`, { name, host, port, onNetwork: fields.api_lan !== 'false' })
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Whether address is on network n. */
function sameNetwork(address: string, n: LocalNetwork): boolean {
  const num = (ip: string) => ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0
  const mask = num(n.netmask)
  return mask !== 0 && (num(address) & mask) === (num(n.address) & mask)
}

/** This computer's IPv4 networks, leaving out loopback. */
function localNetworks(): LocalNetwork[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => ({ address: i!.address, netmask: i!.netmask }))
}

/**
 * Asks the local network for Toskar computers, and gives each one found as
 * soon as it answers. Stops after ms, or when the returned function is called.
 */
export function findComputers(onFound: (computers: FoundComputer[]) => void, ms = 3000): () => void {
  let mdns: ReturnType<typeof makeMdns>
  try {
    mdns = makeMdns()
  } catch {
    return () => {}
  }
  const answers: Answer[] = []
  const networks = localNetworks()
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    clearTimeout(timer)
    mdns.destroy()
  }
  mdns.on('response', (response) => {
    answers.push(...([...response.answers, ...(response.additionals ?? [])] as Answer[]))
    onFound(computersFrom(answers, networks))
  })
  mdns.on('error', stop)
  mdns.query({ questions: [{ name: service, type: 'PTR' }] })
  const timer = setTimeout(stop, ms)
  return stop
}
