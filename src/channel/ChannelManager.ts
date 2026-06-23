import { inject, injectable } from 'inversify'
import { Result } from '../value/Result.js'
import { allIoThreadId, Message, MessageFile } from '../value/Message.js'
import { Channel } from './Channel.js'
import { Logger } from '../component/Logger.js'
import { FileStore } from '../component/FileStore.js'
import { Configer } from '../component/Configer.js'
import { EmailChannel } from './EmailChannel.js'
import { FeishuChannel } from './FeishuChannel.js'
import { FeishuWebhookChannel } from './FeishuWebhookChannel.js'
import { WebChannel } from './WebChannel.js'

const markdownImagePattern = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const localImagePathPattern = /(?:[A-Za-z]:[\\/][^\r\n"'<>|?*]+?\.(?:png|jpe?g|webp|gif)|\/[^\r\n"'<>]+?\.(?:png|jpe?g|webp|gif))/gi

@injectable()
export class ChannelManager {
  private readonly availableChannels: Channel[]
  private readonly channels = new Map<string, Channel>()

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(FileStore) private readonly fileStore: FileStore,
    @inject(WebChannel) private readonly web: WebChannel,
    @inject(FeishuChannel) private readonly feishu: FeishuChannel,
    @inject(FeishuWebhookChannel) private readonly feishuWebhook: FeishuWebhookChannel,
    @inject(EmailChannel) private readonly email: EmailChannel
  ) {
    this.availableChannels = [
      this.web,
      this.feishu,
      this.feishuWebhook,
      this.email
    ]
  }

  async start(): Promise<void> {
    this.configer.subscribe('channels', async () => {
      const applied = await this.applyConfig()
      if (applied.isFailed) {
        await this.sendSystem(`通道配置应用失败：${applied.message}`)
      }
    })
    const channels = await this.configer.get('channels')
    for (const channel of this.availableChannels) {
      const channelConfig = channels[channel.type]
      if (channelConfig?.enabled) {
        this.channels.set(channel.type, channel)
      }
    }
    for (const channel of this.channels.values()) {
      await channel.start()
    }
  }

  async displayUser(message: Message): Promise<Result<null>> {
    if (message.text.trim().length === 0 && (!message.files || message.files.length === 0)) {
      return Result.fail('text or file is required')
    }
    Logger.info('user message received', {
      source: message.source ?? null,
      ioThreadId: message.ioThreadId,
      text: message.text,
      files: message.files?.length ?? 0
    })
    return this.display({
      ...message,
      role: 'user'
    })
  }

  async send(message: Message): Promise<Result<null>> {
    if (message.text.trim().length === 0 && (!message.files || message.files.length === 0)) {
      return Result.fail('text or file is required')
    }
    return this.display(message)
  }

  async status(_text: string): Promise<Result<null>> {
    return Result.success(null)
  }

  async sendSystem(text: string, source = 'unknown', ioThreadId?: string): Promise<Result<null>> {
    if (text.trim().length === 0) {
      return Result.fail('text is required')
    }
    return this.display({
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
    for (const channel of this.channels.values()) {
      const result = await channel.stop()
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
    const channels = await this.configer.get('channels')
    const failures: string[] = []
    for (const channel of [...this.channels.values()].filter((channel) => channel.type !== 'web')) {
      if (this.channels.has(channel.type)) {
        const result = await channel.stop()
        if (result.isFailed) {
          failures.push(`${channel.type}: ${result.message}`)
        }
        this.channels.delete(channel.type)
      }
    }
    for (const channel of this.availableChannels.filter((channel) => channel.type !== 'web')) {
      const channelConfig = channels[channel.type]
      if (!channelConfig?.enabled) {
        continue
      }
      this.channels.set(channel.type, channel)
      try {
        await channel.start()
      } catch (error) {
        const failed = Result.fromError(error)
        failures.push(`${channel.type}: ${failed.message}`)
      }
    }
    if (failures.length > 0) {
      return Result.fail(failures.join('\n'))
    }
    Logger.info('channel config applied')
    return Result.success(null)
  }

  private async display(message: Message): Promise<Result<null>> {
    if (this.channels.size === 0) {
      return Result.fail('channel not found')
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
    const failures: string[] = []
    for (const channel of this.channels.values()) {
      try {
        const result = await channel.send(message)
        if (result.isFailed) {
          failures.push(`${channel.type}: ${result.message}`)
        }
      } catch (error) {
        const failed = Result.fromError(error)
        failures.push(`${channel.type}: ${failed.message}`)
      }
    }
    if (failures.length === this.channels.size) {
      return Result.fail(failures.join('\n'))
    }
    if (failures.length > 0) {
      Logger.warn('channel send partially failed', {
        failures
      })
    }
    return Result.success(null)
  }

}
