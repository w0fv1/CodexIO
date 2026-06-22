import { CodexioConfig } from '../ConfigService.js'
import { Channel, ChannelMessage } from './Channel.js'
import { Result } from '../value/Result.js'
import { Logger } from '../component/Logger.js'
import { createFeishuWebhookText } from './ChannelUtil.js'

type FeishuWebhookChannelConfig = CodexioConfig['channels']['feishuWebhook']

export class FeishuWebhookChannel implements Channel {
  readonly type = 'feishuWebhook'
  private config?: FeishuWebhookChannelConfig

  start(config: CodexioConfig): void {
    this.config = config.channels.feishuWebhook
    if (!this.config?.url || this.config.url.trim().length === 0) {
      throw new Error('feishu webhook url is required')
    }
    Logger.info('feishu webhook channel ready')
  }

  async send(message: ChannelMessage): Promise<Result<null>> {
    if (!this.config?.url || this.config.url.trim().length === 0) {
      return Result.fail('feishu webhook url is required')
    }
    if (message.text.trim().length === 0 && (!message.files || message.files.length === 0)) {
      return Result.fail('text or file is required')
    }
    const text = createFeishuWebhookText(message)
    try {
      Logger.info('feishu webhook send started', {
        role: message.role,
        source: message.source ?? null,
        length: text.length
      })
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
        Logger.warn('feishu webhook send failed', {
          status: response.status
        })
        return Result.fail(`feishu webhook failed: ${response.status}`)
      }
      Logger.info('feishu webhook send completed', {
        role: message.role
      })
      return Result.success(null)
    } catch (error) {
      Logger.error('feishu webhook send crashed', error)
      return Result.fromError(error)
    }
  }

  async stop(): Promise<Result<null>> {
    Logger.info('feishu webhook channel stopped')
    return Result.success(null)
  }
}
