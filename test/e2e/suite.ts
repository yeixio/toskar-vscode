import assert from 'node:assert/strict'
import * as vscode from 'vscode'
import { handler } from '../../src/participant'
import { Toskar } from '../../src/toskar'

// Runs inside VS Code. Copilot Chat isn't installed here, so its picker and
// chat view aren't what's tested: VS Code's language model API, which Copilot
// reads the picker from, and @toskar's handler are.

const never = new vscode.CancellationTokenSource().token

/** Toskar's model, which the provider lists a moment after activating. */
async function toskarModel(): Promise<vscode.LanguageModelChat> {
  for (let i = 0; i < 40; i++) {
    const [model] = await vscode.lm.selectChatModels({ vendor: 'toskar' })
    if (model) return model
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('no Toskar model in VS Code')
}

const cases: [string, () => Promise<void>][] = [
  [
    'the extension activates and adds its commands',
    async () => {
      const extension = vscode.extensions.getExtension('YeixioLLC.toskar')
      assert.ok(extension, 'not loaded')
      await extension.activate()
      const commands = await vscode.commands.getCommands(true)
      for (const c of ['toskar.askAboutThis', 'toskar.manage', 'toskar.connect', 'toskar.setApiKey', 'toskar.refresh', 'toskar.openModels']) {
        assert.ok(commands.includes(c), c)
      }
    },
  ],
  [
    'VS Code lists the model Toskar has',
    async () => {
      const model = await toskarModel()
      assert.equal(model.vendor, 'toskar')
      assert.equal(model.name, 'Scripted')
      assert.ok(model.maxInputTokens > 0)
    },
  ],
  [
    'a request reaches the model through raw mode, and the answer streams back',
    async () => {
      const model = await toskarModel()
      const response = await model.sendRequest([vscode.LanguageModelChatMessage.User('Name a river')], {}, never)
      let text = ''
      for await (const piece of response.text) text += piece
      assert.equal(text, 'You said: Name a river')
    },
  ],
  [
    "the editor's tools go to the model, and its call comes back",
    async () => {
      const model = await toskarModel()
      const tools = [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }]
      const response = await model.sendRequest([vscode.LanguageModelChatMessage.User('Read the README')], { tools }, never)
      const calls: vscode.LanguageModelToolCallPart[] = []
      for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelToolCallPart) calls.push(part)
      }
      assert.equal(calls.length, 1)
      assert.equal(calls[0].name, 'read_file')
      assert.deepEqual(calls[0].input, { path: 'README.md' })
    },
  ],
  [
    "@toskar answers as Toskar's assistant, in a chat the apps list",
    async () => {
      const said: string[] = []
      const stream = { markdown: (s: string) => said.push(s), progress: () => {} } as unknown as vscode.ChatResponseStream
      const request = { prompt: 'Name a lake', references: [] } as unknown as vscode.ChatRequest
      const context = { history: [] } as unknown as vscode.ChatContext
      const core = process.env.TOSKAR_E2E_CORE as string
      const result = await handler(async () => new Toskar(core, undefined))(request, context, stream, never)
      assert.equal(result && 'errorDetails' in result ? result.errorDetails : undefined, undefined)
      assert.match(said.join(''), /You said: .*Name a lake/)
      const chats = (await (await fetch(`${core}/api/v1/conversations`)).json()) as { title: string }[]
      assert.ok(chats.some((c) => c.title.includes('Name a lake')), JSON.stringify(chats))
    },
  ],
]

export async function run(): Promise<void> {
  const failed: string[] = []
  for (const [name, test] of cases) {
    try {
      await test()
      console.log(`ok   ${name}`)
    } catch (err) {
      failed.push(name)
      console.log(`FAIL ${name}\n${(err as Error).stack ?? err}`)
    }
  }
  if (failed.length > 0) throw new Error(`${failed.length} of ${cases.length} failed`)
}
