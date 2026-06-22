import * as Lark from '@larksuiteoapi/node-sdk'
import { z } from 'zod'
import { CodexioConfig } from '../config/ConfigDefinition.js'
import { Channel, ChannelInput, ChannelMessage, ChannelReceiveResult } from './Channel.js'
import { Result } from '../value/Result.js'
import { Logger } from '../component/Logger.js'
import { FeishuMessageSender } from './FeishuMessageSender.js'

const FeishuTextContentSchema = z.object({
  text: z.string()
})

type FeishuChannelConfig = CodexioConfig['channels']['feishu']

export class FeishuChannel implements Channel {
  readonly type = 'feishu'
  private config?: FeishuChannelConfig
  private wsClient?: Lark.WSClient
  private sender?: FeishuMessageSender
  private chatId = ''

  constructor(private readonly receive: (input: ChannelInput) => Promise<Result<ChannelReceiveResult>>) {}

  start(config: CodexioConfig): void {
    this.config = config.channels.feishu
    if (!this.config?.appId || !this.config.appSecret) {
      throw new Error('feishu appId and appSecret are required')
    }
    Logger.info('feishu channel starting', {
      chatId: this.config.chatId?.trim() ?? '',
      wsEnabled: Boolean(this.config.ws?.trim())
    })
    this.chatId = this.config.chatId?.trim() ?? ''
    this.sender = new FeishuMessageSender(this.config)
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
              this.sender?.updateChatId(data.message.chat_id)
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
            Logger.info('feishu message received', {
              chatId: data.message.chat_id,
              length: text.length
            })
            void this.receive({
              text
            }).then(async (result) => {
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
    if (message.text.trim().length === 0 && (!message.files || message.files.length === 0)) {
      return Result.fail('text or file is required')
    }
    if (!this.sender) {
      return Result.fail('feishu client not ready')
    }
    if (this.chatId.length === 0) {
      return Result.fail('feishu chat not ready')
    }
    return this.sender.send(message)
  }

  async stop(): Promise<Result<null>> {
    Logger.info('feishu channel stopping')
    this.wsClient?.close()
    this.wsClient = undefined
    this.sender = undefined
    return Result.success(null)
  }
}
