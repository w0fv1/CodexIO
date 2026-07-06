import { inject, injectable } from 'inversify'
import { CodexioConfig } from '../../value/ConfigDefinition.js'
import { Message } from '../../value/Message.js'
import { ChannelOutput, ChannelOutputContext } from './ChannelOutput.js'
import { Result } from '../../value/Result.js'
import { Logger } from '../Logger.js'
import { Configer } from '../Configer.js'

type FeishuWebhookChannelConfig = CodexioConfig['channelo']['feishuWebhook']

@injectable()
export class FeishuWebhookChannelOutput implements ChannelOutput {
  readonly type = 'feishuWebhook'
  private config?: FeishuWebhookChannelConfig

  constructor(@inject(Configer) private readonly configer: Configer) {}

  async start(): Promise<boolean> {
    this.config = await this.configer.get('channelo.feishuWebhook')
    if (!this.config?.enabled) {
      return false
    }
    if (!this.config?.url || this.config.url.trim().length === 0) {
      throw new Error('feishu webhook url is required')
    }
    Logger.info('feishu webhook channel ready')
    return true
  }

  async send(message: Message, context?: ChannelOutputContext): Promise<Result<void>> {
    if (!this.config?.url || this.config.url.trim().length === 0) {
      return Result.fail('feishu webhook url is required')
    }
    if (message.text.trim().length === 0 && (!message.files || message.files.length === 0)) {
      return Result.fail('text or file is required')
    }
    let text = message.text
    if (text.trim().length === 0 && message.files && message.files.length > 0) {
      text = `已收到文件：${message.files.map((file) => file.name).join('、')}`
    }
    try {
      Logger.info('feishu webhook send started', {
        role: message.role,
        source: context?.source ?? null,
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
      return Result.successVoid()
    } catch (error) {
      Logger.error('feishu webhook send crashed', error)
      return Result.fromError(error)
    }
  }

  async stop(): Promise<Result<void>> {
    Logger.info('feishu webhook channel stopped')
    return Result.successVoid()
  }
}
