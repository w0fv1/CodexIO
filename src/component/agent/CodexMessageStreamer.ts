import { inject, injectable } from 'inversify'
import { createMessage, deriveMessageId, MessageStatus, MessageThread } from '../../value/Message.js'
import { ChannelOutputContext } from '../channelo/ChannelOutput.js'
import { ChannelOutputManager } from '../channelo/ChannelOutputManager.js'

export type CodexStreamThread = {
  thread: MessageThread
  agentThreadId: string
  turnId: string
  source?: ChannelOutputContext['source']
  sourceMessageId?: string
  occurredAt?: number
  sequence?: number
}

export type CodexStreamMessage = {
  itemId: string
  text: string
  sequence?: number
}

type StreamItem = CodexStreamThread & {
  itemId: string
  text: string
  publishedLength: number
  occurredAt: number
  sending: Promise<void>
  cancelled: boolean
}

@injectable()
export class CodexMessageStreamer {
  private readonly items = new Map<string, StreamItem>()

  constructor(
    @inject(ChannelOutputManager) private readonly outputManager: ChannelOutputManager
  ) {}

  async append(thread: CodexStreamThread, itemId: string, delta: string): Promise<void> {
    const item = this.getItem(thread, itemId)
    item.text += delta
    await this.flushCompletedSegments(item)
  }

  async complete(thread: CodexStreamThread, messages: CodexStreamMessage[]): Promise<void> {
    for (const [sequence, message] of messages.entries()) {
      await this.completeItem({
        ...thread,
        sequence: message.sequence ?? sequence
      }, message.itemId, message.text)
    }
    this.clearTurn(thread.agentThreadId, thread.turnId)
  }

  async stageItem(thread: CodexStreamThread, itemId: string, text: string): Promise<void> {
    const item = this.getItem(thread, itemId)
    item.sequence = thread.sequence ?? item.sequence
    item.text = text
    await this.publish(item, item.text, 'streaming')
  }

  async completeItem(thread: CodexStreamThread, itemId: string, text?: string): Promise<void> {
    const item = this.getItem(thread, itemId)
    item.sequence = thread.sequence ?? item.sequence
    if (text !== undefined) {
      item.text = text
    }
    await this.publish(item, item.text, 'completed')
    const key = this.itemKey(thread, itemId)
    if (this.items.get(key) === item) {
      this.items.delete(key)
    }
  }

  clearTurn(agentThreadId: string, turnId: string): void {
    for (const [key, item] of this.items.entries()) {
      if (item.agentThreadId === agentThreadId && item.turnId === turnId) {
        item.cancelled = true
        this.items.delete(key)
      }
    }
  }

  clear(): void {
    for (const item of this.items.values()) {
      item.cancelled = true
    }
    this.items.clear()
  }

  private getItem(thread: CodexStreamThread, itemId: string): StreamItem {
    const key = this.itemKey(thread, itemId)
    const existing = this.items.get(key)
    if (existing) {
      return existing
    }
    const item: StreamItem = {
      ...thread,
      itemId,
      text: '',
      publishedLength: 0,
      occurredAt: thread.occurredAt ?? Date.now(),
      sequence: thread.sequence ?? 0,
      sending: Promise.resolve(),
      cancelled: false
    }
    this.items.set(key, item)
    return item
  }

  private async flushCompletedSegments(item: StreamItem): Promise<void> {
    let boundary = findSentenceSegmentBoundary(item.text.slice(item.publishedLength))
    while (boundary > 0) {
      item.publishedLength += boundary
      await this.publish(item, item.text.slice(0, item.publishedLength), 'streaming')
      boundary = findSentenceSegmentBoundary(item.text.slice(item.publishedLength))
    }
  }

  private async publish(item: StreamItem, text: string, status: MessageStatus): Promise<void> {
    const content = text.trim()
    if (content.length === 0) {
      return
    }
    const operation = item.sending.then(() => this.send(item, content, status))
    item.sending = operation.then(() => undefined, () => undefined)
    await operation
  }

  private async send(thread: StreamItem, text: string, status: MessageStatus): Promise<void> {
    if (thread.cancelled) {
      return
    }
    const content = {
      status,
      role: 'agent' as const,
      text
    }
    const result = await this.outputManager.sendAgent(createMessage({
      id: codexMessageId(thread.agentThreadId, thread.turnId, thread.itemId),
      occurredAt: thread.occurredAt,
      sequence: thread.sequence,
      thread: thread.thread,
      ...content
    }), {
      source: thread.source,
      sourceMessageId: thread.sourceMessageId
    })
    if (result.isFailed) {
      throw new Error(result.message)
    }
  }

  private itemKey(thread: CodexStreamThread, itemId: string): string {
    return `${thread.agentThreadId}\u0000${thread.turnId}\u0000${itemId}`
  }
}

export function codexMessageId(agentThreadId: string, turnId: string, itemId: string): string {
  return deriveMessageId('codex', agentThreadId, turnId, itemId)
}

function findSentenceSegmentBoundary(text: string): number {
  for (let index = 0; index < text.length; index += 1) {
    if (!isDoubleNewlineAt(text, index)) {
      continue
    }
    if (endsWithSentencePunctuation(text.slice(0, index))) {
      return index
    }
  }
  return 0
}

function isDoubleNewlineAt(text: string, index: number): boolean {
  return text.startsWith('\n\n', index) || text.startsWith('\r\n\r\n', index)
}

function endsWithSentencePunctuation(text: string): boolean {
  return /[。！？.!?][”’"'）)\]}]*\s*$/.test(text)
}
