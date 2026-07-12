import * as Lark from '@larksuiteoapi/node-sdk'
import { inject, injectable } from 'inversify'
import { CodexioConfig } from '../../value/ConfigDefinition.js'
import { Result } from '../../value/Result.js'
import { Logger } from '../../component/Logger.js'
import { Configer } from '../../component/Configer.js'
import { parseFeishuMessage, shouldReceiveFeishuMessage, shouldReceiveFeishuSender } from '../../value/FeishuMessage.js'
import { ChannelInput, ChannelInputMessage, ChannelInputReceiver } from './ChannelInput.js'
import { FileStore } from '../../component/FileStore.js'

type FeishuChannelInputConfig = CodexioConfig['channeli']['feishu']
type FeishuMessageEvent = {
  sender?: {
    sender_id?: {
      open_id?: unknown
      user_id?: unknown
      union_id?: unknown
    }
  }
  message: {
    message_id?: unknown
    chat_id: string
    chat_type?: string
    message_type: string
    content: string
    mentions?: Array<{
      key: string
    }>
  } & {
    thread_id?: unknown
  }
}

type FeishuWsClientAdapter = {
  pullConnectConfig: () => Promise<{ ok: boolean }>
  wsConfig: {
    updateWs: (config: { connectUrl: string }) => void
  }
}

type FeishuWsClientOptions = ConstructorParameters<typeof Lark.WSClient>[0]
type FeishuOpenApiClientOptions = ConstructorParameters<typeof Lark.Client>[0]
type FeishuReplyMessageClient = {
  im: {
    v1: {
      message: {
        reply: (payload: {
          path: {
            message_id: string
          }
          data: {
            msg_type: 'text'
            content: string
            reply_in_thread: true
          }
        }) => Promise<unknown>
      }
    }
  }
}

type FeishuResourceClient = {
  im: {
    v1: {
      messageResource: {
        get: (payload: {
          params: { type: string }
          path: { message_id: string, file_key: string }
        }) => Promise<{
          getReadableStream: () => NodeJS.ReadableStream
          headers: Record<string, unknown>
        }>
      }
    }
  }
}

@injectable()
export class FeishuChannelInput implements ChannelInput {
  readonly type = 'feishu'
  private inputConfig?: FeishuChannelInputConfig
  private wsClient?: Lark.WSClient
  private openApiClient?: Lark.Client
  private receiver?: ChannelInputReceiver
  private chatId = ''
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private stopped = true
  private reconnectDelayMs = 1000

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(FileStore) private readonly fileStore: FileStore
  ) {}

  async start(receiver: ChannelInputReceiver): Promise<boolean> {
    this.inputConfig = await this.configer.get('channeli.feishu')
    if (!this.inputConfig?.enabled) {
      return false
    }
    this.receiver = receiver
    this.chatId = this.inputConfig.chatId?.trim() ?? ''
    this.openApiClient = this.createOpenApiClient({
      appId: this.inputConfig.appId,
      appSecret: this.inputConfig.appSecret
    })
    this.stopped = false
    await this.connect().catch((error) => {
      Logger.warn('feishu ws input initial connect failed', {
        message: error instanceof Error ? error.message : String(error)
      })
      this.scheduleReconnect()
    })
    return true
  }

  async stop(): Promise<Result<void>> {
    Logger.info('feishu ws input stopping')
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.wsClient?.close()
    this.wsClient = undefined
    this.openApiClient = undefined
    this.receiver = undefined
    this.chatId = ''
    this.inputConfig = undefined
    return Result.successVoid()
  }

  private async connect(): Promise<void> {
    if (!this.inputConfig?.enabled || this.stopped) {
      return
    }
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
    const wsClient = this.createWsClient({
      appId: this.inputConfig.appId,
      appSecret: this.inputConfig.appSecret,
      loggerLevel: Lark.LoggerLevel.warn,
      autoReconnect: true,
      handshakeTimeoutMs: 15000,
      onReady: () => {
        Logger.info('feishu ws input connected')
        ready()
      },
      onReconnecting: () => {
        Logger.warn('feishu ws input reconnecting')
      },
      onReconnected: () => {
        Logger.info('feishu ws input reconnected')
      },
      onError: (error) => {
        Logger.warn('feishu ws input error', {
          message: error.message
        })
        if (this.wsClient === wsClient) {
          wsClient.close()
          this.wsClient = undefined
        }
        this.scheduleReconnect()
        failed(error)
      }
    })
    const ws = this.inputConfig.ws?.trim()
    if (ws && ws.length > 0) {
      const wsClientAdapter = wsClient as unknown as FeishuWsClientAdapter
      const pullConnectConfig = wsClientAdapter.pullConnectConfig.bind(wsClientAdapter)
      wsClientAdapter.pullConnectConfig = async () => {
        const result = await pullConnectConfig()
        if (result.ok) {
          wsClientAdapter.wsConfig.updateWs({
            connectUrl: ws
          })
        }
        return result
      }
    }
    this.wsClient = wsClient
    await wsClient.start({
      eventDispatcher: new Lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data) => {
          await this.receive(data)
        }
      })
    })
    await connected
  }

  protected createWsClient(options: FeishuWsClientOptions): Lark.WSClient {
    return new Lark.WSClient(options)
  }

  protected createOpenApiClient(options: FeishuOpenApiClientOptions): Lark.Client {
    return new Lark.Client(options)
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.inputConfig?.enabled || this.reconnectTimer) {
      return
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.wsClient?.close()
      this.wsClient = undefined
      void this.connect().catch((error) => {
        Logger.warn('feishu ws input reconnect failed', {
          message: error instanceof Error ? error.message : String(error)
        })
        this.scheduleReconnect()
      })
    }, this.reconnectDelayMs)
  }

  private async receive(data: FeishuMessageEvent): Promise<void> {
    const chatId = typeof data.message.chat_id === 'string' && data.message.chat_id.trim().length > 0 ? data.message.chat_id.trim() : 'unknown'
    const feishuMessage = data.message as { thread_id?: unknown }
    const feishuThreadId = typeof feishuMessage.thread_id === 'string' && feishuMessage.thread_id.trim().length > 0 ? feishuMessage.thread_id.trim() : ''
    const messageId = typeof data.message.message_id === 'string' && data.message.message_id.trim().length > 0 ? data.message.message_id.trim() : ''
    const sender = readFeishuSender(data)
    try {
      const parsedMessage = parseFeishuMessage(data.message.message_type, data.message.content, data.message.mentions ?? [])
      if (!parsedMessage.success && parsedMessage.reason === 'unsupported') {
        Logger.warn('feishu message unsupported', {
          type: data.message.message_type
        })
        return
      }
      if (!parsedMessage.success) {
        Logger.warn('feishu message parse failed')
        return
      }
      const bindMatch = /^[￥$]bind(?:\s+(\S+))?\s*$/i.exec(parsedMessage.text.trim())
      const isBindCommand = bindMatch !== null
      if (this.chatId.length > 0 && data.message.chat_id !== this.chatId && !isBindCommand) {
        Logger.info('feishu chat ignored', {
          chatId: data.message.chat_id
        })
        return
      }
      if (this.chatId.length === 0 && !isBindCommand) {
        Logger.info('feishu message ignored', {
          chatId: data.message.chat_id,
          reason: 'bind required'
        })
        return
      }
      if (!shouldReceiveFeishuSender(sender.openId, this.inputConfig?.allowedOpenIds ?? [])) {
        Logger.info('feishu message ignored', {
          chatId: data.message.chat_id,
          reason: 'sender not allowed',
          openId: sender.openId
        })
        return
      }
      if (isBindCommand) {
        const normalizedChatId = data.message.chat_id.trim()
        const normalizedOpenId = sender.openId?.trim() ?? ''
        const openApiClient = this.openApiClient
        if (normalizedChatId.length === 0 || normalizedOpenId.length === 0) {
          Logger.warn('feishu bind failed', {
            chatId: normalizedChatId,
            openId: normalizedOpenId,
            reason: 'identity missing'
          })
          return
        }
        const config = await this.configer.get('channeli.feishu')
        const appId = await this.configer.get('app.id')
        if (appId.trim().length === 0 || (bindMatch[1]?.trim() ?? '') !== appId.trim()) {
          Logger.warn('feishu bind failed', {
            chatId: normalizedChatId,
            openId: normalizedOpenId,
            reason: 'app id mismatch'
          })
          if (openApiClient && messageId.length > 0) {
            await (openApiClient as unknown as FeishuReplyMessageClient).im.v1.message.reply({
              path: {
                message_id: messageId
              },
              data: {
                msg_type: 'text',
                content: JSON.stringify({
                  text: 'Codexio 飞书群聊绑定失败：绑定口令不正确'
                }),
                reply_in_thread: true
              }
            })
          }
          return
        }
        const allowedOpenIds = config.allowedOpenIds.map((item) => item.trim()).filter((item) => item.length > 0)
        const nextAllowedOpenIds = allowedOpenIds.includes(normalizedOpenId) ? allowedOpenIds : [
          ...allowedOpenIds,
          normalizedOpenId
        ]
        await this.configer.patch({
          channeli: {
            feishu: {
              chatId: normalizedChatId,
              allowedOpenIds: nextAllowedOpenIds
            }
          },
          channelo: {
            feishu: {
              enabled: true,
              chatId: normalizedChatId
            }
          }
        })
        this.chatId = normalizedChatId
        this.inputConfig = {
          ...config,
          chatId: normalizedChatId,
          allowedOpenIds: nextAllowedOpenIds
        }
        Logger.info('feishu input bound', {
          chatId: normalizedChatId,
          openId: normalizedOpenId
        })
        if (openApiClient && messageId.length > 0) {
          await (openApiClient as unknown as FeishuReplyMessageClient).im.v1.message.reply({
            path: {
              message_id: messageId
            },
            data: {
              msg_type: 'text',
              content: JSON.stringify({
                text: 'Codexio 飞书群聊已绑定'
              }),
              reply_in_thread: true
            }
          })
        } else {
          Logger.warn('feishu bind reply skipped', {
            chatId: normalizedChatId,
            reason: 'message identity missing'
          })
        }
        return
      }
      if (messageId.length === 0) {
        Logger.warn('feishu message identity missing', {
          chatId
        })
        return
      }
      const channelThreadId = {
        source: 'feishu' as const,
        id: feishuThreadId.length > 0 ? `${chatId}:thread:${feishuThreadId}` : `${chatId}:chat`
      }
      if (!shouldReceiveFeishuMessage(data.message.chat_type, data.message.mentions, this.inputConfig?.aite ?? true)) {
        Logger.info('feishu message ignored', {
          chatId: data.message.chat_id,
          reason: 'aite required'
        })
        return
      }
      Logger.info('feishu message received', {
        chatId,
        chatType: data.message.chat_type ?? null,
        feishuThreadId: feishuThreadId || null,
        channelThreadId: channelThreadId.id,
        sourceMessageId: messageId,
        mentioned: Boolean(data.message.mentions?.some((mention) => mention.key.trim().length > 0)),
        length: parsedMessage.text.length,
        resources: parsedMessage.resources.length
      })
      const receiver = this.receiver
      if (!receiver) {
        Logger.warn('feishu message receive failed', {
          message: 'feishu channel is disabled'
        })
        return
      }
      const files = []
      for (const resource of parsedMessage.resources) {
        const downloaded = await (this.openApiClient as unknown as FeishuResourceClient).im.v1.messageResource.get({
          params: {
            type: resource.type
          },
          path: {
            message_id: messageId,
            file_key: resource.key
          }
        })
        const chunks: Buffer[] = []
        for await (const chunk of downloaded.getReadableStream()) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        }
        const contentType = downloaded.headers['content-type']
        files.push(await this.fileStore.importBuffer({
          buffer: Buffer.concat(chunks),
          name: resource.name,
          mime: typeof contentType === 'string' ? contentType : undefined
        }))
      }
      void receiver.receive('feishu', {
        channelThreadId,
        sourceMessageId: messageId,
        text: parsedMessage.text,
        files,
        mentioned: Boolean(data.message.mentions?.some((mention) => mention.key.trim().length > 0)),
        sender
      }).then((result) => {
        if (result.isFailed) {
          Logger.warn('feishu message receive failed', {
            message: result.message
          })
          return
        }
        Logger.info('feishu message routed', {
          chatId,
          feishuThreadId: feishuThreadId || null,
          channelThreadId: channelThreadId.id,
          sourceMessageId: messageId,
          ioThreadId: result.data?.ioThreadId ?? null
        })
      }).catch((error) => {
        Logger.error('feishu message receive crashed', error)
      })
    } catch (error) {
      Logger.error('feishu event failed', error)
    }
  }
}

function readFeishuSender(data: FeishuMessageEvent): NonNullable<ChannelInputMessage['sender']> {
  const senderId = data.sender?.sender_id
  return {
    openId: typeof senderId?.open_id === 'string' ? senderId.open_id.trim() : '',
    userId: typeof senderId?.user_id === 'string' ? senderId.user_id.trim() : '',
    unionId: typeof senderId?.union_id === 'string' ? senderId.union_id.trim() : ''
  }
}
