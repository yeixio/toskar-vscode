import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as netServer, type AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runTests } from '@vscode/test-electron'

/**
 * The extension in a real VS Code, against a real Toskar Core whose
 * llama-server is scripted (llama-server.js), so no model or runtime is
 * downloaded and the answers are always the same. TOSKAR_CORE is the daemon to
 * run. VS Code is kept outside the checkout, so a home runner downloads it
 * once: only changing this version downloads it again.
 */
const vscodeVersion = '1.145.0'
const cache = process.env.VSCODE_TEST_CACHE || join(homedir(), '.cache', 'toskar-vscode-test')

/** A tiny GGUF, enough for Toskar to import. llama-server here never reads it. */
function tinyGGUF(): Buffer {
  const u32 = (v: number) => {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(v)
    return b
  }
  const u64 = (v: number) => {
    const b = Buffer.alloc(8)
    b.writeBigUInt64LE(BigInt(v))
    return b
  }
  const str = (s: string) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)])
  const typeString = 8
  const typeUint32 = 4
  const head = Buffer.concat([
    Buffer.from('GGUF'),
    u32(3),
    u64(1), // one tensor
    u64(3), // three values
    str('general.architecture'), u32(typeString), str('llama'),
    str('general.name'), u32(typeString), str('Scripted'),
    str('llama.context_length'), u32(typeUint32), u32(32768),
    str('token_embd.weight'), u32(1), u64(64), u32(0), u64(0),
  ])
  return Buffer.concat([head, Buffer.alloc((32 - (head.length % 32)) % 32), Buffer.alloc(64 * 4)])
}

function freePort(): Promise<number> {
  return new Promise((done) => {
    const s = netServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo
      s.close(() => done(port))
    })
  })
}

async function api(url: string, method: string, path: string, body?: unknown): Promise<any> {
  const resp = await fetch(url + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!resp.ok) throw new Error(`${method} ${path}: ${resp.status} ${await resp.text()}`)
  const text = await resp.text()
  return text ? JSON.parse(text) : null
}

async function startCore(binary: string, work: string): Promise<{ url: string; proc: ChildProcess; log: string }> {
  const port = await freePort()
  const log = join(work, 'core.log')
  const out = openSync(log, 'w')
  const proc = spawn(binary, ['-data-dir', join(work, 'core')], {
    // Its own ports too, so a Toskar already on this computer isn't disturbed.
    env: { ...process.env, TOSKAR_API_PORT: String(port), TOSKAR_INTERNAL_PORT: String(await freePort()), TOSKAR_DISCOVERY_ENABLED: 'false' },
    stdio: ['ignore', out, out],
  })
  const url = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      await api(url, 'GET', '/api/v1/health')
      return { url, proc, log }
    } catch {
      if (proc.exitCode !== null) break
      await new Promise((r) => setTimeout(r, 300))
    }
  }
  proc.kill()
  throw new Error(`Core didn't start: ${readFileSync(log, 'utf8').slice(-4000)}`)
}

async function main(): Promise<void> {
  const binary = process.env.TOSKAR_CORE
  if (!binary) throw new Error('set TOSKAR_CORE to the Toskar daemon to run')
  const work = mkdtempSync(join(tmpdir(), 'toskar-vscode-e2e-'))
  // Where Core looks for the llama.cpp it runs.
  const runtime = join(work, 'core', 'runtimes', 'llamacpp')
  mkdirSync(runtime, { recursive: true })
  const server = join(runtime, 'llama-server')
  copyFileSync(join(__dirname, 'llama-server.js'), server)
  chmodSync(server, 0o755)
  const core = await startCore(binary, work)
  try {
    const file = join(work, 'scripted.gguf')
    writeFileSync(file, tinyGGUF())
    const { model } = await api(core.url, 'POST', '/api/v1/models/import', { path: file, id: 'scripted', display_name: 'Scripted' })
    const profile = await api(core.url, 'GET', '/api/v1/profiles/general-assistant')
    for (const role of profile.roles) role.model_id = model?.id ?? 'scripted'
    await api(core.url, 'PATCH', '/api/v1/profiles/general-assistant', profile)

    const userData = join(work, 'user-data')
    mkdirSync(join(userData, 'User'), { recursive: true })
    writeFileSync(join(userData, 'User', 'settings.json'), JSON.stringify({ 'toskar.url': core.url, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none' }))
    const folder = join(work, 'project')
    mkdirSync(folder)
    writeFileSync(join(folder, 'hello.py'), 'print("hello")\n')

    const root = resolve(__dirname, '..', '..')
    await runTests({
      version: vscodeVersion,
      cachePath: cache,
      extensionDevelopmentPath: root,
      extensionTestsPath: join(root, 'out', 'test', 'suite.js'),
      extensionTestsEnv: { TOSKAR_E2E_CORE: core.url },
      launchArgs: [folder, '--user-data-dir', userData, '--disable-extensions', '--disable-workspace-trust', '--no-sandbox'],
    })
  } catch (err) {
    console.error(`Core's log:\n${readFileSync(core.log, 'utf8').slice(-3000)}`)
    throw err
  } finally {
    core.proc.kill()
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
