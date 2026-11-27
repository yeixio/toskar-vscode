// The little of VS Code's API @toskar's handler uses, for tests outside VS
// Code. The real one is tested in test/e2e.

export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = []
  event = (listener: (e: T) => void) => {
    this.listeners.push(listener)
    return { dispose: () => {} }
  }
  fire(e: T): void {
    for (const l of this.listeners) l(e)
  }
}

export class Uri {}

/** As VS Code's: the error a chat model provider throws, with a code Copilot Chat reads. */
export class LanguageModelError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
  static NoPermissions(message?: string) {
    return new LanguageModelError(message ?? '', 'NoPermissions')
  }
  static NotFound(message?: string) {
    return new LanguageModelError(message ?? '', 'NotFound')
  }
  static Blocked(message?: string) {
    return new LanguageModelError(message ?? '', 'Blocked')
  }
}
export class Location {}
export class ChatResponseTurn {}

/** Settings tests set; toskar.chatModel and toskar.profile are empty by default. */
export const settings: Record<string, unknown> = {}

/** What the next approval dialog answers, and the dialogs shown. */
export const dialogs: { message: string; detail?: string; buttons: string[] }[] = []
export const answers: { next?: string } = {}

export const workspace = {
  getConfiguration: () => ({ get: (key: string) => settings[key] }),
  asRelativePath: (u: unknown) => String(u),
  openTextDocument: async () => {
    throw new Error('no documents in tests')
  },
}

export const window = {
  showWarningMessage: async (message: string, options: { detail?: string }, ...buttons: string[]) => {
    dialogs.push({ message, detail: options?.detail, buttons })
    return answers.next
  },
}
