import * as Lark from '@larksuiteoapi/node-sdk'
import { inject, injectable } from 'inversify'
import { CodexioConfig } from '../../value/ConfigDefinition.js'
import { Result } from '../../value/Result.js'
import { Logger } from '../../component/Logger.js'
import { Configer } from '../../component/Configer.js'
import { parseFeishuMessageText } from '../../value/FeishuMessage.js'
import { ChannelInput, ChannelInputReceiver } from './ChannelInput.js'

type FeishuChannelInputConfig = CodexioConfig['channeli']['feishu']
type FeishuMessageEvent = {
  message: {
    chat_id: string
    message_type: string
    content: string
    mentions?: Array<{
      key: string
    }>
  } & {
    message_id?: unknown
    root_id?: unknown
    thread_id?: unknown
  }
}

type FeishuWsClientAdapter = {
  pullConnectConfig: () => Promise<{ ok: boolean }>
  wsConfig: {
    updateWs: (config: { connectUrl: string }) => void
  }
}

@injectable()
export class FeishuChannelInput implements ChannelInput {
  readonly type = 'feishu'
  private inputConfig?: FeishuChannelInputConfig
  private wsClient?: Lark.WSClient
  private receiver?: ChannelInputReceiver
  private chatId = ''

  constructor(
    @inject(Configer) private readonly configer: Configer
  ) {}

  async start(receiver: ChannelInputReceiver): Promise<boolean> {
    this.inputConfig = await this.configer.get('channeli.feishu')
    if (!this.inputConfig?.enabled) {
      return false
    }
    this.receiver = receiver
    Logger.info('feishu ws input starting', {
      chatId: this.inputConfig.chatId?.trim() ?? '',
      wsEnabled: Boolean(this.inputConfig.ws?.trim())
    })
    let ready: () => void
    let failed: (error: Error) => void
    const connected = new Promise<void>((resolve, reject) => {
      ready = resolve
      failed = reject
    })
    this.wsClient = new Lark.WSClient({
      appId: this.inputConfig.appId,
      appSecret: this.inputConfig.appSecret,
      loggerLevel: Lark.LoggerLevel.warn,
      autoReconnect: false,
      handshakeTimeoutMs: 15000,
      onReady: () => {
        Logger.info('feishu ws input connected')
        ready()
      },
      onError: (error) => {
        failed(error)
      }
    })
    const ws = this.inputConfig.ws?.trim()
    if (ws && ws.length > 0) {
      const wsClient = this.wsClient as unknown as FeishuWsClientAdapter
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
    await this.wsClient.start({
      eventDispatcher: new Lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data) => {
          await this.receive(data)
        }
      })
    })
    await connected
    return true
  }

  async stop(): Promise<Result<void>> {
    Logger.info('feishu ws input stopping')
    this.wsClient?.close()
    this.wsClient = undefined
    this.receiver = undefined
    return Result.successVoid()
  }

  private async receive(data: FeishuMessageEvent): Promise<void> {
    const chatId = typeof data.message.chat_id === 'string' && data.message.chat_id.trim().length > 0 ? data.message.chat_id.trim() : 'unknown'
    const feishuMessage = data.message as {
      message_id?: unknown
      root_id?: unknown
      thread_id?: unknown
    }
    const feishuThreadId = typeof feishuMessage.thread_id === 'string' && feishuMessage.thread_id.trim().length > 0 ? feishuMessage.thread_id.trim() : ''
    const feishuMessageId = typeof feishuMessage.message_id === 'string' && feishuMessage.message_id.trim().length > 0 ? feishuMessage.message_id.trim() : ''
    const feishuRootId = typeof feishuMessage.root_id === 'string' && feishuMessage.root_id.trim().length > 0 ? feishuMessage.root_id.trim() : ''
    const feishuEntities = [
      feishuThreadId.length > 0 ? `${chatId}:thread:${feishuThreadId}` : '',
      feishuRootId.length > 0 ? `${chatId}:message:${feishuRootId}` : '',
      feishuMessageId.length > 0 ? `${chatId}:message:${feishuMessageId}` : ''
    ].filter((value) => value.length > 0)
    if (feishuEntities.length === 0) {
      Logger.warn('feishu message identity missing', {
        chatId
      })
      return
    }
    const feishuThreadIds = feishuEntities.map((id) => ({
      source: 'feishu' as const,
      id
    }))
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
      const parsedText = parseFeishuMessageText(data.message.message_type, data.message.content, data.message.mentions ?? [])
      if (!parsedText.success && parsedText.reason === 'unsupported') {
        Logger.warn('feishu message unsupported', {
          type: data.message.message_type
        })
        return
      }
      if (!parsedText.success) {
        Logger.warn('feishu message parse failed')
        return
      }
      Logger.info('feishu message received', {
        chatId: data.message.chat_id,
        length: parsedText.text.length
      })
      const receiver = this.receiver
      if (!receiver) {
        Logger.warn('feishu message receive failed', {
          message: 'feishu channel is disabled'
        })
        return
      }
      void receiver.receive('feishu', {
        platformThreadIds: feishuThreadIds as [typeof feishuThreadIds[number], ...typeof feishuThreadIds[number][]],
        text: parsedText.text
      }).then((result) => {
        if (result.isFailed) {
          Logger.warn('feishu message receive failed', {
            message: result.message
          })
        }
      }).catch((error) => {
        Logger.error('feishu message receive crashed', error)
      })
    } catch (error) {
      Logger.error('feishu event failed', error)
    }
  }
}
