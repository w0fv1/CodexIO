import { CodexioConfig } from '../config/ConfigDefinition.js'
import { Result } from '../value/Result.js'
import { Channel, ChannelInput, ChannelMessage, ChannelReceiveResult } from './Channel.js'
import { EmailChannel } from './EmailChannel.js'
import { FeishuChannel } from './FeishuChannel.js'
import { FeishuWebhookChannel } from './FeishuWebhookChannel.js'
import { WebChannel } from './WebChannel.js'
import { Logger } from '../component/Logger.js'
import { FileStore } from '../component/FileStore.js'
import { normalizeChannelMessageFiles } from './ChannelMessageFiles.js'

export class ChannelManager {
  private readonly web: WebChannel
  private feishu: FeishuChannel
  private feishuWebhook: FeishuWebhookChannel
  private email: EmailChannel
  private readonly channels = new Map<string, Channel>()

  constructor(
    private config: CodexioConfig,
    private readonly fileStore = new FileStore(),
    private readonly handleReceive: (input: ChannelInput, source: string) => Promise<Result<ChannelReceiveResult>>
  ) {
    this.web = new WebChannel(fileStore, (input) => this.receive(input, this.web.type))
    this.feishu = new FeishuChannel((input) => this.receive(input, this.feishu.type))
    this.feishuWebhook = new FeishuWebhookChannel()
    this.email = new EmailChannel((input) => this.receive(input, this.email.type))
    this.registerConfiguredChannels(config, [
      this.web,
      this.feishu,
      this.feishuWebhook,
      this.email
    ])
  }

  start(config = this.config): void {
    this.config = config
    for (const channel of this.channels.values()) {
      channel.start(config)
    }
  }

  async receive(input: ChannelInput, source = 'unknown'): Promise<Result<ChannelReceiveResult>> {
    if (input.text.trim().length === 0 && (!input.files || input.files.length === 0)) {
      return Result.fail('text or file is required')
    }
    return this.handleReceive(input, source)
  }

  async displayUser(input: ChannelInput, source = 'unknown'): Promise<Result<null>> {
    if (input.text.trim().length === 0 && (!input.files || input.files.length === 0)) {
      return Result.fail('text or file is required')
    }
    Logger.info('user message received', {
      source,
      text: input.text,
      files: input.files?.length ?? 0
    })
    return this.display({
      role: 'user',
      text: input.text,
      createdAt: Date.now(),
      source,
      files: input.files
    })
  }

  async send(input: ChannelInput | string): Promise<Result<null>> {
    const messageInput = typeof input === 'string' ? {
      text: input
    } : input
    if (messageInput.text.trim().length === 0 && (!messageInput.files || messageInput.files.length === 0)) {
      return Result.fail('text or file is required')
    }
    return this.display({
      role: 'agent' as const,
      text: messageInput.text,
      createdAt: Date.now(),
      files: messageInput.files
    })
  }

  async status(_text: string): Promise<Result<null>> {
    return Result.success(null)
  }

  async sendSystem(text: string, source = 'unknown'): Promise<Result<null>> {
    if (text.trim().length === 0) {
      return Result.fail('text is required')
    }
    return this.display({
      role: 'system',
      text,
      createdAt: Date.now(),
      source
    })
  }

  async clear(source = 'unknown'): Promise<Result<null>> {
    return this.broadcast({
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

  async applyConfig(config: CodexioConfig): Promise<Result<null>> {
    this.config = config
    const failures: string[] = []
    for (const channel of [
      this.feishu,
      this.feishuWebhook,
      this.email
    ]) {
      if (this.channels.has(channel.type)) {
        const result = await channel.stop()
        if (result.isFailed) {
          failures.push(`${channel.type}: ${result.message}`)
        }
        this.channels.delete(channel.type)
      }
    }
    this.feishu = new FeishuChannel((input) => this.receive(input, this.feishu.type))
    this.feishuWebhook = new FeishuWebhookChannel()
    this.email = new EmailChannel((input) => this.receive(input, this.email.type))
    for (const channel of [
      this.feishu,
      this.feishuWebhook,
      this.email
    ]) {
      const channelConfig = config.channels[channel.type]
      if (!channelConfig?.enabled) {
        continue
      }
      this.channels.set(channel.type, channel)
      try {
        channel.start(config)
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

  private async display(message: ChannelMessage): Promise<Result<null>> {
    if (this.channels.size === 0) {
      return Result.fail('channel not found')
    }
    const normalized = await normalizeChannelMessageFiles(message, this.fileStore)
    return this.broadcast(normalized)
  }

  private async broadcast(message: ChannelMessage): Promise<Result<null>> {
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

  private registerConfiguredChannels(config: CodexioConfig, channels: Channel[]): void {
    for (const channel of channels) {
      const channelConfig = config.channels[channel.type]
      if (channelConfig?.enabled) {
        this.channels.set(channel.type, channel)
      }
    }
  }
}
