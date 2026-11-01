import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hostPort, readCertificate, shortOf } from '../src/pin'
import { pair, Toskar } from '../src/toskar'

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8')

// Toskar over HTTPS with its own certificate, which no authority vouches
// for, and another server with a different one.
function serve(cert: string, key: string, onBody: (url: string, body: Record<string, unknown>) => unknown): Promise<{ server: Server; port: number }> {
  const server = createServer({ cert: fixture(cert), key: fixture(key) }, async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    res.setHeader('Content-Type', 'application/json')
    const out = onBody(req.url ?? '', raw ? JSON.parse(raw) : {})
    res.statusCode = (out as { status?: number }).status ?? 200
    res.end(JSON.stringify(out))
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port })))
}

let toskar: { server: Server; port: number }
let other: { server: Server; port: number }
let lastPair: Record<string, unknown> = {}
let answerFingerprint = ''

beforeAll(async () => {
  toskar = await serve('toskar-test.crt', 'toskar-test.key', (url, body) => {
    if (url === '/api/v1/devices/pair') {
      lastPair = body
      if (body.code !== '123456') return { status: 401, error: { code: 'PAIRING_WRONG_CODE', message: "that code isn't the one this computer shows" } }
      return { api_key: 'ygg_editor', key: { id: 'k1', name: String(body.device_name), permissions: { raw: true } }, tls_fingerprint: answerFingerprint }
    }
    return [{ model_id: 'qwen2.5-7b-q4' }]
  })
  other = await serve('other.crt', 'other.key', () => [])
})

afterAll(() => {
  toskar.server.close()
  other.server.close()
})

describe('pinning', () => {
  it("reads Toskar's certificate, and trusts only it from then on", async () => {
    const pin = await readCertificate('127.0.0.1', toskar.port)
    expect(pin.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(pin.pem).toContain('BEGIN CERTIFICATE')
    // Self-signed, so a plain request refuses it, and a pinned one doesn't.
    await expect(new Toskar(`https://127.0.0.1:${toskar.port}`, undefined).running()).rejects.toThrow("isn't answering")
    expect(await new Toskar(`https://127.0.0.1:${toskar.port}`, undefined, pin).running()).toEqual([{ model_id: 'qwen2.5-7b-q4' }])
    // Another certificate at another address is refused, whatever it's for.
    await expect(new Toskar(`https://127.0.0.1:${other.port}`, 'ygg_editor', pin).running()).rejects.toThrow("Toskar's certificate isn't the one")
  })

  it('connects with the code, asking for raw access, and checks the certificate Toskar names', async () => {
    const pin = await readCertificate('127.0.0.1', toskar.port)
    const base = `https://127.0.0.1:${toskar.port}`
    answerFingerprint = pin.fingerprint
    const paired = await pair(base, pin, '123456', 'Visual Studio Code on rig')
    expect(paired.api_key).toBe('ygg_editor')
    expect(lastPair).toEqual({ code: '123456', device_name: 'Visual Studio Code on rig', raw: true })
    await expect(pair(base, pin, '000000', 'x')).rejects.toThrow("That code isn't the one this computer shows.")
    answerFingerprint = 'sha256:' + '0'.repeat(64)
    await expect(pair(base, pin, '123456', 'x')).rejects.toThrow("isn't the one it says it has")
  })
})

describe('addresses and fingerprints', () => {
  it('reads an address as typed', () => {
    expect(hostPort('192.168.1.20:7331')).toEqual({ host: '192.168.1.20', port: 7331 })
    expect(hostPort(' https://rig.local:8443/models ')).toEqual({ host: 'rig.local', port: 8443 })
    expect(hostPort('rig.local')).toEqual({ host: 'rig.local', port: 7331 })
    expect(hostPort('[fe80::1]:7331')).toEqual({ host: 'fe80::1', port: 7331 })
    expect(hostPort('rig.local:99999')).toBeUndefined()
    expect(hostPort('')).toBeUndefined()
  })
  it('shortens a fingerprint as Toskar shows it', () => {
    expect(shortOf('sha256:4f2a9c1bdeadbeef')).toBe('4F2A-9C1B')
  })
})
