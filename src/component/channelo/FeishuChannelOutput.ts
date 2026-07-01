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
import { IoThreadIdManager } from '../IoThreadIdManager.js'
import { ChannelOutput, ChannelOutputContext } from './ChannelOutput.js'

type FeishuChannelOutputConfig = CodexioConfig['channelo']['feishu']

@injectable()
export class FeishuChannelOutput implements ChannelOutput {
  readonly type = 'feishu'
  private config?: FeishuChannelOutputConfig
  private client?: Lark.Client
  private chatId = ''

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(IoThreadIdManager) private readonly ioThreadIdManager: IoThreadIdManager
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
    if (message.role === 'user' && context?.inputType === 'feishu') {
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
      Logger.info('feishu openapi send started', {
        role: message.role,
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
      let replyMessageId = this.feishuMessageId(message.ioThreadId)
      for (const outgoingMessage of outgoingMessages) {
        if (replyMessageId) {
          await this.client.im.v1.message.reply({
            path: {
              message_id: replyMessageId
            },
            data: {
              msg_type: outgoingMessage.msgType,
              content: outgoingMessage.content,
              reply_in_thread: true
            }
          })
        } else {
          const created = await this.client.im.v1.message.create({
            params: {
              receive_id_type: 'chat_id'
            },
            data: {
              receive_id: this.chatId,
              msg_type: outgoingMessage.msgType,
              content: outgoingMessage.content
            }
          })
          const createdMessageId = created?.data?.message_id?.trim()
          if (!createdMessageId) {
            throw new Error('feishu message_id missing')
          }
          replyMessageId = createdMessageId
          this.ioThreadIdManager.bind(message.ioThreadId, {
            source: 'feishu',
            id: `${this.chatId}:message:${createdMessageId}`
          })
        }
      }
      Logger.info('feishu openapi send completed', {
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
    return Result.successVoid()
  }

  private feishuMessageId(ioThreadId: string): string | undefined {
    const platformThreadId = this.ioThreadIdManager.getPlatformThreadId(ioThreadId)
      .find((item) => item.source === 'feishu' && item.id.includes(':message:'))
    return platformThreadId?.id.split(':message:').at(1)?.trim()
  }
}
