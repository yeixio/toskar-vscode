# Toskar for VS Code

Your local AI in VS Code. The models on your [Toskar](https://toskar.ai) computer show up in **Copilot Chat's model picker**, next to the cloud ones. Pick one and chat, edit, or run agent mode with Copilot's tools, while the model runs on your own computer.

## What you need

- **Toskar 1.12 or later**, on this computer or another one you can reach.
- **A chat model installed** in Toskar, ideally one that calls tools and is made for code, such as Qwen 2.5 Coder.
- **VS Code 1.104 or later**, with GitHub Copilot Chat. Its model picker is where Toskar's models appear.

## Use it

1. Install the extension. With Toskar on this computer, there's nothing to set up.
2. In Copilot Chat, open the model picker and choose a model marked **Toskar**. If Toskar's models aren't listed, open **Manage Models** and turn them on.
3. Chat as usual. Agent mode works: Copilot runs its tools, and the model on your computer decides which to call.

The status bar shows the model Toskar has loaded. Click it to open Toskar's Models page.

## Toskar on another computer

Run **Toskar: Manage** and set where Toskar runs, such as `http://192.168.1.20:7331`. Another computer needs an API key:

1. In Toskar, open **API Access**, create a key, and turn on **Drive models directly, for coding agents** in its permissions. Only an Admin can.
2. Run **Toskar: Set API Key** and paste it. It's kept in VS Code's secret storage.

## How it works

The extension adds Toskar as a language model provider. Each installed chat model is listed with its real context window and whether it calls tools. A request goes to Toskar's raw mode (`raw:<model>` on `/v1/chat/completions`). That's the model itself, with Copilot's own tools passed through, and none of Toskar's assistant on top. Answers stream back as they're written. When an agent sends more tools than the model's window holds, Toskar gives the model the most relevant ones and lets it search for the rest.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `toskar.url` | `http://127.0.0.1:7331` | Where Toskar runs |
| `toskar.statusBar` | `true` | Show the loaded model in the status bar |

## Commands

- **Toskar: Manage**: where Toskar runs, the API key, and Toskar's models. Copilot's model manager opens this too.
- **Toskar: Set API Key**
- **Toskar: Refresh Models**: list the models again after installing one in Toskar.
- **Toskar: Open Models**

## Development

```bash
pnpm install
pnpm test        # the conversion and Toskar client, without VS Code
pnpm typecheck
pnpm build       # out/extension.js
pnpm package     # toskar-<version>.vsix
```

Press F5 in VS Code with this folder open to run it in an Extension Development Host.

## License

Apache 2.0. Toskar itself is at [yeixio/toskar-core](https://github.com/yeixio/toskar-core).
