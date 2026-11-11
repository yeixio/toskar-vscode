# Changelog

## 0.4.0

- Connecting is one way: the code from Connect a device. **Toskar: Manage** no longer asks for an API key, and offers **Disconnect** once you're connected. A key from API Access is still there for an editor nobody can type a code into, as **Toskar: Use an API Key Instead**, and it now checks and pins the certificate of an HTTPS address, as a code does. Messages that said to set an API key now say to connect with a code.
- Connecting with a code works again. VS Code refused Toskar's certificate after the code was accepted, since it wouldn't treat a certificate Toskar made itself as trusted, so every request failed with a certificate error. The extension now compares the certificate with the one you checked, byte for byte, before anything is sent.
- **Connect to Another Computer** lists the Toskar computers on your network, so you choose one instead of looking up its address. **Enter an address** is still there. A computer whose network access is off says what to turn on.
- When Toskar isn't answering, the status bar says **Toskar: connect**, and clicking it opens Toskar: Manage, rather than a page that won't open. The first time Toskar isn't running on your computer, VS Code offers to connect to one on your network, or to install Toskar.
- The steps point to **Computers**, then **Connect a device**, as Toskar's guide does.

## 0.3.1

- The model picker no longer lists models on a server Toskar connects to, which it can't drive and which failed with "that model isn't installed on this computer" (toskar-core#960).
- @toskar no longer sends the skills index and instruction files VS Code adds for Copilot, which it answered about instead of your message (toskar-core#960).
- Sending Ask Toskar about This without a question now asks Toskar to explain the code, which stays data, and a selection goes once instead of twice (toskar-core#960).

## 0.3.0

- **Toskar: Connect to Another Computer** connects with the code from Toskar's Connect a device, as a phone does, and pins that computer's certificate. A code an Admin shows gives the key raw access, for the model picker (toskar-core#960).

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
