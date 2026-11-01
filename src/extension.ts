import * as vscode from 'vscode'
import { dataOf, titleOf, withData } from './ask'
import { handler, lastSpeed, participantID, pick } from './participant'
import { ToskarChatProvider } from './provider'
import { Toskar } from './toskar'

const keySecret = 'toskar.apiKey'

export function activate(context: vscode.ExtensionContext): void {
  const connect = async () => new Toskar(url(), await context.secrets.get(keySecret))
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
  void showRunning(status, connect, speed)
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
async function showRunning(status: vscode.StatusBarItem, connect: () => Promise<Toskar>, speed: number): Promise<void> {
  if (!vscode.workspace.getConfiguration('toskar').get<boolean>('statusBar', true)) {
    status.hide()
    return
  }
  try {
    const running = await (await connect()).running()
    const first = running[0]
    status.text = first ? `$(sparkle) ${first.display_name || first.model_id}` : '$(sparkle) Toskar'
    const fast = speed ? ` The last answer came at ${Math.round(speed)} tokens a second.` : ''
    status.tooltip = first
      ? `Toskar has ${running.map((m) => m.display_name || m.model_id).join(', ')} loaded${first.node_name ? ` on ${first.node_name}` : ''}.${fast} Open Toskar's models.`
      : `Toskar is running, with no model loaded.${fast} Open Toskar's models.`
  } catch {
    status.text = '$(sparkle) Toskar: off'
    status.tooltip = `Toskar isn't answering at ${url()}. Open Toskar: Manage to change where it runs.`
  }
  status.show()
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
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'Where Toskar runs', description: url(), id: 'url' },
      { label: 'API key', description: (await context.secrets.get(keySecret)) ? 'set' : 'not set: none is needed on this computer', id: 'key' },
      { label: "Open Toskar's models", id: 'models' },
    ],
    { title: 'Toskar' },
  )
  if (pick?.id === 'url') {
    const next = await vscode.window.showInputBox({ title: 'Where Toskar runs', value: url(), prompt: 'Its address, such as http://127.0.0.1:7331 for this computer' })
    if (next) await vscode.workspace.getConfiguration('toskar').update('url', next, vscode.ConfigurationTarget.Global)
  } else if (pick?.id === 'key') {
    await setKey(context, refresh)
  } else if (pick?.id === 'models') {
    await vscode.commands.executeCommand('toskar.openModels')
  }
}

async function setKey(context: vscode.ExtensionContext, refresh: () => void): Promise<void> {
  const key = await vscode.window.showInputBox({
    title: 'Toskar API key',
    prompt: `A key from Toskar's API Access with "Drive models directly, for coding agents" on. Leave empty to remove it.`,
    password: true,
    ignoreFocusOut: true,
  })
  if (key === undefined) return
  if (key) await context.secrets.store(keySecret, key)
  else await context.secrets.delete(keySecret)
  refresh()
}
