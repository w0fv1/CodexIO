import { injectable } from 'inversify'
import { createMessage, deriveMessageId, MessageThread } from '../../../value/Message.js'
import { AgentOutputReceiver } from '../Agent.js'

export type CodexMessageContext = {
  thread: MessageThread
  agentThreadId: string
  turnId: string
  occurredAt?: number
}

export type CodexCompletedMessage = {
  itemId: string
  text: string
}

type PendingMessage = CodexMessageContext & {
  itemId: string
  text: string
  occurredAt: number
}

@injectable()
export class CodexMessageAssembler {
  private readonly pending = new Map<string, PendingMessage>()
  private receiver?: AgentOutputReceiver

  start(receiver: AgentOutputReceiver): void {
    this.receiver = receiver
  }

  append(context: CodexMessageContext, itemId: string, delta: string): void {
    const item = this.getItem(context, itemId)
    item.text += delta
  }

  async completeItem(context: CodexMessageContext, itemId: string, text?: string): Promise<void> {
    const item = this.getItem(context, itemId)
    if (text !== undefined) {
      item.text = text
    }
    const content = item.text.trim()
    if (content.length === 0) {
      this.pending.delete(this.itemKey(context, itemId))
      return
    }
    if (!this.receiver) {
      throw new Error('codex message output receiver not ready')
    }
    const result = await this.receiver.receiveAgentOutput(createMessage({
      id: codexMessageId(item.agentThreadId, item.turnId, item.itemId),
      occurredAt: item.occurredAt,
      thread: item.thread,
      role: 'agent',
      text: content
    }))
    if (result.isFailed) {
      throw new Error(result.message)
    }
    this.pending.delete(this.itemKey(context, itemId))
  }

  async complete(context: CodexMessageContext, messages: CodexCompletedMessage[]): Promise<void> {
    if (messages.length === 0) {
      const staged = [...this.pending.values()].filter((item) => {
        return item.agentThreadId === context.agentThreadId && item.turnId === context.turnId
      })
      for (const item of staged) {
        await this.completeItem(item, item.itemId)
      }
      return
    }
    for (const message of messages) {
      await this.completeItem(context, message.itemId, message.text)
    }
    this.clearTurn(context.agentThreadId, context.turnId)
  }

  clearTurn(agentThreadId: string, turnId: string): void {
    for (const [key, item] of this.pending.entries()) {
      if (item.agentThreadId === agentThreadId && item.turnId === turnId) {
        this.pending.delete(key)
      }
    }
  }

  clear(): void {
    this.pending.clear()
    this.receiver = undefined
  }

  private getItem(context: CodexMessageContext, itemId: string): PendingMessage {
    const key = this.itemKey(context, itemId)
    const existing = this.pending.get(key)
    if (existing) {
      return existing
    }
    const item: PendingMessage = {
      ...context,
      itemId,
      text: '',
      occurredAt: context.occurredAt ?? Date.now()
    }
    this.pending.set(key, item)
    return item
  }

  private itemKey(context: CodexMessageContext, itemId: string): string {
    return `${context.agentThreadId}\u0000${context.turnId}\u0000${itemId}`
  }
}

export function codexMessageId(agentThreadId: string, turnId: string, itemId: string): string {
  return deriveMessageId('codex', agentThreadId, turnId, itemId)
}
