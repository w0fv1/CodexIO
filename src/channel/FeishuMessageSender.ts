import * as Lark from '@larksuiteoapi/node-sdk'
import { extname } from 'node:path'
import { readFile } from 'node:fs/promises'
import { ChannelFile, ChannelMessage } from './Channel.js'
import { createFeishuMessagePayload, FeishuImage } from './ChannelUtil.js'
import { CodexioConfig } from '../ConfigService.js'
import { Logger } from '../component/Logger.js'
import { Result } from '../value/Result.js'
import { isImageFile } from '../component/FileStore.js'

type FeishuChannelConfig = CodexioConfig['channels']['feishu']

export class FeishuMessageSender {
  private readonly client: Lark.Client
  private chatId: string

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

  async send(message: ChannelMessage): Promise<Result<null>> {
    if (message.text.trim().length === 0 && (!message.files || message.files.length === 0)) {
      return Result.fail('text or file is required')
    }
    if (this.chatId.length === 0) {
      return Result.fail('feishu chat not ready')
    }
    try {
      Logger.info('feishu send started', {
        role: message.role,
        source: message.source ?? null,
        length: message.text.length,
        files: message.files?.length ?? 0
      })
      const images: FeishuImage[] = []
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
          const uploadedFile = await this.client.im.v1.file.create({
            data: {
              file_type: feishuFileType(file),
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
      const payload = createFeishuMessagePayload(message, images)
      if (hasPostContent(payload.content)) {
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
      }
      for (const file of files) {
        await this.client.im.v1.message.create({
          params: {
            receive_id_type: 'chat_id'
          },
          data: {
            receive_id: this.chatId,
            msg_type: 'file',
            content: JSON.stringify({
              file_key: file.fileKey
            })
          }
        })
      }
      Logger.info('feishu send completed', {
        role: message.role,
        images: images.length,
        files: files.length
      })
    } catch (error) {
      Logger.error('feishu send failed', normalizeFeishuError(error))
      return Result.fromError(error)
    }
    return Result.success(null)
  }
}

function feishuFileType(file: ChannelFile): 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' {
  const extension = extname(file.name).toLowerCase()
  if (file.mime === 'audio/ogg' || file.mime === 'audio/opus' || extension === '.opus') {
    return 'opus'
  }
  if (file.mime === 'video/mp4' || extension === '.mp4') {
    return 'mp4'
  }
  if (file.mime === 'application/pdf' || extension === '.pdf') {
    return 'pdf'
  }
  if ([
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ].includes(file.mime) || ['.doc', '.docx'].includes(extension)) {
    return 'doc'
  }
  if ([
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ].includes(file.mime) || ['.xls', '.xlsx', '.csv'].includes(extension)) {
    return 'xls'
  }
  if ([
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ].includes(file.mime) || ['.ppt', '.pptx'].includes(extension)) {
    return 'ppt'
  }
  return 'stream'
}

function hasPostContent(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as {
      zh_cn?: {
        content?: unknown[]
      }
    }
    return (parsed.zh_cn?.content?.length ?? 0) > 0
  } catch {
    return true
  }
}

function normalizeFeishuError(error: unknown): unknown {
  if (!error || typeof error !== 'object') {
    return error
  }
  const response = (error as {
    response?: {
      status?: unknown
      data?: unknown
    }
  }).response
  if (!response) {
    return error
  }
  return {
    name: error instanceof Error ? error.name : undefined,
    message: error instanceof Error ? error.message : String(error),
    status: response.status,
    data: response.data
  }
}
