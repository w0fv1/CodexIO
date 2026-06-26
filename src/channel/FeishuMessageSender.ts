import * as Lark from '@larksuiteoapi/node-sdk'
import { extname } from 'node:path'
import { readFile } from 'node:fs/promises'
import { allIoThreadId, Message } from '../value/Message.js'
import { CodexioConfig } from '../value/ConfigDefinition.js'
import { Logger } from '../component/Logger.js'
import { Result } from '../value/Result.js'
import { isImageFile } from '../component/FileStore.js'

type FeishuChannelConfig = CodexioConfig['channels']['feishu']

export class FeishuMessageSender {
  private readonly client: Lark.Client
  private chatId: string
  private readonly messageIdByIoThreadId = new Map<string, string>()

  constructor(private readonly config?: FeishuChannelConfig, client?: Lark.Client) {
    if (!config?.appId || !config.appSecret) {
      throw new Error('feishu appId and appSecret are required')
    }
    this.client = client ?? new Lark.Client({
      appId: config.appId,
      appSecret: config.appSecret
    })
    this.chatId = config.chatId?.trim() ?? ''
  }

  updateChatId(chatId: string): void {
    this.chatId = chatId.trim()
  }

  rememberThread(ioThreadId: string, messageId: string): void {
    const normalizedIoThreadId = ioThreadId.trim()
    const normalizedMessageId = messageId.trim()
    if (normalizedIoThreadId.length > 0 && normalizedMessageId.length > 0) {
      this.messageIdByIoThreadId.set(normalizedIoThreadId, normalizedMessageId)
    }
  }

  async send(message: Message): Promise<Result<void>> {
    if (message.text.trim().length === 0 && (!message.files || message.files.length === 0)) {
      return Result.fail('text or file is required')
    }
    if (this.chatId.length === 0) {
      return Result.fail('feishu chat not ready')
    }
    try {
      Logger.info('feishu send started', {
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
      const text = message.text
      const content: Array<Array<Record<string, string>>> = []
      if (text.trim().length > 0) {
        content.push([
          {
            tag: 'md',
            text
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
      const replyMessageIds = message.ioThreadId === allIoThreadId
        ? [...new Set(this.messageIdByIoThreadId.values())]
        : []
      let replyMessageId = message.ioThreadId === allIoThreadId ? undefined : this.messageIdByIoThreadId.get(message.ioThreadId)
      for (const outgoingMessage of outgoingMessages) {
        if (replyMessageIds.length > 0) {
          for (const item of replyMessageIds) {
            await this.client.im.v1.message.reply({
              path: {
                message_id: item
              },
              data: {
                msg_type: outgoingMessage.msgType,
                content: outgoingMessage.content,
                reply_in_thread: true
              }
            })
          }
        } else if (replyMessageId) {
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
          if (message.ioThreadId !== allIoThreadId) {
            const createdMessageId = created?.data?.message_id?.trim()
            if (!createdMessageId) {
              throw new Error('feishu message_id missing')
            }
            replyMessageId = createdMessageId
            this.rememberThread(message.ioThreadId, createdMessageId)
          }
        }
      }
      Logger.info('feishu send completed', {
        role: message.role,
        images: images.length,
        files: files.length
      })
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
      Logger.error('feishu send failed', normalizedError)
      return Result.fromError(error)
    }
    return Result.successVoid()
  }
}
