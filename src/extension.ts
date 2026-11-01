import * as vscode from 'vscode'
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
    void showRunning(status, connect)
  }

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider('toskar', provider),
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
  void showRunning(status, connect)
  const timer = setInterval(() => void showRunning(status, connect), 30_000)
  context.subscriptions.push({ dispose: () => clearInterval(timer) })
}

export function deactivate(): void {}

function url(): string {
  return vscode.workspace.getConfiguration('toskar').get<string>('url') || 'http://127.0.0.1:7331'
}

/** The status bar: the model Toskar has loaded, and on which computer. */
async function showRunning(status: vscode.StatusBarItem, connect: () => Promise<Toskar>): Promise<void> {
  if (!vscode.workspace.getConfiguration('toskar').get<boolean>('statusBar', true)) {
    status.hide()
    return
  }
  try {
    const running = await (await connect()).running()
    const first = running[0]
    status.text = first ? `$(sparkle) ${first.display_name || first.model_id}` : '$(sparkle) Toskar'
    status.tooltip = first
      ? `Toskar has ${running.map((m) => m.display_name || m.model_id).join(', ')} loaded${first.node_name ? ` on ${first.node_name}` : ''}. Open Toskar's models.`
      : "Toskar is running, with no model loaded. Open Toskar's models."
  } catch {
    status.text = '$(sparkle) Toskar: off'
    status.tooltip = `Toskar isn't answering at ${url()}. Open Toskar: Manage to change where it runs.`
  }
  status.show()
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
