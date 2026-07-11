import { MessageRevision } from '../value/Message.js'
import { Result } from '../value/Result.js'
import { KeyedSerialQueue } from './KeyedSerialQueue.js'

type InboxEntry<T> = {
  promise: Promise<Result<T>>
  completed: boolean
}

export class MessageInbox<T> {
  private readonly entries = new Map<string, InboxEntry<T>>()
  private readonly queue = new KeyedSerialQueue()

  constructor(private readonly capacity = 10_000) {}

  run(id: string, revision: MessageRevision, task: () => Promise<Result<T>>): Promise<Result<T>> {
    const entryKey = `${id.length}:${id}${revision}`
    const existing = this.entries.get(entryKey)
    if (existing) {
      return existing.promise
    }
    const operation = this.queue.run(id, task)
    const entry: InboxEntry<T> = {
      promise: operation,
      completed: false
    }
    this.entries.set(entryKey, entry)
    void operation.then((result) => {
      if (this.entries.get(entryKey) !== entry) {
        return
      }
      if (result.isFailed) {
        this.entries.delete(entryKey)
        return
      }
      entry.completed = true
      this.entries.delete(entryKey)
      this.entries.set(entryKey, entry)
      this.trim()
    }, () => {
      if (this.entries.get(entryKey) === entry) {
        this.entries.delete(entryKey)
      }
    })
    return operation
  }

  private trim(): void {
    while (this.entries.size > this.capacity) {
      const completed = [...this.entries].find(([, entry]) => entry.completed)
      if (!completed) {
        return
      }
      this.entries.delete(completed[0])
    }
  }
}
