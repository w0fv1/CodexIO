import { ChannelAdapter, ChannelMessage, ChannelStartInput } from './ChannelAdapter.js'
import { Result } from '../Result.js'

export type FeishuWebhookChannelConfig = {
  enabled?: boolean
  url?: string
}

export class FeishuWebhookChannelAdapter implements ChannelAdapter {
  readonly type = 'feishuWebhook'

  constructor(private readonly config?: FeishuWebhookChannelConfig) {}

  start(_input: ChannelStartInput): void {
    if (!this.config?.url || this.config.url.trim().length === 0) {
      throw new Error('feishu webhook url is required')
    }
  }

  async send(message: ChannelMessage): Promise<Result<null>> {
    if (!this.config?.url || this.config.url.trim().length === 0) {
      return Result.fail('feishu webhook url is required')
    }
    if (message.text.trim().length === 0) {
      return Result.fail('text is required')
    }
    let text = message.text
    if (message.role === 'system' && message.text === 'clear') {
      text = '已开始新对话'
    }
    try {
      const response = await fetch(this.config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          msg_type: 'text',
          content: {
            text
          }
        })
      })
      if (!response.ok) {
        return Result.fail(`feishu webhook failed: ${response.status}`)
      }
      return Result.success(null)
    } catch (error) {
      return Result.fromError(error)
    }
  }

  async stop(): Promise<Result<null>> {
    return Result.success(null)
  }
}
