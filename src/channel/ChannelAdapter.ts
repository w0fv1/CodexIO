export type InboundTextMessage = {
  channel: string
  conversationId: string
  text: string
  rawMessageId?: string
}

export type SendTextInput = {
  conversationId: string
  text: string
}

export interface ChannelAdapter {
  type: string
  parseInbound(input: {
    headers: Record<string, string | string[] | undefined>
    body: unknown
    rawBody?: Buffer
  }): Promise<InboundTextMessage[]>
  sendText(input: SendTextInput): Promise<void>
}
