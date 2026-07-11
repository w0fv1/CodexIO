export type CodexLiveItemState = {
  phase?: string
  startedAt?: number
}

export class CodexLiveItemTracker {
  private readonly threads = new Map<string, Map<string, Map<string, CodexLiveItemState>>>()

  startItem(
    threadId: string,
    turnId: string,
    itemId: string,
    state: CodexLiveItemState
  ): void {
    let turns = this.threads.get(threadId)
    if (!turns) {
      turns = new Map()
      this.threads.set(threadId, turns)
    }
    let items = turns.get(turnId)
    if (!items) {
      items = new Map()
      turns.set(turnId, items)
    }
    items.set(itemId, state)
  }

  getItem(threadId: string, turnId: string, itemId: string): CodexLiveItemState | undefined {
    return this.threads.get(threadId)?.get(turnId)?.get(itemId)
  }

  clearTurn(threadId: string, turnId: string): void {
    const turns = this.threads.get(threadId)
    if (!turns) {
      return
    }
    turns.delete(turnId)
    if (turns.size === 0) {
      this.threads.delete(threadId)
    }
  }

  clearThread(threadId: string): void {
    this.threads.delete(threadId)
  }

  clear(): void {
    this.threads.clear()
  }
}
