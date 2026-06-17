import * as Lark from '@larksuiteoapi/node-sdk'
import { z } from 'zod'
import { ChannelAdapter, ChannelMessage, ChannelStartInput } from './ChannelAdapter.js'
import { Result } from '../Result.js'

const FeishuTextContentSchema = z.object({
  text: z.string()
})

export type FeishuChannelConfig = {
  enabled?: boolean
  appId?: string
  appSecret?: string
  chatIds?: string[]
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
    for (const chatId of this.config.chatIds ?? []) {
      if (chatId.trim().length > 0) {
        this.chatIds.add(chatId)
      }
    }
    this.wsClient = new Lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: Lark.LoggerLevel.warn
    })
    void this.wsClient.start({
      eventDispatcher: new Lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data) => {
          try {
            if (!this.chatIds.has(data.message.chat_id)) {
              this.chatIds.add(data.message.chat_id)
              process.stdout.write(`feishu chat connected: ${data.message.chat_id}\n`)
            }
            if (data.message.message_type !== 'text') {
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
              await this.send({
                role: 'system',
                text: 'feishu channel not started',
                createdAt: Date.now(),
                source: this.type
              })
              return
            }
            const result = await this.input.receive(text)
            if (result.isFailed) {
              await this.send({
                role: 'system',
                text: result.message,
                createdAt: Date.now(),
                source: this.type
              })
            }
          } catch (error) {
            const result = Result.fromError(error)
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
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`feishu channel failed: ${message}\n`)
    })
  }

  async send(message: ChannelMessage): Promise<Result<null>> {
    if (message.role === 'human' && message.source === this.type) {
      return Result.success(null)
    }
    if (message.text.trim().length === 0) {
      return Result.fail('text is required')
    }
    if (!this.client) {
      return Result.fail('feishu client not ready')
    }
    if (this.chatIds.size === 0) {
      return Result.fail('feishu chat not ready')
    }
    const failures: string[] = []
    for (const chatId of this.chatIds) {
      try {
        let text = message.text
        if (message.role === 'system' && message.text === 'clear') {
          text = '已开始新对话'
        }
        let msgType = 'post'
        let content = JSON.stringify({
          zh_cn: {
            title: 'Codexio',
            content: [
              [
                {
                  tag: 'md',
                  text
                }
              ]
            ]
          }
        })
        if (message.role === 'human') {
          msgType = 'text'
          content = JSON.stringify({
            text
          })
        }
        await this.client.im.v1.message.create({
          params: {
            receive_id_type: 'chat_id'
          },
          data: {
            receive_id: chatId,
            msg_type: msgType,
            content
          }
        })
      } catch (error) {
        const failed = Result.fromError(error)
        failures.push(`${chatId}: ${failed.message}`)
      }
    }
    if (failures.length === this.chatIds.size) {
      return Result.fail(failures.join('\n'))
    }
    if (failures.length > 0) {
      process.stderr.write(`feishu send partially failed: ${failures.join('\n')}\n`)
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
