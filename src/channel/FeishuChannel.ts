import * as Lark from '@larksuiteoapi/node-sdk'
import { z } from 'zod'
import { Channel, ChannelMessage, ChannelStartInput } from './Channel.js'
import { Result } from '../value/Result.js'
import { Logger } from '../component/Logger.js'
import { createFeishuMessagePayload } from './ChannelUtil.js'

const FeishuTextContentSchema = z.object({
  text: z.string()
})

export type FeishuChannelConfig = {
  enabled?: boolean
  appId?: string
  appSecret?: string
  chatId?: string
  ws?: string
}

export class FeishuChannel implements Channel {
  readonly type = 'feishu'
  private input?: ChannelStartInput
  private client?: Lark.Client
  private wsClient?: Lark.WSClient
  private chatId = ''

  constructor(private readonly config?: FeishuChannelConfig) {}

  start(input: ChannelStartInput): void {
    this.input = input
    if (!this.config?.appId || !this.config.appSecret) {
      throw new Error('feishu appId and appSecret are required')
    }
    Logger.info('feishu channel starting', {
      chatId: this.config.chatId?.trim() ?? '',
      wsEnabled: Boolean(this.config.ws?.trim())
    })
    this.client = new Lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret
    })
    this.chatId = this.config.chatId?.trim() ?? ''
    this.wsClient = new Lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: Lark.LoggerLevel.warn
    })
    const ws = this.config.ws?.trim()
    if (ws && ws.length > 0) {
      const wsClient = this.wsClient as unknown as {
        pullConnectConfig: () => Promise<{ ok: boolean }>
        wsConfig: {
          updateWs: (config: { connectUrl: string }) => void
        }
      }
      const pullConnectConfig = wsClient.pullConnectConfig.bind(wsClient)
      wsClient.pullConnectConfig = async () => {
        const result = await pullConnectConfig()
        if (result.ok) {
          wsClient.wsConfig.updateWs({
            connectUrl: ws
          })
        }
        return result
      }
    }
    void this.wsClient.start({
      eventDispatcher: new Lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data) => {
          try {
            if (this.chatId.length === 0) {
              this.chatId = data.message.chat_id
              Logger.info('feishu chat connected', {
                chatId: data.message.chat_id
              })
            }
            if (data.message.chat_id !== this.chatId) {
              Logger.info('feishu chat ignored', {
                chatId: data.message.chat_id
              })
              return
            }
            if (data.message.message_type !== 'text') {
              Logger.warn('feishu message unsupported', {
                type: data.message.message_type
              })
              await this.send({
                role: 'system',
                text: '当前只支持文本消息',
                createdAt: Date.now(),
                source: this.type
              })
              return
            }
            const content = FeishuTextContentSchema.safeParse(JSON.parse(data.message.content))
            if (!content.success) {
              Logger.warn('feishu message parse failed')
              await this.send({
                role: 'system',
                text: '消息文本为空',
                createdAt: Date.now(),
                source: this.type
              })
              return
            }
            let text = content.data.text
            for (const mention of data.message.mentions ?? []) {
              text = text.replaceAll(mention.key, '')
            }
            if (!this.input) {
              Logger.warn('feishu channel input missing')
              await this.send({
                role: 'system',
                text: 'feishu channel not started',
                createdAt: Date.now(),
                source: this.type
              })
              return
            }
            Logger.info('feishu message received', {
              chatId: data.message.chat_id,
              length: text.length
            })
            void this.input.receive(text).then(async (result) => {
              if (result.isFailed) {
                Logger.warn('feishu message receive failed', {
                  message: result.message
                })
                await this.send({
                  role: 'system',
                  text: result.message,
                  createdAt: Date.now(),
                  source: this.type
                })
              }
            }).catch(async (error) => {
              const result = Result.fromError(error)
              Logger.error('feishu message receive crashed', error)
              await this.send({
                role: 'system',
                text: result.message,
                createdAt: Date.now(),
                source: this.type
              })
            })
          } catch (error) {
            const result = Result.fromError(error)
            Logger.error('feishu event failed', error)
            await this.send({
              role: 'system',
              text: result.message,
              createdAt: Date.now(),
              source: this.type
            })
          }
        }
      })
    }).catch((error) => {
      Logger.error('feishu channel failed', error)
    })
  }

  async send(message: ChannelMessage): Promise<Result<null>> {
    if (message.role === 'user' && message.source === this.type) {
      return Result.success(null)
    }
    if (message.text.trim().length === 0) {
      return Result.fail('text is required')
    }
    if (!this.client) {
      return Result.fail('feishu client not ready')
    }
    if (this.chatId.length === 0) {
      return Result.fail('feishu chat not ready')
    }
    try {
      const payload = createFeishuMessagePayload(message)
      Logger.info('feishu send started', {
        role: message.role,
        source: message.source ?? null,
        length: message.text.length
      })
      await this.client.im.v1.message.create({
        params: {
          receive_id_type: 'chat_id'
        },
        data: {
          receive_id: this.chatId,
          msg_type: payload.msgType,
          content: payload.content
        }
      })
      Logger.info('feishu send completed', {
        role: message.role
      })
    } catch (error) {
      Logger.error('feishu send failed', error)
      return Result.fromError(error)
    }
    return Result.success(null)
  }

  async stop(): Promise<Result<null>> {
    Logger.info('feishu channel stopping')
    this.wsClient?.close()
    this.wsClient = undefined
    this.client = undefined
    return Result.success(null)
  }
}
