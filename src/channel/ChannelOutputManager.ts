import { inject, injectable } from 'inversify'
import { Result } from '../value/Result.js'
import { allIoThreadId, Message, MessageFile } from '../value/Message.js'
import { ChannelOutput } from './Channel.js'
import { Logger } from '../component/Logger.js'
import { FileStore } from '../component/FileStore.js'
import { Configer } from '../component/Configer.js'
import { EmailChannelOutput } from './EmailChannel.js'
import { FeishuChannelOutput } from './FeishuChannel.js'
import { FeishuWebhookChannelOutput } from './FeishuWebhookChannel.js'
import { WebChannelOutput } from './WebChannel.js'

const markdownImagePattern = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const localImagePathPattern = /(?:[A-Za-z]:[\\/][^\r\n"'<>|?*]+?\.(?:png|jpe?g|webp|gif)|\/[^\r\n"'<>]+?\.(?:png|jpe?g|webp|gif))/gi

@injectable()
export class ChannelOutputManager {
  private readonly availableOutputs: ChannelOutput[]
  private readonly outputs = new Map<string, ChannelOutput>()

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(FileStore) private readonly fileStore: FileStore,
    @inject(WebChannelOutput) web: WebChannelOutput,
    @inject(FeishuChannelOutput) feishu: FeishuChannelOutput,
    @inject(FeishuWebhookChannelOutput) feishuWebhook: FeishuWebhookChannelOutput,
    @inject(EmailChannelOutput) email: EmailChannelOutput
  ) {
    this.availableOutputs = [
      web,
      feishu,
      feishuWebhook,
      email
    ]
  }

  async start(): Promise<void> {
    this.configer.subscribe('channels', async () => {
      const applied = await this.applyConfig()
      if (applied.isFailed) {
        await this.sendSystem(`通道输出配置应用失败：${applied.message}`)
      }
    })
    await this.applyConfig()
  }

  async sendUser(message: Message): Promise<Result<null>> {
    if (message.text.trim().length === 0 && (!message.files || message.files.length === 0)) {
      return Result.fail('text or file is required')
    }
    Logger.info('user message received', {
      source: message.source ?? null,
      ioThreadId: message.ioThreadId,
      text: message.text,
      files: message.files?.length ?? 0
    })
    return this.send({
      ...message,
      role: 'user'
    })
  }

  async sendAgent(message: Message): Promise<Result<null>> {
    return this.send({
      ...message,
      role: 'agent'
    })
  }

  async sendSystem(text: string, source = 'unknown', ioThreadId?: string): Promise<Result<null>> {
    if (text.trim().length === 0) {
      return Result.fail('text is required')
    }
    return this.send({
      ioThreadId: ioThreadId ?? allIoThreadId,
      role: 'system',
      text,
      createdAt: Date.now(),
      source
    })
  }

  async clear(ioThreadId: string, source = 'unknown'): Promise<Result<null>> {
    return this.broadcast({
      ioThreadId,
      role: 'system',
      text: 'clear',
      createdAt: Date.now(),
      source
    })
  }

  async stop(): Promise<Result<null>> {
    const failures: string[] = []
    for (const output of this.outputs.values()) {
      const result = await output.stop()
      if (result.isFailed) {
        failures.push(result.message)
      }
    }
    if (failures.length > 0) {
      return Result.fail(failures.join('\n'))
    }
    return Result.success(null)
  }

  async applyConfig(): Promise<Result<null>> {
    const failures: string[] = []
    for (const output of this.outputs.values()) {
      const result = await output.stop()
      if (result.isFailed) {
        failures.push(`${output.type}: ${result.message}`)
      }
    }
    this.outputs.clear()
    for (const output of this.availableOutputs) {
      try {
        if (await output.start()) {
          this.outputs.set(output.type, output)
        }
      } catch (error) {
        const failed = Result.fromError(error)
        failures.push(`${output.type}: ${failed.message}`)
      }
    }
    if (failures.length > 0) {
      return Result.fail(failures.join('\n'))
    }
    Logger.info('channel output config applied')
    return Result.success(null)
  }

  private async send(message: Message): Promise<Result<null>> {
    if (message.text.trim().length === 0 && (!message.files || message.files.length === 0)) {
      return Result.fail('text or file is required')
    }
    const files = new Map<string, MessageFile>()
    for (const file of message.files ?? []) {
      files.set(file.id, file)
    }
    const importedPaths = new Map<string, MessageFile>()
    let text = message.text
    const markdownParts: string[] = []
    let markdownLastIndex = 0
    markdownImagePattern.lastIndex = 0
    for (;;) {
      const match = markdownImagePattern.exec(text)
      if (!match) {
        break
      }
      const alt = match[1]
      const url = match[2]
      markdownParts.push(text.slice(markdownLastIndex, match.index))
      let file = this.fileStore.resolveUrl(url)
      if (!file && !/^https?:\/\//i.test(url)) {
        const path = url.replaceAll('/', '\\')
        file = importedPaths.get(path)
        if (!file) {
          try {
            file = await this.fileStore.importPath(path)
            importedPaths.set(path, file)
          } catch {
          }
        }
      }
      if (file) {
        files.set(file.id, file)
      } else {
        markdownParts.push(alt.trim().length > 0 ? `${alt} ${url}` : url)
      }
      markdownLastIndex = match.index + match[0].length
    }
    markdownParts.push(text.slice(markdownLastIndex))
    text = markdownParts.join('')
    const localPathParts: string[] = []
    let localPathLastIndex = 0
    localImagePathPattern.lastIndex = 0
    for (;;) {
      const match = localImagePathPattern.exec(text)
      if (!match) {
        break
      }
      const value = match[0]
      localPathParts.push(text.slice(localPathLastIndex, match.index))
      const path = value.replaceAll('/', '\\')
      let file = importedPaths.get(path)
      if (!file) {
        try {
          file = await this.fileStore.importPath(path)
          importedPaths.set(path, file)
        } catch {
        }
      }
      if (file) {
        files.set(file.id, file)
      } else {
        localPathParts.push(value)
      }
      localPathLastIndex = match.index + value.length
    }
    localPathParts.push(text.slice(localPathLastIndex))
    text = localPathParts.join('')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    return this.broadcast({
      ...message,
      text,
      files: files.size > 0 ? [...files.values()] : undefined
    })
  }

  private async broadcast(message: Message): Promise<Result<null>> {
    if (this.outputs.size === 0) {
      return Result.fail('channel output not found')
    }
    const failures: string[] = []
    for (const output of this.outputs.values()) {
      try {
        const result = await output.send(message)
        if (result.isFailed) {
          failures.push(`${output.type}: ${result.message}`)
        }
      } catch (error) {
        const failed = Result.fromError(error)
        failures.push(`${output.type}: ${failed.message}`)
      }
    }
    if (failures.length === this.outputs.size) {
      return Result.fail(failures.join('\n'))
    }
    if (failures.length > 0) {
      Logger.warn('channel output partially failed', {
        failures
      })
    }
    return Result.success(null)
  }
}
