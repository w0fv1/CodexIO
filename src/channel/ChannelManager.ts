import { Server as HttpServer } from 'node:http'
import { Express } from 'express'
import { CodexioConfig } from '../ConfigService.js'
import { Result } from '../Result.js'
import { ChannelAdapter, ChannelMessage, ChannelReceiveResult } from './ChannelAdapter.js'
import { FeishuChannelAdapter } from './FeishuChannelAdapter.js'
import { WebChannelAdapter } from './WebChannelAdapter.js'

const messageHistoryLimit = 20

export class ChannelManager {
  private readonly web = new WebChannelAdapter()
  private readonly feishu: FeishuChannelAdapter
  private readonly channels = new Map<string, ChannelAdapter>()
  private readonly messages: ChannelMessage[] = []
  private handleReceive?: (text: string) => Promise<Result<ChannelReceiveResult>>

  constructor(config: CodexioConfig) {
    this.feishu = new FeishuChannelAdapter(config.channels.feishu)
    for (const adapter of [
      this.web,
      this.feishu
    ]) {
      const channelConfig = config.channels[adapter.type]
      if (channelConfig?.enabled) {
        this.channels.set(adapter.type, adapter)
      }
    }
  }

  start(app: Express, receive: (text: string) => Promise<Result<ChannelReceiveResult>>): void {
    this.handleReceive = receive
    for (const channel of this.channels.values()) {
      channel.start({
        app,
        displayHistory: () => [...this.messages],
        receive: async (text) => {
          return this.receive(text, channel.type)
        }
      })
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
    if (text.trim() === '/$ clear') {
      const result = await this.handleReceive(text)
      if (result.data?.action === 'clear') {
        this.messages.length = 0
        await this.broadcast({
          role: 'system',
          text: 'clear',
          createdAt: Date.now(),
          source
        })
      }
      return result
    }
    await this.display({
      role: 'human',
      text,
      createdAt: Date.now(),
      source
    })
    return this.handleReceive(text)
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
      process.stderr.write(`channel send partially failed: ${failures.join('\n')}\n`)
    }
    return Result.success(null)
  }
}
