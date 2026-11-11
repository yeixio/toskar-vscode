// Toskar's certificate, pinned (toskar-core#213): Toskar makes its own, so
// no authority vouches for it. Connecting reads it once, the person compares
// its start with what Toskar shows, and from then on only that certificate
// is trusted for that address. Nothing here imports vscode.

import { createHash, X509Certificate } from 'node:crypto'
import { connect, type TLSSocket } from 'node:tls'
import { Agent, buildConnector } from 'undici'

/** A pinned certificate: its PEM, and its SHA-256 as Toskar writes it. */
export interface Pin {
  pem: string
  fingerprint: string
}

/** sha256:<hex> of a certificate's DER bytes, as Toskar's tls_fingerprint. */
export function fingerprintOf(der: Buffer): string {
  return 'sha256:' + createHash('sha256').update(der).digest('hex')
}

/** The start of a fingerprint, such as 4F2A-9C1B, as Toskar shows it. */
export function shortOf(fingerprint: string): string {
  const h = fingerprint.replace(/^sha256:/, '').toUpperCase()
  return h.length < 8 ? h : `${h.slice(0, 4)}-${h.slice(4, 8)}`
}

/**
 * Reads the certificate Toskar at host:port answers with, without trusting
 * it yet: the person compares its start with what Toskar shows.
 */
export function readCertificate(host: string, port: number, timeoutMs = 10_000): Promise<Pin> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, rejectUnauthorized: false, servername: isIP(host) ? undefined : host })
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('timed out')))
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate(false)
      socket.end()
      if (!cert?.raw) return reject(new Error('no certificate'))
      resolve({ pem: new X509Certificate(cert.raw).toString(), fingerprint: fingerprintOf(cert.raw) })
    })
    socket.once('error', reject)
  })
}

function isIP(host: string): boolean {
  return /^[\d.]+$/.test(host) || host.includes(':')
}

/**
 * Connections that trust only the pinned certificate, whatever name or
 * address it's reached by: Toskar's names its computer and its addresses
 * when it was made, which may since have changed. The certificate is
 * compared byte for byte before a request goes out, not checked as an
 * authority: VS Code's TLS library won't take Toskar's, which isn't one,
 * as its own root, and refused every connection.
 */
export function pinnedAgent(pin: Pin): Agent {
  const base = buildConnector({ rejectUnauthorized: false })
  return new Agent({
    connect: (options, callback) =>
      base(options, (err, socket) => {
        if (err) return callback(err, null)
        const cert = (socket as TLSSocket).getPeerCertificate?.(false)
        if (cert?.raw && fingerprintOf(cert.raw) === pin.fingerprint) return callback(null, socket)
        socket.destroy()
        callback(Object.assign(new Error("Toskar's certificate changed"), { code: 'ERR_TLS_CERT_PINNED' }), null)
      }),
  })
}

/** host and port from an address someone typed, with or without https://. */
export function hostPort(text: string): { host: string; port: number } | undefined {
  const t = text.trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '')
  if (!t) return undefined
  const m = /^(\[[^\]]+\]|[^:\s]+)(?::(\d{1,5}))?$/.exec(t)
  if (!m) return undefined
  const port = m[2] ? Number(m[2]) : 7331
  if (port < 1 || port > 65535) return undefined
  return { host: m[1].replace(/^\[|\]$/g, ''), port }
}
