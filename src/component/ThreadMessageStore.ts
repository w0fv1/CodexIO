import { injectable } from 'inversify'
import { Message } from '../value/Message.js'

export type ThreadMessage = Message & {
  createdAt: number
}

@injectable()
export class ThreadMessageStore {
  private readonly messages = new Map<string, ThreadMessage[]>()

  list(): ThreadMessage[] {
    return [...this.messages.values()].flat().map((message) => ({
      ...message,
      files: message.files ? [
        ...message.files
      ] : undefined
    }))
  }

  append(message: Message): ThreadMessage {
    const messages = this.messages.get(message.ioThreadId) ?? []
    const stored = {
      ...message,
      createdAt: Date.now(),
      files: message.files ? [
        ...message.files
      ] : undefined
    }
    messages.push(stored)
    this.messages.set(message.ioThreadId, messages)
    return stored
  }

  clear(ioThreadId?: string): void {
    if (!ioThreadId) {
      this.messages.clear()
      return
    }
    this.messages.delete(ioThreadId)
  }
}
