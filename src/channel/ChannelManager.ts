import { Server as HttpServer } from 'node:http'
import { Express } from 'express'
import { CodexioConfig } from '../ConfigService.js'
import { Result } from '../value/Result.js'
import { Channel, ChannelMessage, ChannelReceiveResult, ChannelStartInput } from './Channel.js'
import { EmailChannel } from './EmailChannel.js'
import { FeishuChannel } from './FeishuChannel.js'
import { FeishuWebhookChannel } from './FeishuWebhookChannel.js'
import { WebChannel } from './WebChannel.js'
import { Logger } from '../component/Logger.js'

const messageHistoryLimit = 20

export class ChannelManager {
  private readonly web = new WebChannel()
  private feishu: FeishuChannel
  private feishuWebhook: FeishuWebhookChannel
  private email: EmailChannel
  private readonly channels = new Map<string, Channel>()
  private readonly messages: ChannelMessage[] = []
  private app?: Express
  private handleReceive?: (text: string, source: string) => Promise<Result<ChannelReceiveResult>>

  constructor(private config: CodexioConfig) {
    this.feishu = new FeishuChannel(config.channels.feishu)
    this.feishuWebhook = new FeishuWebhookChannel(config.channels.feishuWebhook)
    this.email = new EmailChannel(config.channels.email)
    for (const adapter of [
      this.web,
      this.feishu,
      this.feishuWebhook,
      this.email
    ]) {
      const channelConfig = config.channels[adapter.type]
      if (channelConfig?.enabled) {
        this.channels.set(adapter.type, adapter)
      }
    }
  }

  start(app: Express, receive: (text: string, source: string) => Promise<Result<ChannelReceiveResult>>): void {
    this.app = app
    this.handleReceive = receive
    for (const channel of this.channels.values()) {
      channel.start(this.createStartInput(channel))
    }
  }

  attach(server: HttpServer): void {
    if (this.channels.has(this.web.type)) {
      this.web.attach(server)
    }
  }

  async receive(text: string, source = 'unknown'): Promise<Result<ChannelReceiveResult>> {
    if (text.trim().length === 0) {
      return Result.fail('text is required')
    }
    if (!this.handleReceive) {
      return Result.fail('channel manager not started')
    }
    return this.handleReceive(text, source)
  }

  async displayUser(text: string, source = 'unknown'): Promise<Result<null>> {
    if (text.trim().length === 0) {
      return Result.fail('text is required')
    }
    Logger.info('user message received', {
      source,
      text
    })
    return this.display({
      role: 'user',
      text,
      createdAt: Date.now(),
      source
    })
  }

  async send(text: string): Promise<Result<null>> {
    if (text.trim().length === 0) {
      return Result.fail('text is required')
    }
    return this.display({
      role: 'agent' as const,
      text,
      createdAt: Date.now()
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
    this.messages.length = 0
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
    this.feishu = new FeishuChannel(config.channels.feishu)
    this.feishuWebhook = new FeishuWebhookChannel(config.channels.feishuWebhook)
    this.email = new EmailChannel(config.channels.email)
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
      if (this.app && this.handleReceive) {
        try {
          channel.start(this.createStartInput(channel))
        } catch (error) {
          const failed = Result.fromError(error)
          failures.push(`${channel.type}: ${failed.message}`)
        }
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
    this.messages.push(message)
    if (this.messages.length > messageHistoryLimit) {
      this.messages.splice(0, this.messages.length - messageHistoryLimit)
    }
    const result = await this.broadcast(message)
    if (result.isFailed) {
      const index = this.messages.indexOf(message)
      if (index >= 0) {
        this.messages.splice(index, 1)
      }
    }
    return result
  }

  private createStartInput(channel: Channel): ChannelStartInput {
    if (!this.app) {
      throw new Error('channel manager not started')
    }
    return {
      app: this.app,
      displayHistory: () => [...this.messages],
      receive: async (text) => {
        return this.receive(text, channel.type)
      }
    }
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
}
