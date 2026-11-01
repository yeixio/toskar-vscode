# Changelog

## 0.2.1

- **Allow in This Chat** on a tool's approval lets it run for the rest of the @toskar chat without asking, with Toskar 1.12 or later (toskar-core#996).

## 0.2.0

- **@toskar** in Copilot Chat: Toskar's assistant, with your profiles, knowledge, and memory, in a Toskar chat the apps list too. Files and selections go with the message as data, and a tool that asks first asks in VS Code (toskar-core#960).
- **Ask Toskar about This** in the editor's menu sends the selection, or the file, to @toskar. Without a chat view, it opens the answer in Toskar.
- The status bar shows how fast @toskar's last answer came.
- `toskar.chatModel` and `toskar.profile` choose who answers @toskar.

## 0.1.0

- Toskar's installed chat models in Copilot Chat's model picker, with their context window and tool calling, through Toskar's raw mode (toskar-core#960, #843).
- The status bar shows the model Toskar has loaded.
- **Toskar: Manage** and **Toskar: Set API Key**, for Toskar on another computer; the key is kept in VS Code's secret storage.
