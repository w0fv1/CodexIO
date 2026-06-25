import { injectable } from 'inversify'
import { Message } from '../value/Message.js'

@injectable()
export class ThreadMessageStore {
  private readonly messages = new Map<string, Message[]>()

  list(): Message[] {
    return [...this.messages.values()].flat().map((message) => ({
      ...message,
      files: message.files ? [
        ...message.files
      ] : undefined
    }))
  }

  append(message: Message): void {
    const messages = this.messages.get(message.ioThreadId) ?? []
    messages.push({
      ...message,
      files: message.files ? [
        ...message.files
      ] : undefined
    })
    this.messages.set(message.ioThreadId, messages)
  }

  clear(ioThreadId?: string): void {
    if (!ioThreadId) {
      this.messages.clear()
      return
    }
    this.messages.delete(ioThreadId)
  }
}
