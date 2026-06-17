import { randomUUID } from 'node:crypto'
import { CodexioConfig } from '../config/ConfigSchema.js'
import { InboundTextMessage } from '../channel/ChannelAdapter.js'
import { RuntimeContext, RuntimeRegistry } from './RuntimeRegistry.js'

export type RuntimeStartInput = {
  runtimeId: string
  workspacePath: string
  contextText: string
  env: Record<string, string>
  model?: string
}

export type RuntimeHandle = {
  runtimeId: string
  pid?: number
}

export interface AgentRuntime {
  type: string
  start(input: RuntimeStartInput): Promise<RuntimeHandle>
  send(input: {
    runtimeId: string
    text: string
  }): Promise<void>
  stop(runtimeId: string): Promise<void>
}

export type RuntimeManagerOptions = {
  config: CodexioConfig
  registry: RuntimeRegistry
  runtimes: Map<string, AgentRuntime>
  env: Record<string, string>
}

export type RuntimeAcceptOptions = {
  agent?: string
  model?: string
  reset?: boolean
}

export class RuntimeManager {
  constructor(private readonly options: RuntimeManagerOptions) {}

  async accept(message: InboundTextMessage, workspaceName: string, acceptOptions: RuntimeAcceptOptions = {}): Promise<RuntimeContext> {
    if (acceptOptions.reset) {
      await this.stopByConversation(message.channel, message.conversationId, workspaceName)
    }
    const existing = this.options.registry.findByConversation(message.channel, message.conversationId, workspaceName)
    if (existing) {
      await this.send(existing.runtimeId, message.text)
      this.options.registry.touch(existing.runtimeId)
      return existing
    }
    const workspace = this.options.config.workspaces[workspaceName]
    if (!workspace) {
      throw new Error(`workspace not found: ${workspaceName}`)
    }
    let agent = acceptOptions.agent ?? workspace.defaultAgent
    if (!agent) {
      agent = this.options.config.defaultAgent
    }
    const runtime = this.options.runtimes.get(agent)
    if (!runtime) {
      throw new Error(`agent runtime not found: ${agent}`)
    }
    const context: RuntimeContext = {
      runtimeId: `rt_${randomUUID()}`,
      agent,
      model: acceptOptions.model,
      workspaceName,
      workspacePath: workspace.path,
      channel: message.channel,
      conversationId: message.conversationId,
      startedAt: Date.now(),
      lastActiveAt: Date.now()
    }
    await runtime.start({
      runtimeId: context.runtimeId,
      workspacePath: context.workspacePath,
      contextText: 'You are running inside Codexio.',
      env: this.options.env,
      model: acceptOptions.model
    })
    this.options.registry.save(context)
    await runtime.send({
      runtimeId: context.runtimeId,
      text: message.text
    })
    return context
  }

  async stopByConversation(channel: string, conversationId: string, workspaceName: string): Promise<RuntimeContext | undefined> {
    const context = this.options.registry.removeByConversation(channel, conversationId, workspaceName)
    if (!context) {
      return undefined
    }
    const runtime = this.options.runtimes.get(context.agent)
    if (runtime) {
      await runtime.stop(context.runtimeId)
    }
    return context
  }

  async send(runtimeId: string, text: string): Promise<void> {
    const context = this.options.registry.findByRuntime(runtimeId)
    if (!context) {
      throw new Error(`runtime context not found: ${runtimeId}`)
    }
    const runtime = this.options.runtimes.get(context.agent)
    if (!runtime) {
      throw new Error(`agent runtime not found: ${context.agent}`)
    }
    await runtime.send({
      runtimeId,
      text
    })
  }
}
