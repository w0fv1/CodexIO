import { Result } from '../value/Result.js'

type InboxEntry<T> = {
  promise: Promise<Result<T>>
  completed: boolean
}

export class MessageInbox<T> {
  private readonly entries = new Map<string, InboxEntry<T>>()

  constructor(private readonly capacity = 10_000) {}

  run(id: string, task: () => Promise<Result<T>>): Promise<Result<T>> {
    const existing = this.entries.get(id)
    if (existing) {
      return existing.promise
    }
    const operation = Promise.resolve().then(task)
    const entry: InboxEntry<T> = {
      promise: operation,
      completed: false
    }
    this.entries.set(id, entry)
    void operation.then((result) => {
      if (this.entries.get(id) !== entry) {
        return
      }
      if (result.isFailed) {
        this.entries.delete(id)
        return
      }
      entry.completed = true
      this.entries.delete(id)
      this.entries.set(id, entry)
      this.trim()
    }, () => {
      if (this.entries.get(id) === entry) {
        this.entries.delete(id)
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
