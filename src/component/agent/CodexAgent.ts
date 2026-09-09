import { inject, injectable } from 'inversify'
import { UserverAgentClient } from '@w0fv1/uclient-js/agent'
import { createMessage, deriveMessageId, Message } from '../../value/Message.js'
import { Result } from '../../value/Result.js'
import { Configer } from '../Configer.js'
import { ThreadRegistry } from '../ThreadRegistry.js'
import { Logger } from '../Logger.js'
import { KeyedSerialQueue } from '../KeyedSerialQueue.js'
import { Agent, AgentOutputReceiver } from './Agent.js'
import { CodexClient, CodexClientLoginCompletion, CodexClientLoginRequired, CodexClientMessage } from './codex/CodexClient.js'
import { codexCompletedMessageId, CodexMessageAssembler } from './codex/CodexMessageAssembler.js'

@injectable()
export class CodexAgent implements Agent {
  readonly type = 'codex'
  private started = false
  private readonly loginIoThreadIdsByLoginId = new Map<string, Set<string>>()
  private agentScope?: string
  private readonly lastOccurredAtByThreadId = new Map<string, number>()
  private readonly disposers: Array<() => void> = []
  private readonly mailbox = new KeyedSerialQueue()
  private lifecycleGeneration = 0
  private startPromise?: Promise<Result<void>>
  private stopPromise?: Promise<Result<void>>
  private outputReceiver?: AgentOutputReceiver

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(ThreadRegistry) private readonly threadRegistry: ThreadRegistry,
    @inject(CodexClient) private readonly client: CodexClient,
    @inject(CodexMessageAssembler) private readonly messageAssembler: CodexMessageAssembler
  ) {}

  start(receiver: AgentOutputReceiver): Promise<Result<void>> {
    this.outputReceiver = receiver
    this.messageAssembler.start(receiver)
    if (this.started) {
      return this.client.start()
    }
    if (this.startPromise) {
      return this.startPromise
    }
    const generation = this.lifecycleGeneration
    const stopping = this.stopPromise
    const startPromise = (async (): Promise<Result<void>> => {
      if (stopping) {
        await stopping
      }
      if (generation !== this.lifecycleGeneration) {
        return Result.fail('codex agent start superseded')
      }
      this.agentScope = await this.client.identityScope()
      this.disposers.push(
        this.client.on('message', (message) => {
          void this.mailbox.run(message.thread.id, () => this.receiveCodexMessage(message)).catch((error) => {
            Logger.error('codex live message ingestion failed', error)
            const thread = this.resolveThread(message.thread)
            if (thread) this.outputReceiver?.completeAgentTurn?.(thread.id, String(error))
          })
        }),
        this.client.on('login', (completion) => {
          void this.receiveLoginCompletion(completion).catch((error) => {
            Logger.error('codex login message failed', error)
          })
        })
      )
      const started = await this.client.start()
      if (generation !== this.lifecycleGeneration) {
        return Result.fail('codex agent start superseded')
      }
      if (started.isFailed) {
        this.clearListeners()
        return started
      }
      this.started = true
      Logger.info('codex agent ready')
      return Result.successVoid()
    })()
    this.startPromise = startPromise
    void startPromise.then(() => {
      if (this.startPromise === startPromise) {
        this.startPromise = undefined
      }
    }, () => {
      if (this.startPromise === startPromise) {
        this.startPromise = undefined
      }
    })
    return startPromise
  }

  async receive(message: Message): Promise<Result<void>> {
    if (!this.outputReceiver) {
      return Result.fail('codex agent output receiver not ready')
    }
    const started = await this.start(this.outputReceiver)
    if (started.isFailed) {
      return started
    }
    const login = await this.client.login()
    if (login.isFailed) {
      return Result.fail(await this.formatClientError(new Error(login.message)))
    }
    if (login.data?.status === 'loginRequired') {
      const ioThreadIds = this.loginIoThreadIdsByLoginId.get(login.data.loginId) ?? new Set<string>()
      ioThreadIds.add(message.thread.id)
      this.loginIoThreadIdsByLoginId.set(login.data.loginId, ioThreadIds)
      const notified = await this.receiveLoginRequired(message.thread.id, login.data)
      return notified.isFailed ? notified : Result.fail('Codex login required')
    }
    const agentScope = this.requireAgentScope()
    const mappedThreadId = this.threadRegistry.getAgentThreadId(message.thread.id, this.type, agentScope)
    Logger.info('codex agent routing channel message', {
      messageId: message.id,
      ioThreadId: message.thread.id,
      mappedThreadId: mappedThreadId ?? null,
      bindings: this.threadRegistry.getChannelThreadIds(message.thread.id)
    })
    const connection = await this.configer.get('channeli.userver')
    const binding = this.threadRegistry.getChannelThreadIds(message.thread.id).find(value => value.source === 'userver')
    let mcpServers: import('./codex/CodexProtocol.js').CodexClientInput['mcpServers']
    if (binding && connection?.mcpUrl) {
      const identity = await new UserverAgentClient(connection).me()
      const [origin, site, agent] = JSON.parse(binding.id) as [string, number, string]
      if (origin !== new URL(connection.baseUrl).origin || site !== connection.websiteId || agent !== identity.uuid) return Result.fail('Userver Agent connection does not match thread')
      mcpServers = { site: { url: connection.mcpUrl, http_headers: { Authorization: `Bearer ${connection.secret}` }, required: true } }
    }
    const sent = await this.client.send({
      thread: message.thread,
      threadId: mappedThreadId,
      text: message.text,
      files: message.files,
      mcpServers,
      threadResolved: (threadId) => {
        this.threadRegistry.bindAgentThread(message.thread.id, this.type, agentScope, threadId)
        Logger.info('codex agent bound thread identity', {
          ioThreadId: message.thread.id,
          threadId,
          agentScope
        })
      }
    })
    if (sent.isFailed) {
      return Result.fail(await this.formatClientError(new Error(sent.message)))
    }
    Logger.info('codex agent received channel message', {
      ioThreadId: message.thread.id,
      threadId: sent.data?.threadId,
      turnId: sent.data?.turnId,
      text: message.text,
      files: message.files?.length ?? 0
    })
    return Result.successVoid()
  }

  stop(): Promise<Result<void>> {
    this.lifecycleGeneration += 1
    this.startPromise = undefined
    if (this.stopPromise) {
      return this.stopPromise
    }
    this.clearListeners()
    this.started = false
    const stopPromise = (async (): Promise<Result<void>> => {
      const stopped = await this.client.stop()
      await this.mailbox.drain()
      this.loginIoThreadIdsByLoginId.clear()
      this.agentScope = undefined
      this.lastOccurredAtByThreadId.clear()
      this.messageAssembler.clear()
      this.outputReceiver = undefined
      return stopped
    })()
    this.stopPromise = stopPromise
    void stopPromise.then(() => {
      if (this.stopPromise === stopPromise) {
        this.stopPromise = undefined
      }
    }, () => {
      if (this.stopPromise === stopPromise) {
        this.stopPromise = undefined
      }
    })
    return stopPromise
  }

  private receiveLoginRequired(ioThreadId: string, login: CodexClientLoginRequired): Promise<Result<void>> {
    return this.sendAgent(createMessage({
      id: deriveMessageId('codex-login-required', login.loginId, ioThreadId),
      thread: this.threadRegistry.ensure(ioThreadId),
      role: 'agent',
      text: [
        'Codex 需要登录。',
        `打开：${login.verificationUrl}`,
        `验证码：${login.userCode}`
      ].join('\n')
    }))
  }

  private async receiveLoginCompletion(completion: CodexClientLoginCompletion): Promise<void> {
    const ioThreadIds = this.loginIoThreadIdsByLoginId.get(completion.loginId)
    if (!ioThreadIds) {
      Logger.warn('codex ignored login completion without input context', {
        loginId: completion.loginId
      })
      return
    }
    this.loginIoThreadIdsByLoginId.delete(completion.loginId)
    await Promise.all([...ioThreadIds].map((ioThreadId) => this.sendAgent(createMessage({
      id: deriveMessageId('codex-login-completed', completion.loginId, ioThreadId),
      thread: this.threadRegistry.ensure(ioThreadId),
      role: 'agent',
      text: completion.success
        ? 'Codex 登录已完成。'
        : `Codex 登录失败。${completion.error ? `\n${completion.error}` : ''}`
    }))))
  }

  private async receiveCodexMessage(message: CodexClientMessage): Promise<void> {
    if (message.status === 'started') {
      return
    }
    const thread = this.resolveThread(message.thread)
    if (!thread) {
      Logger.warn('codex agent ignored unbound thread message', {
        threadId: message.thread.id,
        status: message.status
      })
      return
    }
    if (message.status === 'delta' && message.text.length > 0) {
      this.messageAssembler.append({
        thread,
        agentThreadId: message.thread.id,
        turnId: message.turnId,
        occurredAt: this.messageOccurredAt(message)
      }, message.itemId, message.text)
      return
    }
    if (message.status === 'itemCompleted') {
      await this.messageAssembler.completeItem({
        thread,
        agentThreadId: message.thread.id,
        turnId: message.turnId,
        occurredAt: this.messageOccurredAt(message)
      }, message.itemId, message.messages[0]?.text ?? '')
      return
    }
    if (message.status === 'progressCompleted') {
      await this.sendAgent(createMessage({
        id: deriveMessageId('codex-progress', message.thread.id, message.turnId, message.itemId),
        occurredAt: this.messageOccurredAt(message),
        thread,
        role: 'agent',
        text: message.text
      }))
      return
    }
    if (message.status === 'turnCompleted') {
      await this.messageAssembler.complete({
        thread,
        agentThreadId: message.thread.id,
        turnId: message.turnId,
        occurredAt: this.messageOccurredAt(message)
      }, message.messages.map((completed) => {
        return {
          itemId: completed.itemId,
          text: completed.text
        }
      }))
      this.outputReceiver?.completeAgentTurn?.(thread.id)
      return
    }
    if (message.status === 'failed') {
      this.outputReceiver?.completeAgentTurn?.(thread.id, message.text || 'Codex turn failed')
      this.messageAssembler.clearTurn(message.thread.id, message.turnId)
      if (message.text.trim().length === 0) {
        return
      }
      await this.sendAgent(createMessage({
        id: deriveMessageId('codex-turn-error', message.thread.id, message.turnId),
        thread,
        role: 'agent',
        text: message.text
      }))
    }
  }

  private resolveThread(agentThread: CodexClientMessage['thread']): Message['thread'] | undefined {
    const ioThreadId = this.agentScope
      ? this.threadRegistry.getIoThreadIdByAgentThread(this.type, this.agentScope, agentThread.id)
      : undefined
    if (!ioThreadId) {
      return undefined
    }
    return this.threadRegistry.ensure(ioThreadId)
  }

  private async formatClientError(error: Error): Promise<string> {
    const proxyEnabled = await this.configer.get('proxy.enabled')
    if (!proxyEnabled && isNetworkOrRegionError(error.message)) {
      return [
        error.message,
        '',
        '当前 proxy.enabled=false。请在配置页开启代理，或在 config.yaml 设置：',
        'proxy:',
        '  enabled: true',
        '  host: 127.0.0.1',
        '  port: 7890'
      ].join('\n')
    }
    return error.message
  }

  private requireAgentScope(): string {
    if (!this.agentScope) {
      throw new Error('codex agent scope not initialized')
    }
    return this.agentScope
  }

  private nextOccurredAt(threadId: string): number {
    const occurredAt = Math.max(Date.now(), (this.lastOccurredAtByThreadId.get(threadId) ?? 0) + 1)
    this.lastOccurredAtByThreadId.set(threadId, occurredAt)
    return occurredAt
  }

  private messageOccurredAt(message: CodexClientMessage): number {
    if (message.occurredAt === undefined) {
      return this.nextOccurredAt(message.thread.id)
    }
    this.lastOccurredAtByThreadId.set(
      message.thread.id,
      Math.max(message.occurredAt, this.lastOccurredAtByThreadId.get(message.thread.id) ?? 0)
    )
    return message.occurredAt
  }

  private async sendAgent(message: Message): Promise<Result<void>> {
    if (!this.outputReceiver) {
      return Result.fail('codex agent output receiver not ready')
    }
    const result = await this.outputReceiver.receiveAgentOutput(message)
    if (result.isFailed) {
      Logger.warn('codex agent output failed', {
        message: result.message
      })
    }
    return result
  }

  private clearListeners(): void {
    this.disposers.splice(0).forEach((dispose) => {
      dispose()
    })
  }
}

function isNetworkOrRegionError(message: string): boolean {
  const lower = message.toLowerCase()
  return lower.includes('地区')
    || lower.includes('区域')
    || lower.includes('network')
    || lower.includes('网络')
    || lower.includes('unsupported_country_region_territory')
}
