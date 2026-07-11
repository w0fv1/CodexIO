import * as Lark from '@larksuiteoapi/node-sdk'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { inject, injectable } from 'inversify'
import { CodexioConfig } from '../../value/ConfigDefinition.js'
import { Message } from '../../value/Message.js'
import { Result } from '../../value/Result.js'
import { Logger } from '../Logger.js'
import { Configer } from '../Configer.js'
import { isImageFile } from '../FileStore.js'
import { ThreadRegistry } from '../ThreadRegistry.js'
import { ChannelOutput, ChannelOutputContext } from './ChannelOutput.js'
import { deriveExternalDeliveryId } from './ExternalDeliveryIdentity.js'

type FeishuChannelOutputConfig = CodexioConfig['channelo']['feishu']
type FeishuCreateMessagePayload = {
  params: {
    receive_id_type: 'open_id' | 'user_id' | 'union_id' | 'email' | 'chat_id'
  }
  data: {
    receive_id: string
    msg_type: string
    content: string
    uuid?: string
  }
}
type FeishuCreateMessageClient = {
  im: {
    v1: {
      message: {
        list: (payload: {
          params: {
            container_id_type: 'thread'
            container_id: string
            sort_type: 'ByCreateTimeDesc'
            page_size: 1
          }
        }) => Promise<{
          data?: {
            items?: Array<{
              message_id?: string
              thread_id?: string
            }>
          }
        }>
        create: (payload: FeishuCreateMessagePayload) => Promise<{
          data?: {
            message_id?: string
            thread_id?: string
          }
        }>
        reply: (payload: {
          path: {
            message_id: string
          }
          data: {
            msg_type: string
            content: string
            reply_in_thread: true
            uuid?: string
          }
        }) => Promise<{
          data?: {
            message_id?: string
            thread_id?: string
          }
        }>
      }
    }
  }
}

@injectable()
export class FeishuChannelOutput implements ChannelOutput {
  readonly type = 'feishu'
  private config?: FeishuChannelOutputConfig
  private client?: Lark.Client
  private chatId = ''
  private readonly replyMessageIdByIoThreadId = new Map<string, string>()

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(ThreadRegistry) private readonly threadRegistry: ThreadRegistry
  ) {}

  async start(): Promise<boolean> {
    this.config = await this.configer.get('channelo.feishu')
    if (!this.config?.enabled) {
      return false
    }
    if (!this.config?.appId || !this.config.appSecret) {
      throw new Error('feishu appId and appSecret are required')
    }
    Logger.info('feishu openapi output starting', {
      chatId: this.config.chatId?.trim() ?? ''
    })
    this.client = new Lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret
    })
    this.chatId = this.config.chatId?.trim() ?? ''
    return true
  }

  async send(message: Message, context?: ChannelOutputContext): Promise<Result<void>> {
    if (message.role === 'user' && context?.source === 'feishu') {
      return Result.successVoid()
    }
    if (!this.client) {
      return Result.fail('feishu client not ready')
    }
    if (message.text.trim().length === 0 && (!message.files || message.files.length === 0)) {
      return Result.fail('text or file is required')
    }
    if (this.chatId.length === 0) {
      return Result.fail('feishu chat not ready')
    }
    try {
      const registeredFeishuThreadId = this.feishuThreadId(message.thread.id)
      Logger.info('feishu openapi send started', {
        messageId: message.id,
        ioThreadId: message.thread.id,
        role: message.role,
        contextSource: context?.source ?? null,
        sourceMessageId: context?.sourceMessageId ?? null,
        registeredFeishuThreadId: registeredFeishuThreadId ?? null,
        cachedReplyMessageId: this.replyMessageIdByIoThreadId.get(message.thread.id) ?? null,
        length: message.text.length,
        files: message.files?.length ?? 0
      })
      const images: Array<{ imageKey: string }> = []
      const files: Array<{ fileKey: string }> = []
      for (const file of message.files ?? []) {
        if (isImageFile(file)) {
          const image = await this.client.im.v1.image.create({
            data: {
              image_type: 'message',
              image: await readFile(file.path)
            }
          })
          if (!image?.image_key) {
            throw new Error('feishu image_key missing')
          }
          images.push({
            imageKey: image.image_key
          })
        } else {
          const extension = extname(file.name).toLowerCase()
          let fileType: 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' = 'stream'
          if (file.mime === 'audio/ogg' || file.mime === 'audio/opus' || extension === '.opus') {
            fileType = 'opus'
          } else if (file.mime === 'video/mp4' || extension === '.mp4') {
            fileType = 'mp4'
          } else if (file.mime === 'application/pdf' || extension === '.pdf') {
            fileType = 'pdf'
          } else if ([
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          ].includes(file.mime) || ['.doc', '.docx'].includes(extension)) {
            fileType = 'doc'
          } else if ([
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          ].includes(file.mime) || ['.xls', '.xlsx', '.csv'].includes(extension)) {
            fileType = 'xls'
          } else if ([
            'application/vnd.ms-powerpoint',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation'
          ].includes(file.mime) || ['.ppt', '.pptx'].includes(extension)) {
            fileType = 'ppt'
          }
          const uploadedFile = await this.client.im.v1.file.create({
            data: {
              file_type: fileType,
              file_name: file.name,
              file: await readFile(file.path)
            }
          })
          if (!uploadedFile?.file_key) {
            throw new Error('feishu file_key missing')
          }
          files.push({
            fileKey: uploadedFile.file_key
          })
        }
      }
      const content: Array<Array<Record<string, string>>> = []
      if (message.text.trim().length > 0) {
        content.push([
          {
            tag: 'md',
            text: message.text
          }
        ])
      }
      for (const image of images) {
        content.push([
          {
            tag: 'img',
            image_key: image.imageKey
          }
        ])
      }
      const outgoingMessages: Array<{ msgType: string, content: string }> = []
      if (content.length > 0) {
        outgoingMessages.push({
          msgType: 'post',
          content: JSON.stringify({
            zh_cn: {
              content
            }
          })
        })
      }
      for (const file of files) {
        outgoingMessages.push({
          msgType: 'file',
          content: JSON.stringify({
            file_key: file.fileKey
          })
        })
      }
      const sourceReplyMessageId = context?.source === 'feishu' ? context.sourceMessageId?.trim() : undefined
      let replyMessageId = sourceReplyMessageId || this.replyMessageIdByIoThreadId.get(message.thread.id)
      const messageClient = this.client as unknown as FeishuCreateMessageClient
      if (!replyMessageId && registeredFeishuThreadId) {
        Logger.info('feishu openapi resolving reply anchor', {
          messageId: message.id,
          ioThreadId: message.thread.id,
          registeredFeishuThreadId
        })
        const listed = await messageClient.im.v1.message.list({
          params: {
            container_id_type: 'thread',
            container_id: registeredFeishuThreadId,
            sort_type: 'ByCreateTimeDesc',
            page_size: 1
          }
        })
        replyMessageId = listed.data?.items
          ?.find((item) => item.thread_id?.trim() === registeredFeishuThreadId)
          ?.message_id?.trim()
        if (!replyMessageId) {
          throw new Error('feishu thread reply message not found')
        }
        this.replyMessageIdByIoThreadId.set(message.thread.id, replyMessageId)
        Logger.info('feishu openapi resolved reply anchor', {
          messageId: message.id,
          ioThreadId: message.thread.id,
          registeredFeishuThreadId,
          replyMessageId
        })
      }
      for (const [index, outgoingMessage] of outgoingMessages.entries()) {
        const uuid = deriveExternalDeliveryId('feishu', message, String(index))
        if (replyMessageId) {
          Logger.info('feishu openapi replying message', {
            messageId: message.id,
            ioThreadId: message.thread.id,
            replyMessageId,
            registeredFeishuThreadId: registeredFeishuThreadId ?? null,
            deliveryIndex: index,
            deliveryId: uuid
          })
          const replied = await messageClient.im.v1.message.reply({
            path: {
              message_id: replyMessageId
            },
            data: {
              msg_type: outgoingMessage.msgType,
              content: outgoingMessage.content,
              reply_in_thread: true,
              uuid
            }
          })
          const createdMessageId = replied.data?.message_id?.trim()
          if (createdMessageId) {
            this.replyMessageIdByIoThreadId.set(message.thread.id, createdMessageId)
          }
          const repliedThreadId = replied.data?.thread_id?.trim()
          Logger.info('feishu openapi replied message', {
            messageId: message.id,
            ioThreadId: message.thread.id,
            replyMessageId,
            createdMessageId: createdMessageId ?? null,
            returnedFeishuThreadId: repliedThreadId ?? null,
            registeredFeishuThreadId: registeredFeishuThreadId ?? null
          })
          if (repliedThreadId && !this.feishuThreadId(message.thread.id)) {
            this.threadRegistry.bind(message.thread.id, {
              source: 'feishu',
              id: `${this.chatId}:thread:${repliedThreadId}`
            })
          }
          continue
        }
        Logger.info('feishu openapi creating message', {
          messageId: message.id,
          ioThreadId: message.thread.id,
          registeredFeishuThreadId: registeredFeishuThreadId ?? null,
          deliveryIndex: index,
          deliveryId: uuid
        })
        const created = await messageClient.im.v1.message.create({
          params: {
            receive_id_type: 'chat_id'
          },
          data: {
            receive_id: this.chatId,
            msg_type: outgoingMessage.msgType,
            content: outgoingMessage.content,
            uuid
          }
        })
        const createdMessageId = created.data?.message_id?.trim()
        const createdThreadId = created?.data?.thread_id?.trim()
        Logger.info('feishu openapi created message', {
          messageId: message.id,
          ioThreadId: message.thread.id,
          createdMessageId: createdMessageId ?? null,
          returnedFeishuThreadId: createdThreadId ?? null,
          registeredFeishuThreadId: registeredFeishuThreadId ?? null
        })
        if (createdMessageId) {
          replyMessageId = createdMessageId
          this.replyMessageIdByIoThreadId.set(message.thread.id, createdMessageId)
        }
        if (!registeredFeishuThreadId) {
          if (!createdThreadId) {
            throw new Error('feishu thread_id missing')
          }
          this.threadRegistry.bind(message.thread.id, {
            source: 'feishu',
            id: `${this.chatId}:thread:${createdThreadId}`
          })
        }
      }
      Logger.info('feishu openapi send completed', {
        messageId: message.id,
        ioThreadId: message.thread.id,
        role: message.role,
        images: images.length,
        files: files.length
      })
      return Result.successVoid()
    } catch (error) {
      let normalizedError: unknown = error
      if (error && typeof error === 'object') {
        const response = (error as {
          response?: {
            status?: unknown
            data?: unknown
          }
        }).response
        if (response) {
          normalizedError = {
            name: error instanceof Error ? error.name : undefined,
            message: error instanceof Error ? error.message : String(error),
            status: response.status,
            data: response.data
          }
        }
      }
      Logger.error('feishu openapi send failed', normalizedError)
      return Result.fromError(error)
    }
  }

  async stop(): Promise<Result<void>> {
    this.client = undefined
    this.replyMessageIdByIoThreadId.clear()
    return Result.successVoid()
  }

  private feishuThreadId(ioThreadId: string): string | undefined {
    const channelThreadId = this.threadRegistry.getChannelThreadIds(ioThreadId)
      .find((item) => item.source === 'feishu' && item.id.includes(':thread:'))
    return channelThreadId?.id.split(':thread:').at(1)?.trim()
  }
}
