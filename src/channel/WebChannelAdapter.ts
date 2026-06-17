import { EventEmitter } from 'node:events'
import { ChannelAdapter, InboundTextMessage, SendTextInput } from './ChannelAdapter.js'

export type WebOutboundMessage = {
  conversationId: string
  text: string
  createdAt: number
}

export class WebChannelAdapter implements ChannelAdapter {
  readonly type = 'web'
  private readonly emitter = new EventEmitter()
  private readonly messages = new Map<string, WebOutboundMessage[]>()

  async parseInbound(input: {
    headers: Record<string, string | string[] | undefined>
    body: unknown
  }): Promise<InboundTextMessage[]> {
    if (!input.body || typeof input.body !== 'object') {
      return []
    }
    const body = input.body as Record<string, unknown>
    if (typeof body.text !== 'string' || body.text.trim().length === 0) {
      return []
    }
    let conversationId = 'browser'
    if (typeof body.conversationId === 'string' && body.conversationId.trim().length > 0) {
      conversationId = body.conversationId.trim()
    }
    return [
      {
        channel: this.type,
        conversationId,
        text: body.text,
        rawMessageId: typeof body.rawMessageId === 'string' ? body.rawMessageId : undefined
      }
    ]
  }

  async sendText(input: SendTextInput): Promise<void> {
    const message = {
      conversationId: input.conversationId,
      text: input.text,
      createdAt: Date.now()
    }
    const existing = this.messages.get(input.conversationId) ?? []
    existing.push(message)
    this.messages.set(input.conversationId, existing)
    this.emitter.emit(input.conversationId, message)
  }

  history(conversationId: string): WebOutboundMessage[] {
    return this.messages.get(conversationId) ?? []
  }

  subscribe(conversationId: string, listener: (message: WebOutboundMessage) => void): () => void {
    this.emitter.on(conversationId, listener)
    return () => {
      this.emitter.off(conversationId, listener)
    }
  }
}
