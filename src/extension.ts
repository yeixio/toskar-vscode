import { hostname } from 'node:os'
import * as vscode from 'vscode'
import { dataOf, titleOf, withData } from './ask'
import { handler, lastSpeed, participantID, pick } from './participant'
import { findComputers, type FoundComputer } from './discover'
import { ToskarChatProvider } from './provider'
import { hostPort, readCertificate, shortOf, type Pin } from './pin'
import { pair, Toskar } from './toskar'

const keySecret = 'toskar.apiKey'
/** Set once the offer to connect to another computer has been shown. */
const offeredState = 'toskar.offeredConnect'
/** Certificates pinned when connecting, by Toskar's address. */
const pinsState = 'toskar.pins'

export function activate(context: vscode.ExtensionContext): void {
  const connect = async () => new Toskar(url(), await context.secrets.get(keySecret), pinFor(context, url()))
  const provider = new ToskarChatProvider(connect)
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90)
  status.command = 'toskar.openModels'

  const refresh = () => {
    provider.refresh()
    void showRunning(status, connect, speed)
  }

  // @toskar, where the editor has Copilot Chat's chat view.
  if (hasChat()) {
    const participant = vscode.chat.createChatParticipant(participantID, handler(connect))
    participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'images', 'icon.png')
    context.subscriptions.push(participant)
  }
  let speed = 0
  context.subscriptions.push(
    lastSpeed.event((n) => {
      speed = n
      void showRunning(status, connect, speed)
    }),
  )

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider('toskar', provider),
    vscode.commands.registerCommand('toskar.askAboutThis', () => askAboutThis(connect)),
    vscode.commands.registerCommand('toskar.connect', () => connectComputer(context, refresh)),
    status,
    vscode.commands.registerCommand('toskar.manage', () => manage(context, refresh)),
    vscode.commands.registerCommand('toskar.setApiKey', () => setKey(context, refresh)),
    vscode.commands.registerCommand('toskar.refresh', refresh),
    vscode.commands.registerCommand('toskar.openModels', () => vscode.env.openExternal(vscode.Uri.parse(url().replace(/\/+$/, '') + '/models'))),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('toskar')) refresh()
    }),
  )

  // The status bar follows which model Toskar has loaded.
  void showRunning(status, connect, speed).then((answers) => {
    if (answers === false) void offerConnect(context, refresh)
  })
  const timer = setInterval(() => void showRunning(status, connect, speed), 30_000)
  context.subscriptions.push({ dispose: () => clearInterval(timer) })
}

export function deactivate(): void {}

/** Whether this editor has a chat that extensions can add to. */
function hasChat(): boolean {
  return typeof (vscode as { chat?: { createChatParticipant?: unknown } }).chat?.createChatParticipant === 'function'
}

function url(): string {
  return vscode.workspace.getConfiguration('toskar').get<string>('url') || 'http://127.0.0.1:7331'
}

/**
 * The status bar: the model Toskar has loaded, on which computer, and how
 * fast @toskar's last answer came.
 */
async function showRunning(status: vscode.StatusBarItem, connect: () => Promise<Toskar>, speed: number): Promise<boolean | undefined> {
  if (!vscode.workspace.getConfiguration('toskar').get<boolean>('statusBar', true)) {
    status.hide()
    return undefined
  }
  try {
    const running = await (await connect()).running()
    const first = running[0]
    status.text = first ? `$(sparkle) ${first.display_name || first.model_id}` : '$(sparkle) Toskar'
    const fast = speed ? ` The last answer came at ${Math.round(speed)} tokens a second.` : ''
    status.tooltip = first
      ? `Toskar has ${running.map((m) => m.display_name || m.model_id).join(', ')} loaded${first.node_name ? ` on ${first.node_name}` : ''}.${fast} Open Toskar's models.`
      : `Toskar is running, with no model loaded.${fast} Open Toskar's models.`
    status.command = 'toskar.openModels'
  } catch {
    // Nothing answers: the status bar is the way to connect, not a page that won't open.
    status.text = '$(sparkle) Toskar: connect'
    status.tooltip = `Toskar isn't answering at ${url()}. Connect to Toskar on another computer, or change where it runs.`
    status.command = 'toskar.manage'
    status.show()
    return false
  }
  status.show()
  return true
}

/**
 * The first time no Toskar answers here, says so once and offers to connect
 * to one on the network: the way to was only in the Command Palette.
 */
async function offerConnect(context: vscode.ExtensionContext, refresh: () => void): Promise<void> {
  // Not when someone chose where Toskar runs: the setting's own default doesn't count.
  const chosen = vscode.workspace.getConfiguration('toskar').inspect<string>('url')
  if (context.globalState.get<boolean>(offeredState) || chosen?.globalValue || chosen?.workspaceValue || chosen?.workspaceFolderValue) return
  await context.globalState.update(offeredState, true)
  const connectLabel = 'Connect to Another Computer'
  const choice = await vscode.window.showInformationMessage(
    "Toskar isn't running on this computer. Connect to Toskar on another computer on your network, or install Toskar here.",
    connectLabel,
    'Install Toskar',
  )
  if (choice === connectLabel) await connectComputer(context, refresh)
  else if (choice === 'Install Toskar') await vscode.env.openExternal(vscode.Uri.parse('https://toskar.ai/download'))
}

/**
 * Ask Toskar about this: the selection, or the file, goes with the next
 * @toskar message. Without a chat view, as in editors that don't have
 * Copilot Chat's, the question goes to a Toskar chat that opens in Toskar.
 */
async function askAboutThis(connect: () => Promise<Toskar>): Promise<void> {
  const snippet = pick(vscode.window.activeTextEditor)
  if (hasChat()) {
    try {
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: '@toskar ', isPartialQuery: true })
      return
    } catch {
      // No chat view: ask in Toskar instead.
    }
  }
  const question = await vscode.window.showInputBox({ title: 'Ask Toskar', prompt: snippet ? `About ${snippet.label}` : 'Your question' })
  if (!question) return
  const toskar = await connect()
  const settings = vscode.workspace.getConfiguration('toskar')
  const model = settings.get<string>('chatModel') || undefined
  const profile = settings.get<string>('profile') || undefined
  try {
    const { id } = await toskar.createConversation(titleOf(question), profile, model)
    const message = withData(question, dataOf(snippet ? [snippet] : []).data)
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Toskar is answering…' }, async () => {
      const body = await toskar.ask({ conversationID: id, message, model, profile })
      for await (const _ of body as unknown as AsyncIterable<Uint8Array>) {
        // The answer is saved in the chat, which opens next.
      }
    })
    pick(undefined)
    await vscode.env.openExternal(vscode.Uri.parse(`${toskar.url.replace(/\/+$/, '')}/chat?c=${encodeURIComponent(id)}`))
  } catch (err) {
    void vscode.window.showWarningMessage(`Toskar: ${(err as Error).message}`)
  }
}

async function manage(context: vscode.ExtensionContext, refresh: () => void): Promise<void> {
  const keyed = Boolean(await context.secrets.get(keySecret))
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'Connect to Toskar on another computer', description: 'with the code from Connect a device', id: 'connect' },
      { label: 'Where Toskar runs', description: url(), id: 'url' },
      ...(keyed ? [{ label: 'Disconnect', description: 'forget the key for this computer, and use Toskar on this one', id: 'disconnect' }] : []),
      { label: "Open Toskar's models", id: 'models' },
    ],
    { title: 'Toskar' },
  )
  if (pick?.id === 'connect') {
    await connectComputer(context, refresh)
  } else if (pick?.id === 'url') {
    const next = await vscode.window.showInputBox({ title: 'Where Toskar runs', value: url(), prompt: 'Its address, such as http://127.0.0.1:7331 for this computer' })
    if (next) await vscode.workspace.getConfiguration('toskar').update('url', next, vscode.ConfigurationTarget.Global)
  } else if (pick?.id === 'disconnect') {
    await disconnect(context, refresh)
  } else if (pick?.id === 'models') {
    await vscode.commands.executeCommand('toskar.openModels')
  }
}

/**
 * Forgets the key and the certificate for the computer this editor
 * connected to, and goes back to Toskar on this computer. The computer
 * still lists the key under Devices until it's disconnected there.
 */
async function disconnect(context: vscode.ExtensionContext, refresh: () => void): Promise<void> {
  const pins = { ...context.globalState.get<Record<string, Pin>>(pinsState, {}) }
  delete pins[origin(url())]
  await context.globalState.update(pinsState, pins)
  await context.secrets.delete(keySecret)
  await vscode.workspace.getConfiguration('toskar').update('url', undefined, vscode.ConfigurationTarget.Global)
  refresh()
  void vscode.window.showInformationMessage("Disconnected. To remove this editor's key from that computer too, disconnect it under Devices in Toskar.")
}

function pinFor(context: vscode.ExtensionContext, address: string): Pin | undefined {
  if (!address.startsWith('https:')) return undefined
  return context.globalState.get<Record<string, Pin>>(pinsState, {})[origin(address)]
}

function origin(address: string): string {
  try {
    return new URL(address).origin
  } catch {
    return address
  }
}

/**
 * Connects to Toskar on another computer like a device (toskar-core#960):
 * its address and the code from Connect a device, with its certificate
 * pinned. An Admin's code gives the key raw access, for the model picker.
 */
async function connectComputer(context: vscode.ExtensionContext, refresh: () => void): Promise<void> {
  const title = 'Connect to Toskar on another computer'
  const where = await chooseComputer(title)
  if (!where) return
  let pin: Pin
  try {
    pin = await readCertificate(where.host, where.port)
  } catch {
    void vscode.window.showWarningMessage(`Toskar isn't answering at ${where.host}:${where.port}. On that computer, open Computers and choose Connect a device, then try again.`)
    return
  }
  const code = await vscode.window.showInputBox({
    title,
    prompt: `Enter the 6-digit code Connect a device shows${where.name ? ` on ${where.name}` : ''}. Check that its encryption check code starts ${shortOf(pin.fingerprint)}.`,
    ignoreFocusOut: true,
    validateInput: (v) => (/^\d{6}$/.test(v.replace(/\s/g, '')) ? undefined : 'The 6 digits Toskar shows'),
  })
  if (!code) return
  const base = `https://${where.host.includes(':') ? `[${where.host}]` : where.host}:${where.port}`
  try {
    const paired = await pair(base, pin, code.replace(/\s/g, ''), `${vscode.env.appName} on ${hostname()}`.slice(0, 60))
    await context.secrets.store(keySecret, paired.api_key)
    await context.globalState.update(pinsState, { ...context.globalState.get<Record<string, Pin>>(pinsState, {}), [origin(base)]: pin })
    await vscode.workspace.getConfiguration('toskar').update('url', base, vscode.ConfigurationTarget.Global)
    refresh()
    void vscode.window.showInformationMessage(
      paired.key.permissions?.raw
        ? `Connected to Toskar on ${where.name ?? where.host}. Its models are in Copilot Chat's model picker, and @toskar answers.`
        : `Connected to Toskar on ${where.name ?? where.host}, and @toskar answers. For its models in the model picker, connect again with a code an Admin shows.`,
    )
  } catch (err) {
    void vscode.window.showWarningMessage(`Toskar: ${(err as Error).message}`)
  }
}

/**
 * Which computer to connect to: the Toskar computers found on the network,
 * as they answer, or an address typed in.
 */
async function chooseComputer(title: string): Promise<{ host: string; port: number; name?: string } | undefined> {
  type Item = vscode.QuickPickItem & { computer?: FoundComputer; typed?: boolean }
  const typeIt: Item = { label: '$(edit) Enter an address', detail: 'Such as 192.168.1.20:7331, shown by Connect a device', typed: true, alwaysShow: true }
  const picker = vscode.window.createQuickPick<Item>()
  picker.title = title
  picker.placeholder = "Choose the computer that runs Toskar. On it, open Computers and choose Connect a device."
  picker.ignoreFocusOut = true
  picker.busy = true
  picker.items = [typeIt]
  const stop = findComputers((found) => {
    picker.items = [
      ...found.map((c) => ({
        label: `$(device-desktop) ${c.name}`,
        description: `${c.host}:${c.port}`,
        detail: c.onNetwork ? undefined : 'Answers only on itself: on it, choose Connect a device, then Allow and show a code.',
        computer: c,
      })),
      typeIt,
    ]
  })
  setTimeout(() => (picker.busy = false), 3000)
  const chosen = await new Promise<Item | undefined>((resolve) => {
    picker.onDidAccept(() => resolve(picker.selectedItems[0]))
    picker.onDidHide(() => resolve(undefined))
    picker.show()
  })
  stop()
  picker.dispose()
  if (chosen?.computer) return { host: chosen.computer.host, port: chosen.computer.port, name: chosen.computer.name }
  if (!chosen?.typed) return undefined
  const address = await vscode.window.showInputBox({
    title,
    prompt: 'On the computer that runs Toskar, open Computers and choose Connect a device. Enter the address it shows.',
    placeHolder: '192.168.1.20:7331',
    ignoreFocusOut: true,
    validateInput: (v) => (hostPort(v) ? undefined : 'An address such as 192.168.1.20:7331'),
  })
  return address ? hostPort(address) : undefined
}

/**
 * A key from API Access instead of a code, for an editor nobody can type a
 * code into, such as one on a remote server. An HTTPS address gets its
 * certificate pinned here, as connecting with a code does.
 */
async function setKey(context: vscode.ExtensionContext, refresh: () => void): Promise<void> {
  const key = await vscode.window.showInputBox({
    title: 'Use an API key instead of a code',
    prompt: `A key from Toskar's API Access. For the model picker, turn on "Drive models directly, for coding agents" in its permissions. Leave empty to remove it.`,
    password: true,
    ignoreFocusOut: true,
  })
  if (key === undefined) return
  if (!key) {
    await context.secrets.delete(keySecret)
    return refresh()
  }
  const address = url()
  if (address.startsWith('https:') && !pinFor(context, address)) {
    const where = hostPort(address)
    let pin: Pin | undefined
    try {
      pin = where && (await readCertificate(where.host, where.port))
    } catch {
      // Not answering: said below.
    }
    if (!pin) {
      void vscode.window.showWarningMessage(`Toskar isn't answering at ${address}. Set where it runs with Toskar: Manage, then try again.`)
      return
    }
    const ok = 'It Matches'
    const choice = await vscode.window.showWarningMessage(
      `Check that the encryption check code Toskar shows under Computers, Connect a device, starts ${shortOf(pin.fingerprint)}.`,
      { modal: true },
      ok,
    )
    if (choice !== ok) return
    await context.globalState.update(pinsState, { ...context.globalState.get<Record<string, Pin>>(pinsState, {}), [origin(address)]: pin })
  }
  await context.secrets.store(keySecret, key)
  refresh()
}
