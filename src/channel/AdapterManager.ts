import { Server as HttpServer } from 'node:http'
import { Express } from 'express'
import { CodexioConfig } from '../ConfigService.js'
import { Result } from '../Result.js'
import { ChannelAdapter, ChannelMessage, ChannelReceiveResult } from './ChannelAdapter.js'
import { FeishuChannelAdapter } from './FeishuChannelAdapter.js'
import { WebChannelAdapter } from './WebChannelAdapter.js'

export class AdapterManager {
  private readonly web = new WebChannelAdapter()
  private readonly feishu: FeishuChannelAdapter
  private readonly adapters = new Map<string, ChannelAdapter>()
  private readonly messages: ChannelMessage[] = []
  private currentChannel?: string
  private handleReceive?: (text: string) => Promise<Result<ChannelReceiveResult>>

  constructor(config: CodexioConfig) {
    this.feishu = new FeishuChannelAdapter(config.channels.feishu)
    for (const adapter of [
      this.web,
      this.feishu
    ]) {
      const channelConfig = config.channels[adapter.type]
      if (channelConfig?.enabled) {
        this.adapters.set(adapter.type, adapter)
      }
    }
    this.currentChannel = this.adapters.keys().next().value
  }

  start(app: Express, receive: (text: string) => Promise<Result<ChannelReceiveResult>>): void {
    this.handleReceive = receive
    for (const adapter of this.adapters.values()) {
      adapter.start({
        app,
        history: () => this.messages.slice(-20),
        receive: async (text) => {
          this.currentChannel = adapter.type
          return this.receive(text)
        }
      })
    }
  }

  attach(server: HttpServer): void {
    if (this.adapters.has(this.web.type)) {
      this.web.attach(server)
    }
  }

  async receive(text: string): Promise<Result<ChannelReceiveResult>> {
    if (text.trim().length === 0) {
      return Result.fail('text is required')
    }
    if (!this.handleReceive) {
      return Result.fail('adapter manager not started')
    }
    this.messages.push({
      role: 'human',
      text,
      createdAt: Date.now()
    })
    const result = await this.handleReceive(text)
    if (result.data?.action === 'clear') {
      this.messages.length = 0
    }
    return result
  }

  async send(text: string): Promise<Result<null>> {
    if (text.trim().length === 0) {
      return Result.fail('text is required')
    }
    if (!this.currentChannel) {
      return Result.fail('channel adapter not found')
    }
    const adapter = this.adapters.get(this.currentChannel)
    if (!adapter) {
      return Result.fail(`channel adapter not found: ${this.currentChannel}`)
    }
    const message = {
      role: 'agent' as const,
      text,
      createdAt: Date.now()
    }
    this.messages.push(message)
    const result = await adapter.send(text)
    if (result.isFailed) {
      const index = this.messages.indexOf(message)
      if (index >= 0) {
        this.messages.splice(index, 1)
      }
      return result
    }
    return Result.success(null)
  }
}
