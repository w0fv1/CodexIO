import { ChannelAdapter, InboundTextMessage, SendTextInput } from './ChannelAdapter.js'

export class CliChannelAdapter implements ChannelAdapter {
  readonly type = 'cli'
  readonly sent: SendTextInput[] = []

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
    let conversationId = 'terminal'
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
    this.sent.push(input)
    process.stdout.write(`[codexio:${input.conversationId}] ${input.text}\n`)
  }
}
