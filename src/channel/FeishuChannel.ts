import * as Lark from '@larksuiteoapi/node-sdk'
import { inject, injectable } from 'inversify'
import { CodexioConfig } from '../value/ConfigDefinition.js'
import { Message } from '../value/Message.js'
import { Result } from '../value/Result.js'
import { Logger } from '../component/Logger.js'
import { FeishuMessageSender } from './FeishuMessageSender.js'
import { ThreadBinder } from '../value/ThreadBinder.js'
import { Configer } from '../component/Configer.js'
import { ChannelInput, ChannelInputReceive, ChannelOutput, ChannelOutputContext } from './Channel.js'
import { parseFeishuMessageText } from './FeishuMessageContent.js'

type FeishuChannelConfig = CodexioConfig['channels']['feishu']
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
export class FeishuChannelHub {
  private config?: FeishuChannelConfig
  private wsClient?: Lark.WSClient
  private sender?: FeishuMessageSender
  private chatId = ''
  private readonly threads = new ThreadBinder()

  constructor(@inject(Configer) private readonly configer: Configer) {}

  async startOutput(): Promise<boolean> {
    this.config = await this.configer.get('channels.feishu')
    if (!this.config?.enabled) {
      return false
    }
    if (!this.config?.appId || !this.config.appSecret) {
      throw new Error('feishu appId and appSecret are required')
    }
    Logger.info('feishu output starting', {
      chatId: this.config.chatId?.trim() ?? ''
    })
    this.chatId = this.config.chatId?.trim() ?? ''
    this.sender = new FeishuMessageSender(this.config)
    return true
  }

  async startInput(receive: ChannelInputReceive): Promise<boolean> {
    if (!await this.startOutput()) {
      return false
    }
    Logger.info('feishu input starting', {
      chatId: this.config?.chatId?.trim() ?? '',
      wsEnabled: Boolean(this.config?.ws?.trim())
    })
    let ready: () => void
    let failed: (error: Error) => void
    const connected = new Promise<void>((resolve, reject) => {
      ready = resolve
      failed = reject
    })
    this.wsClient = new Lark.WSClient({
      appId: this.config?.appId ?? '',
      appSecret: this.config?.appSecret ?? '',
      loggerLevel: Lark.LoggerLevel.warn,
      autoReconnect: false,
      handshakeTimeoutMs: 15000,
      onReady: () => {
        Logger.info('feishu input connected')
        ready()
      },
      onError: (error) => {
        failed(error)
      }
    })
    const ws = this.config?.ws?.trim()
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
          await this.receive(data, receive)
        }
      })
    })
    await connected
    return true
  }

  async send(message: Message, context?: ChannelOutputContext): Promise<Result<void>> {
    if (message.role === 'user' && context?.inputType === 'feishu') {
      return Result.successVoid()
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

  async stop(): Promise<Result<void>> {
    Logger.info('feishu channel stopping')
    this.wsClient?.close()
    this.wsClient = undefined
    this.sender = undefined
    return Result.successVoid()
  }

  private async receive(data: FeishuMessageEvent, receive: ChannelInputReceive): Promise<void> {
    const chatId = typeof data.message.chat_id === 'string' && data.message.chat_id.trim().length > 0 ? data.message.chat_id.trim() : 'unknown'
    const feishuMessage = data.message as {
      message_id?: unknown
      root_id?: unknown
      thread_id?: unknown
    }
    const feishuThreadId = typeof feishuMessage.thread_id === 'string' && feishuMessage.thread_id.trim().length > 0 ? feishuMessage.thread_id.trim() : ''
    const feishuMessageId = typeof feishuMessage.message_id === 'string' && feishuMessage.message_id.trim().length > 0 ? feishuMessage.message_id.trim() : ''
    const feishuRootId = typeof feishuMessage.root_id === 'string' && feishuMessage.root_id.trim().length > 0 ? feishuMessage.root_id.trim() : ''
    const feishuReplyTargetMessageId = feishuRootId || feishuMessageId
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
    const ioThreadId = this.threads.resolveOrCreate(feishuEntities)
    try {
      if (this.chatId.length === 0) {
        this.chatId = data.message.chat_id
        Logger.info('feishu chat connected', {
          chatId: data.message.chat_id
        })
        this.sender?.updateChatId(data.message.chat_id)
        this.sender?.rememberThread(ioThreadId, feishuReplyTargetMessageId)
      }
      if (data.message.chat_id !== this.chatId) {
        Logger.info('feishu chat ignored', {
          chatId: data.message.chat_id
        })
        return
      }
      this.threads.bind(ioThreadId, feishuEntities)
      this.sender?.rememberThread(ioThreadId, feishuReplyTargetMessageId)
      const parsedText = parseFeishuMessageText(data.message.message_type, data.message.content, data.message.mentions ?? [])
      if (!parsedText.success && parsedText.reason === 'unsupported') {
        Logger.warn('feishu message unsupported', {
          type: data.message.message_type
        })
        await this.send({
          ioThreadId,
          role: 'system',
          text: '当前只支持文本消息'
        })
        return
      }
      if (!parsedText.success) {
        Logger.warn('feishu message parse failed')
        await this.send({
          ioThreadId,
          role: 'system',
          text: '消息文本为空'
        })
        return
      }
      Logger.info('feishu message received', {
        chatId: data.message.chat_id,
        length: parsedText.text.length
      })
      void receive({
        ioThreadId,
        role: 'user',
        text: parsedText.text
      }).then(async (result) => {
        if (result.isFailed) {
          Logger.warn('feishu message receive failed', {
            message: result.message
          })
          await this.send({
            ioThreadId,
            role: 'system',
            text: result.message
          })
        }
      }).catch(async (error) => {
        const result = Result.fromError(error)
        Logger.error('feishu message receive crashed', error)
        await this.send({
          ioThreadId,
          role: 'system',
          text: result.message
        })
      })
    } catch (error) {
      const result = Result.fromError(error)
      Logger.error('feishu event failed', error)
      await this.send({
        ioThreadId,
        role: 'system',
        text: result.message
      })
    }
  }
}

@injectable()
export class FeishuChannelInput implements ChannelInput {
  readonly type = 'feishu'

  constructor(@inject(FeishuChannelHub) private readonly hub: FeishuChannelHub) {}

  async start(receive: ChannelInputReceive): Promise<boolean> {
    return this.hub.startInput(receive)
  }

  async stop(): Promise<Result<void>> {
    return this.hub.stop()
  }
}

@injectable()
export class FeishuChannelOutput implements ChannelOutput {
  readonly type = 'feishu'

  constructor(@inject(FeishuChannelHub) private readonly hub: FeishuChannelHub) {}

  async start(): Promise<boolean> {
    return this.hub.startOutput()
  }

  async send(message: Message, context?: ChannelOutputContext): Promise<Result<void>> {
    return this.hub.send(message, context)
  }

  async stop(): Promise<Result<void>> {
    return this.hub.stop()
  }
}
