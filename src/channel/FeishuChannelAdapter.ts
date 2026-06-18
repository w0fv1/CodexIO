import * as Lark from '@larksuiteoapi/node-sdk'
import { z } from 'zod'
import { ChannelAdapter, ChannelMessage, ChannelStartInput } from './ChannelAdapter.js'
import { Result } from '../Result.js'

const FeishuTextContentSchema = z.object({
  text: z.string()
})

type FeishuMessagePayload = {
  msgType: string
  content: string
}

export type FeishuChannelConfig = {
  enabled?: boolean
  appId?: string
  appSecret?: string
  chatId?: string
  ws?: string
}

export function createFeishuMessagePayload(message: ChannelMessage): FeishuMessagePayload {
  let text = message.text
  if (message.role === 'system' && message.text === 'clear') {
    text = '已开始新对话'
  }
  const content: Array<Array<Record<string, string>>> = [
    [
      {
        tag: 'md',
        text
      }
    ]
  ]
  if (message.role === 'user') {
    content.push([
      {
        tag: 'text',
        text: 'User'
      }
    ])
  }
  return {
    msgType: 'post',
    content: JSON.stringify({
      zh_cn: {
        content
      }
    })
  }
}

export class FeishuChannelAdapter implements ChannelAdapter {
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
              process.stdout.write(`feishu chat connected: ${data.message.chat_id}\n`)
            }
            if (data.message.chat_id !== this.chatId) {
              process.stdout.write(`feishu chat ignored: ${data.message.chat_id}\n`)
              return
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
    } catch (error) {
      return Result.fromError(error)
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
