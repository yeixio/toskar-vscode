# Toskar for VS Code

Your local AI in VS Code, two ways:

- **Toskar's models in Copilot Chat's model picker**, next to the cloud ones. Pick one and chat, edit, or run agent mode with Copilot's tools, while the model runs on your own computer.
- **@toskar**, Toskar's own assistant, with your profiles, knowledge, and memory. Ask it about your code, and the chat is in Toskar's History on your phone and desktop too.

## What you need

- **Toskar 1.12 or later**, on this computer or another one you can reach.
- **A chat model installed** in Toskar, ideally one that calls tools and is made for code, such as Qwen 2.5 Coder.
- **VS Code 1.104 or later**, with GitHub Copilot Chat. Its model picker is where Toskar's models appear.

## Use it

1. Install the extension. With Toskar on this computer, there's nothing to set up.
2. In Copilot Chat, open the model picker and choose a model marked **Toskar**. If Toskar's models aren't listed, open **Manage Models** and turn them on.
3. Chat as usual. Agent mode works: Copilot runs its tools, and the model on your computer decides which to call.

The status bar shows the model Toskar has loaded, and how fast @toskar's last answer came. Click it to open Toskar's Models page.

## Ask Toskar about your code

1. Select some code, or none for the whole file, right-click, and choose **Ask Toskar about This**.
2. Copilot Chat opens with `@toskar`. Type your question.
3. The answer streams in. The code goes with your message as data to work on, so instructions inside it aren't followed.

You can also type `@toskar` in Copilot Chat yourself, and add files or selections with `#`. Follow-up questions in the same chat continue the same Toskar chat, which the apps list in History.

When Toskar's assistant wants a tool that asks first, such as running code, VS Code asks you with what it would run, and on which computer when Toskar is on another one. Choose **Allow** for this once, or **Allow in This Chat** to let that tool run for the rest of the chat without asking (Toskar 1.12 or later; earlier versions ask again). Close the dialog to refuse.

In an editor without Copilot Chat's chat view, **Ask Toskar about This** asks for your question, waits for the answer, and opens the chat in Toskar.

## Toskar on another computer

Connect the way a phone does, with a code:

1. On the computer Toskar runs on, open Toskar's **API Access**, then **Devices**, and choose **Connect a device**.
2. In VS Code, run **Toskar: Connect to Another Computer** and enter the address Toskar shows, such as `192.168.1.20:7331`.
3. Check that the certificate VS Code names, such as `4F2A-9C1B`, is the one Toskar shows, then enter the 6-digit code.

VS Code gets a key of its own, kept in its secret storage, and listed in Toskar's Devices, where you can disconnect it. It talks to Toskar over HTTPS and trusts only that computer's certificate from then on.

The model picker needs raw access, which lets an agent drive a model directly. VS Code gets it when an Admin or the Owner showed the code. Otherwise @toskar works, and the model picker asks you to connect again with an Admin's code.

You can also use a key from **API Access** instead: set where Toskar runs with **Toskar: Manage**, and the key with **Toskar: Set API Key**. For the model picker, turn on **Drive models directly, for coding agents** in its permissions.

## How it works

**The model picker:** the extension adds Toskar as a language model provider. Each installed chat model is listed with its real context window and whether it calls tools. A request goes to Toskar's raw mode (`raw:<model>` on `/v1/chat/completions`). That's the model itself, with Copilot's own tools passed through, and none of Toskar's assistant on top. Answers stream back as they're written. When an agent sends more tools than the model's window holds, Toskar gives the model the most relevant ones and lets it search for the rest.

**@toskar:** a VS Code chat becomes a Toskar chat (`POST /api/v1/chat`), so Toskar's assistant answers: the profile's tools, knowledge, and memory, and the model Toskar picks. Tools that ask first come as Toskar's events and are answered with `/api/v1/tools/decide`, as the apps answer them.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `toskar.url` | `http://127.0.0.1:7331` | Where Toskar runs |
| `toskar.chatModel` | empty | The model @toskar answers with, such as `qwen2.5-7b-q4`. Empty lets Toskar choose |
| `toskar.profile` | empty | The profile @toskar answers as, such as `programming`. Empty uses your default |
| `toskar.statusBar` | `true` | Show the loaded model in the status bar |

## Commands

- **Ask Toskar about This**: the selection, or the file, for the next @toskar message.
- **Toskar: Connect to Another Computer**: connect with the code from Connect a device.
- **Toskar: Manage**: where Toskar runs, the API key, and Toskar's models. Copilot's model manager opens this too.
- **Toskar: Set API Key**
- **Toskar: Refresh Models**: list the models again after installing one in Toskar.
- **Toskar: Open Models**

## Development

```bash
pnpm install
pnpm test        # the conversion, @toskar's messages, and the Toskar client, without VS Code
pnpm typecheck
pnpm build       # out/extension.js
pnpm package     # toskar-<version>.vsix
```

Press F5 in VS Code with this folder open to run it in an Extension Development Host.

## License

Apache 2.0. Toskar itself is at [yeixio/toskar-core](https://github.com/yeixio/toskar-core).
