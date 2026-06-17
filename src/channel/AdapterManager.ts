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
  }

  start(app: Express, receive: (text: string) => Promise<Result<ChannelReceiveResult>>): void {
    this.handleReceive = receive
    for (const adapter of this.adapters.values()) {
      adapter.start({
        app,
        history: () => this.messages.slice(-20),
        receive: async (text) => {
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
    if (this.adapters.size === 0) {
      return Result.fail('channel adapter not found')
    }
    const message = {
      role: 'agent' as const,
      text,
      createdAt: Date.now()
    }
    this.messages.push(message)
    const failures: string[] = []
    for (const adapter of this.adapters.values()) {
      const result = await adapter.send(text)
      if (result.isFailed) {
        failures.push(result.message)
      }
    }
    if (failures.length === this.adapters.size) {
      const index = this.messages.indexOf(message)
      if (index >= 0) {
        this.messages.splice(index, 1)
      }
      return Result.fail(failures.join('\n'))
    }
    return Result.success(null)
  }

  async status(_text: string): Promise<Result<null>> {
    return Result.success(null)
  }

  async stop(): Promise<Result<null>> {
    const failures: string[] = []
    for (const adapter of this.adapters.values()) {
      const result = await adapter.stop()
      if (result.isFailed) {
        failures.push(result.message)
      }
    }
    if (failures.length > 0) {
      return Result.fail(failures.join('\n'))
    }
    return Result.success(null)
  }
}
