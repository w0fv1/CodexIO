import { inject, injectable } from 'inversify'
import { createMessage, deriveMessageId, Message } from '../../value/Message.js'
import { Result } from '../../value/Result.js'
import { Configer } from '../Configer.js'
import { ThreadRegistry } from '../ThreadRegistry.js'
import { Logger } from '../Logger.js'
import { KeyedSerialQueue } from '../KeyedSerialQueue.js'
import { Agent, AgentInput } from './Agent.js'
import { ChannelOutputManager } from '../channelo/ChannelOutputManager.js'
import { CodexClient, CodexClientLoginEvent, CodexClientMessage, CodexClientThread, CodexThreadSnapshot } from './CodexClient.js'
import { codexMessageId, CodexMessageStreamer } from './CodexMessageStreamer.js'

@injectable()
export class CodexAgent implements Agent {
  readonly type = 'codex'
  private started = false
  private loginIoThreadId?: string
  private readonly threadIdByIoThreadId = new Map<string, string>()
  private readonly ioThreadIdByThreadId = new Map<string, string>()
  private readonly sourceByIoThreadId = new Map<string, AgentInput['source']>()
  private readonly sourceMessageIdByIoThreadId = new Map<string, string>()
  private readonly lastOccurredAtByThreadId = new Map<string, number>()
  private readonly disposers: Array<() => void> = []
  private readonly mailbox = new KeyedSerialQueue()
  private lifecycleGeneration = 0
  private startPromise?: Promise<Result<void>>
  private stopPromise?: Promise<Result<void>>

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(ChannelOutputManager) private readonly outputManager: ChannelOutputManager,
    @inject(ThreadRegistry) private readonly threadRegistry: ThreadRegistry,
    @inject(CodexClient) private readonly client: CodexClient,
    @inject(CodexMessageStreamer) private readonly messageStreamer: CodexMessageStreamer
  ) {}

  start(): Promise<Result<void>> {
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
      this.disposers.push(
        this.client.on('message', (message) => {
          void this.mailbox.run(message.thread.id, () => this.receiveCodexMessage(message)).catch((error) => {
            Logger.error('codex live message ingestion failed', error)
          })
        }),
        this.client.on('snapshot', (snapshot) => {
          return this.mailbox.run(snapshot.thread.id, () => this.receiveCodexSnapshot(snapshot))
        }),
        this.client.on('thread', (thread) => {
          this.receiveCodexThread(thread)
        }),
        this.client.on('login', (login) => {
          void this.receiveLogin(login).catch((error) => {
            Logger.error('codex login message failed', error)
          })
        }),
        this.client.on('error', (error) => {
          Logger.warn('codex agent client error', {
            message: error.message
          })
          void this.receiveClientError(error).catch((receiveError) => {
            Logger.error('codex client error message failed', receiveError)
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

  async receive(event: AgentInput): Promise<Result<void>> {
    const started = await this.start()
    if (started.isFailed) {
      return started
    }
    this.loginIoThreadId = event.message.thread.id
    this.sourceByIoThreadId.set(event.message.thread.id, event.source)
    this.bindSourceMessageId(event.message.thread.id, event.sourceMessageId)
    const loggedIn = await this.client.login()
    if (loggedIn.isFailed) {
      return Result.fail(loggedIn.message)
    }
    if (!loggedIn.data) {
      return Result.successVoid()
    }
    const mappedThreadId = this.threadIdByIoThreadId.get(event.message.thread.id)
    Logger.info('codex agent routing channel message', {
      source: event.source,
      sourceMessageId: event.sourceMessageId ?? null,
      messageId: event.message.id,
      ioThreadId: event.message.thread.id,
      mappedThreadId: mappedThreadId ?? null,
      bindings: this.threadRegistry.getChannelThreadIds(event.message.thread.id)
    })
    const sent = await this.client.send({
      thread: event.message.thread,
      threadId: mappedThreadId,
      text: event.message.text,
      files: event.message.files
    })
    if (sent.isFailed) {
      return Result.fail(sent.message)
    }
    if (sent.data) {
      this.bindThread(event.message.thread.id, sent.data.threadId)
    }
    Logger.info('codex agent received channel message', {
      source: event.source,
      ioThreadId: event.message.thread.id,
      threadId: sent.data?.threadId,
      turnId: sent.data?.turnId,
      text: event.message.text,
      files: event.message.files?.length ?? 0
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
      this.loginIoThreadId = undefined
      this.threadIdByIoThreadId.clear()
      this.ioThreadIdByThreadId.clear()
      this.sourceByIoThreadId.clear()
      this.sourceMessageIdByIoThreadId.clear()
      this.lastOccurredAtByThreadId.clear()
      this.messageStreamer.clear()
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

  private async receiveLogin(login: CodexClientLoginEvent): Promise<void> {
    const ioThreadId = this.loginIoThreadId ?? this.threadRegistry.getLastActive()?.id
    if (!ioThreadId) {
      return
    }
    const source = this.sourceByIoThreadId.get(ioThreadId)
    const sourceMessageId = this.sourceMessageIdByIoThreadId.get(ioThreadId)
    await this.sendAgent(createMessage({
      id: deriveMessageId('codex-login', ioThreadId),
      thread: this.threadRegistry.ensure(ioThreadId),
      role: 'agent',
      text: login.loginCompleted
        ? 'Codex 登录已完成。'
        : [
            'Codex 需要登录。',
            `打开：${login.verificationUrl}`,
            `验证码：${login.userCode}`
          ].join('\n')
    }), source, sourceMessageId)
  }

  private async receiveCodexMessage(message: CodexClientMessage): Promise<void> {
    const thread = this.resolveThread(message.thread)
    const ioThreadId = thread.id
    if (message.status === 'started') {
      return
    }
    if (message.status === 'delta' && message.text.length > 0) {
      const source = this.sourceByIoThreadId.get(ioThreadId)
      const sourceMessageId = this.sourceMessageIdByIoThreadId.get(ioThreadId)
      await this.messageStreamer.append({
        thread,
        agentThreadId: message.thread.id,
        turnId: message.turnId,
        source,
        sourceMessageId,
        occurredAt: this.messageOccurredAt(message)
      }, message.itemId, message.text)
      return
    }
    if (message.status === 'itemCompleted') {
      const source = this.sourceByIoThreadId.get(ioThreadId)
      const sourceMessageId = this.sourceMessageIdByIoThreadId.get(ioThreadId)
      await this.messageStreamer.stageItem({
        thread,
        agentThreadId: message.thread.id,
        turnId: message.turnId,
        source,
        sourceMessageId,
        occurredAt: this.messageOccurredAt(message),
        sequence: message.messages[0]?.sequence
      }, message.itemId, message.messages[0]?.text ?? '')
      return
    }
    if (message.status === 'turnCompleted') {
      const source = this.sourceByIoThreadId.get(ioThreadId)
      const sourceMessageId = this.sourceMessageIdByIoThreadId.get(ioThreadId)
      await this.messageStreamer.complete({
        thread,
        agentThreadId: message.thread.id,
        turnId: message.turnId,
        source,
        sourceMessageId,
        occurredAt: this.messageOccurredAt(message)
      }, message.messages.map((completed) => {
        return {
          itemId: completed.itemId,
          text: completed.text,
          sequence: completed.sequence
        }
      }))
      return
    }
    if (message.status === 'failed') {
      this.messageStreamer.clearTurn(message.thread.id, message.turnId)
      if (message.text.trim().length === 0) {
        return
      }
      await this.sendAgent(createMessage({
        id: deriveMessageId('codex-turn-error', message.thread.id, message.turnId),
        thread,
        role: 'agent',
        text: message.text
      }), this.sourceByIoThreadId.get(ioThreadId), this.sourceMessageIdByIoThreadId.get(ioThreadId))
    }
  }

  private async receiveCodexSnapshot(snapshot: CodexThreadSnapshot): Promise<void> {
    const thread = this.resolveThread(snapshot.thread)
    const source = this.sourceByIoThreadId.get(thread.id)
    const sourceMessageId = this.sourceMessageIdByIoThreadId.get(thread.id)
    for (const snapshotMessage of snapshot.messages) {
      const result = await this.sendAgent(createMessage({
        id: codexMessageId(snapshot.thread.id, snapshotMessage.turnId, snapshotMessage.itemId),
        occurredAt: snapshotMessage.completedAt * 1000,
        sequence: snapshotMessage.sequence,
        thread,
        role: 'agent',
        text: snapshotMessage.text
      }), source, sourceMessageId)
      if (result.isFailed) {
        throw new Error(result.message)
      }
    }
  }

  private async receiveClientError(error: Error): Promise<void> {
    const ioThreadId = this.loginIoThreadId ?? this.threadRegistry.getLastActive()?.id
    if (!ioThreadId) {
      return
    }
    const text = await this.formatClientError(error)
    await this.sendAgent(createMessage({
      id: deriveMessageId('codex-client-error', ioThreadId, text),
      thread: this.threadRegistry.ensure(ioThreadId),
      role: 'agent',
      text
    }), this.sourceByIoThreadId.get(ioThreadId), this.sourceMessageIdByIoThreadId.get(ioThreadId))
  }

  private receiveCodexThread(thread: CodexClientThread): void {
    const ioThreadId = this.ioThreadIdByThreadId.get(thread.id)
    if (!ioThreadId || thread.deleted || !thread.title.trim()) {
      return
    }
    this.threadRegistry.rename(ioThreadId, thread.title)
  }

  private resolveThread(agentThread: CodexClientMessage['thread']): Message['thread'] {
    let ioThreadId = this.ioThreadIdByThreadId.get(agentThread.id)
    const resolution = ioThreadId ? 'mapped' : 'canonical'
    if (!ioThreadId) {
      ioThreadId = agentThread.id
      this.bindThread(ioThreadId, agentThread.id)
    }
    const currentThread = this.threadRegistry.ensure(ioThreadId)
    Logger.info('codex agent resolved agent thread', {
      resolution,
      agentThreadId: agentThread.id,
      ioThreadId,
      bindings: this.threadRegistry.getChannelThreadIds(ioThreadId)
    })
    return agentThread.name === '新对话' && currentThread.name !== '新对话'
      ? currentThread
      : this.threadRegistry.rename(ioThreadId, agentThread.name)
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

  private bindThread(ioThreadId: string, threadId: string): void {
    const previousThreadId = this.threadIdByIoThreadId.get(ioThreadId)
    const previousIoThreadId = this.ioThreadIdByThreadId.get(threadId)
    this.threadIdByIoThreadId.set(ioThreadId, threadId)
    this.ioThreadIdByThreadId.set(threadId, ioThreadId)
    Logger.info('codex agent bound thread identity', {
      ioThreadId,
      threadId,
      previousThreadId: previousThreadId ?? null,
      previousIoThreadId: previousIoThreadId ?? null,
      changed: previousThreadId !== threadId || previousIoThreadId !== ioThreadId
    })
  }

  private bindSourceMessageId(ioThreadId: string, sourceMessageId?: string): void {
    const normalized = sourceMessageId?.trim()
    if (normalized) {
      this.sourceMessageIdByIoThreadId.set(ioThreadId, normalized)
    }
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

  private async sendAgent(
    message: Message,
    source?: AgentInput['source'],
    sourceMessageId?: string
  ): Promise<Result<void>> {
    const result = await this.outputManager.sendAgent(message, {
      source,
      sourceMessageId
    })
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
