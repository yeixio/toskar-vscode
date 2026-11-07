import { describe, expect, it } from 'vitest'
import { computersFrom, type Answer } from '../src/discover'

// Answers as Toskar's announcement comes back: the instance's SRV and TXT,
// and its host's address, sometimes in separate responses.
const announce = (instance: string, host: string, address: string, txt: string[]): Answer[] => [
  { name: '_localai._tcp.local', type: 'PTR', data: `${instance}._localai._tcp.local` },
  { name: `${instance}._localai._tcp.local`, type: 'SRV', data: { target: host, port: 7332 } },
  { name: `${instance}._localai._tcp.local`, type: 'TXT', data: txt.map((t) => Buffer.from(t)) },
  { name: host, type: 'A', data: address },
]

describe('Toskar computers on the network', () => {
  it('names each with its address and API port, and says which answer only on themselves', () => {
    const found = computersFrom([
      ...announce('studio', 'studio.local', '192.168.1.20', ['node_id=n1', "name=Sam's Mac Studio", 'api_port=7331', 'api_lan=true']),
      ...announce('rig', 'rig.local', '192.168.1.30', ['node_id=n2', 'name=linux-rig', 'api_port=7331', 'api_lan=false']),
    ])
    expect(found).toEqual([
      { name: 'linux-rig', host: '192.168.1.30', port: 7331, onNetwork: false },
      { name: "Sam's Mac Studio", host: '192.168.1.20', port: 7331, onNetwork: true },
    ])
  })

  it('leaves out one with no address or API port, and lists one heard twice once', () => {
    const twice = announce('studio', 'studio.local', '192.168.1.20', ['node_id=n1', 'name=Studio', 'api_port=7331'])
    const found = computersFrom([
      ...twice,
      ...twice,
      ...announce('old', 'old.local', '192.168.1.40', ['node_id=n3', 'name=Old']),
      { name: 'lost._localai._tcp.local', type: 'SRV', data: { target: 'lost.local', port: 7332 } },
    ])
    expect(found.map((c) => c.name)).toEqual(['Studio'])
  })
})

describe('Which address', () => {
  it("is the one on this computer's network, not Docker's or Kubernetes'", () => {
    const rig = announce('rig', 'rig.local', '10.42.1.1', ['node_id=n1', 'name=linux-rig', 'api_port=7331'])
    const more: Answer[] = ['172.17.0.1', '192.168.122.1', '192.168.68.51', '10.42.1.0'].map((data) => ({ name: 'rig.local', type: 'A', data }))
    const here = [{ address: '192.168.68.64', netmask: '255.255.252.0' }]
    expect(computersFrom([...rig, ...more], here)[0].host).toBe('192.168.68.51')
    // With no network in common, the first it gave.
    expect(computersFrom([...rig, ...more], [{ address: '10.0.0.5', netmask: '255.255.255.0' }])[0].host).toBe('10.42.1.1')
  })
})
