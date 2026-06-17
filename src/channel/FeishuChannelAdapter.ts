import * as Lark from '@larksuiteoapi/node-sdk'
import { ChannelAdapter, ChannelStartInput } from './ChannelAdapter.js'
import { Result } from '../Result.js'

export type FeishuChannelConfig = {
  enabled?: boolean
  appId?: string
  appSecret?: string
}

export class FeishuChannelAdapter implements ChannelAdapter {
  readonly type = 'feishu'
  private input?: ChannelStartInput
  private client?: Lark.Client
  private wsClient?: Lark.WSClient
  private readonly chatIds = new Set<string>()

  constructor(private readonly config?: FeishuChannelConfig) {}

  start(input: ChannelStartInput): void {
    this.input = input
    if (!this.config?.appId || !this.config.appSecret) {
      throw new Error('feishu appId and appSecret are required')
    }
    this.client = new Lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret
    })
    this.wsClient = new Lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: Lark.LoggerLevel.warn
    })
    void this.wsClient.start({
      eventDispatcher: new Lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data) => {
          try {
            this.chatIds.add(data.message.chat_id)
            if (data.message.message_type !== 'text') {
              await this.send('当前只支持文本消息')
              return
            }
            const content = JSON.parse(data.message.content) as Record<string, unknown>
            if (typeof content.text !== 'string' || content.text.trim().length === 0) {
              await this.send('消息文本为空')
              return
            }
            let text = content.text
            for (const mention of data.message.mentions ?? []) {
              text = text.replaceAll(mention.key, '')
            }
            const received = await this.receive(text)
            if (received.isFailed) {
              await this.send(received.message)
              return
            }
            if (!this.input) {
              await this.send('feishu channel not started')
              return
            }
            const result = await this.input.receive(text)
            if (result.data?.action === 'clear') {
              await this.send('已开始新对话')
              return
            }
            if (result.isFailed) {
              await this.send(result.message)
            }
          } catch (error) {
            const result = Result.fromError(error)
            await this.send(result.message)
          }
        }
      })
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`feishu channel failed: ${message}\n`)
    })
  }

  async receive(text: string): Promise<Result<null>> {
    if (text.trim().length === 0) {
      return Result.fail('text is required')
    }
    return Result.success(null)
  }

  async send(text: string): Promise<Result<null>> {
    if (text.trim().length === 0) {
      return Result.fail('text is required')
    }
    if (!this.client || this.chatIds.size === 0) {
      return Result.fail('feishu chat not ready')
    }
    for (const chatId of this.chatIds) {
      await this.client.im.v1.message.create({
        params: {
          receive_id_type: 'chat_id'
        },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({
            text
          })
        }
      })
    }
    return Result.success(null)
  }

  async stop(): Promise<Result<null>> {
    this.wsClient?.close()
    this.wsClient = undefined
    this.client = undefined
    return Result.success(null)
  }
}
