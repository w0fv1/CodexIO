import { readFile } from 'node:fs/promises'
import { inject, injectable } from 'inversify'
import { Configer } from '../Configer.js'
import { ThreadRegistry } from '../ThreadRegistry.js'
import { Logger } from '../Logger.js'
import { CodexioConfig } from '../../value/ConfigDefinition.js'
import { Message, MessageFile } from '../../value/Message.js'
import { Result } from '../../value/Result.js'
import { createNfircoThread, createNfircoThreadMessage, generateNfircoThreadUploadUrl, normalizeNfircoThreadCredentials, NfircoThreadCredentials } from '../channel/NfircoThreadClient.js'
import { ChannelOutput, ChannelOutputContext } from './ChannelOutput.js'
import { deriveExternalDeliveryId } from './ExternalDeliveryIdentity.js'

type NfircoOutputConfig = CodexioConfig['channelo']['nfirco']
type OutputFile = {
  file: MessageFile
  image: boolean
}

@injectable()
export class NfircoThreadOutput implements ChannelOutput {
  readonly type = 'nfirco'
  private config?: NfircoOutputConfig

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(ThreadRegistry) private readonly threadRegistry: ThreadRegistry
  ) {}

  async start(): Promise<boolean> {
    this.config = await this.configer.get('channelo.nfirco')
    if (!this.config?.enabled) {
      return false
    }
    Logger.info('nfirco thread output ready')
    return true
  }

  async send(message: Message, context?: ChannelOutputContext): Promise<Result<void>> {
    if (context?.source === 'nfirco' && message.role === 'user') {
      return Result.successVoid()
    }
    if (!this.config?.enabled) {
      return Result.successVoid()
    }
    const text = message.text.trim()
    const files = this.outputFiles(message.files ?? [])
    if (text.length === 0 && files.length === 0) {
      return Result.fail('text or file is required')
    }
    const credentials = normalizeNfircoThreadCredentials(this.config)
    const uploaded = await this.uploadFiles(credentials, files)
    if (uploaded.isFailed) {
      return Result.fail(uploaded.message)
    }
    let threadUuid = this.findThreadUuid(message.thread.id)
    if (!threadUuid) {
      const created = await createNfircoThread(
        credentials,
        {
          section: this.config.section.trim(),
          title: message.thread.name,
          text,
          requestId: deriveExternalDeliveryId('nfirco', message, 'thread'),
          fileIds: uploaded.data?.fileIds ?? [],
          imageIds: uploaded.data?.imageIds ?? []
        }
      )
      if (created.isFailed || !created.data) {
        return Result.fail(created.message)
      }
      threadUuid = created.data.threadUuid
      this.threadRegistry.bind(message.thread.id, {
        source: 'nfirco',
        id: threadUuid
      })
      Logger.info('nfirco thread created', {
        ioThreadId: message.thread.id,
        threadUuid,
        section: this.config.section.trim()
      })
      return Result.successVoid()
    }
    const result = await createNfircoThreadMessage(
      credentials,
      threadUuid,
      {
        text,
        requestId: deriveExternalDeliveryId('nfirco', message, 'message'),
        fileIds: uploaded.data?.fileIds ?? [],
        imageIds: uploaded.data?.imageIds ?? []
      }
    )
    if (result.isFailed) {
      return Result.fail(result.message)
    }
    Logger.info('nfirco thread message sent', {
      role: message.role,
      ioThreadId: message.thread.id,
      threadUuid,
      files: uploaded.data?.fileIds.length ?? 0,
      images: uploaded.data?.imageIds.length ?? 0
    })
    return Result.successVoid()
  }

  async stop(): Promise<Result<void>> {
    Logger.info('nfirco thread output stopped')
    this.config = undefined
    return Result.successVoid()
  }

  private findThreadUuid(ioThreadId: string): string | undefined {
    const threads = this.threadRegistry.getChannelThreadIds(ioThreadId)
    return threads.find((thread) => thread.source === 'nfirco')?.id
  }

  private outputFiles(files: MessageFile[]): OutputFile[] {
    return files.map((file) => ({
      file,
      image: file.mime.toLowerCase().startsWith('image/')
    }))
  }

  private async uploadFiles(credentials: NfircoThreadCredentials, files: OutputFile[]): Promise<Result<{ fileIds: number[], imageIds: number[] }>> {
    const fileIds: number[] = []
    const imageIds: number[] = []
    for (const item of files) {
      const uploadUrl = await generateNfircoThreadUploadUrl(credentials, {
        mime: item.file.mime,
        name: item.file.name,
        size: item.file.size
      })
      if (uploadUrl.isFailed || !uploadUrl.data) {
        return Result.fail(uploadUrl.message)
      }
      const response = await fetch(uploadUrl.data.uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': item.file.mime
        },
        body: await readFile(item.file.path)
      })
      if (!response.ok) {
        return Result.fail(`nfirco file upload failed: ${response.status}`)
      }
      if (item.image) {
        imageIds.push(uploadUrl.data.id)
      } else {
        fileIds.push(uploadUrl.data.id)
      }
    }
    return Result.success({
      fileIds,
      imageIds
    })
  }
}
