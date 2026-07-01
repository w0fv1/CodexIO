import { inject, injectable } from 'inversify'
import { AppEvent, ChannelMessageReceivedEvent } from '../../value/Event.js'
import { Message } from '../../value/Message.js'
import { Result } from '../../value/Result.js'
import { Configer } from '../Configer.js'
import { EventBus } from '../EventBus.js'
import { IoThreadIdManager } from '../IoThreadIdManager.js'
import { Logger } from '../Logger.js'
import { Agent } from './Agent.js'
import { CodexClient, CodexClientLoginEvent, CodexClientMessage } from './CodexClient.js'
import { CodexMessageStreamer } from './CodexMessageStreamer.js'

@injectable()
export class CodexAgent implements Agent {
  readonly type = 'codex'
  private started = false
  private loginIoThreadId?: string
  private readonly threadIdByIoThreadId = new Map<string, string>()
  private readonly ioThreadIdByThreadId = new Map<string, string>()
  private readonly emittedErrors = new Set<string>()
  private readonly disposers: Array<() => void> = []

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(EventBus) private readonly eventBus: EventBus,
    @inject(IoThreadIdManager) private readonly ioThreadIdManager: IoThreadIdManager,
    @inject(CodexClient) private readonly client: CodexClient,
    @inject(CodexMessageStreamer) private readonly messageStreamer: CodexMessageStreamer
  ) {}

  async start(): Promise<Result<void>> {
    if (this.started) {
      return Result.successVoid()
    }
    this.disposers.push(
      this.client.on('message', (message) => {
        void this.receiveCodexMessage(message)
      }),
      this.client.on('login', (login) => {
        void this.receiveLogin(login)
      }),
      this.client.on('error', (error) => {
        Logger.warn('codex agent client error', {
          message: error.message
        })
        void this.receiveClientError(error)
      })
    )
    const started = await this.client.start()
    if (started.isFailed) {
      this.clearListeners()
      return started
    }
    this.started = true
    Logger.info('codex agent ready')
    return Result.successVoid()
  }

  async receive(event: ChannelMessageReceivedEvent): Promise<Result<void>> {
    if (!this.started) {
      const started = await this.start()
      if (started.isFailed) {
        return started
      }
    }
    this.loginIoThreadId = event.message.ioThreadId
    const loggedIn = await this.client.login()
    if (loggedIn.isFailed) {
      return Result.fail(loggedIn.message)
    }
    if (!loggedIn.data) {
      return Result.successVoid()
    }
    const sent = await this.client.send({
      threadId: this.threadIdByIoThreadId.get(event.message.ioThreadId),
      text: event.message.text,
      files: event.message.files
    })
    if (sent.isFailed) {
      return Result.fail(sent.message)
    }
    if (sent.data) {
      this.bindThread(event.message.ioThreadId, sent.data.threadId)
    }
    Logger.info('codex agent received channel message', {
      inputType: event.inputType,
      ioThreadId: event.message.ioThreadId,
      threadId: sent.data?.threadId,
      turnId: sent.data?.turnId,
      text: event.message.text,
      files: event.message.files?.length ?? 0
    })
    return Result.successVoid()
  }

  async stop(): Promise<Result<void>> {
    this.clearListeners()
    this.started = false
    this.loginIoThreadId = undefined
    this.threadIdByIoThreadId.clear()
    this.ioThreadIdByThreadId.clear()
    this.messageStreamer.clear()
    this.emittedErrors.clear()
    return this.client.stop()
  }

  private async receiveLogin(login: CodexClientLoginEvent): Promise<void> {
    const ioThreadId = this.loginIoThreadId ?? this.ioThreadIdManager.getLastActiveIoThreadId()
    if (!ioThreadId) {
      return
    }
    await this.sendAgent({
      ioThreadId,
      role: 'agent',
      text: login.loginCompleted
        ? 'Codex 登录已完成。'
        : [
            'Codex 需要登录。',
            `打开：${login.verificationUrl}`,
            `验证码：${login.userCode}`
          ].join('\n')
    })
  }

  private async receiveCodexMessage(message: CodexClientMessage): Promise<void> {
    const ioThreadId = this.ioThreadIdByThreadId.get(message.threadId)
    if (!ioThreadId) {
      return
    }
    if (message.status === 'started') {
      return
    }
    if (message.status === 'delta' && message.text.length > 0) {
      if (!message.itemId) {
        return
      }
      await this.messageStreamer.append({
        ioThreadId,
        agentThreadId: message.threadId
      }, message.itemId, message.text)
      return
    }
    if (message.status === 'completed') {
      if (message.itemId && message.messages.length <= 1) {
        await this.messageStreamer.completeItem({
          ioThreadId,
          agentThreadId: message.threadId
        }, message.itemId, message.messages[0]?.text)
        return
      }
      await this.messageStreamer.complete({
        ioThreadId,
        agentThreadId: message.threadId
      }, message.messages.map((completed) => {
        return {
          itemId: completed.itemId,
          text: completed.text
        }
      }))
      return
    }
    if (message.status === 'failed' && message.text.trim().length > 0) {
      this.messageStreamer.clearThread(ioThreadId)
      await this.sendAgent({
        ioThreadId,
        role: 'agent',
        text: message.text
      })
    }
  }

  private async receiveClientError(error: Error): Promise<void> {
    const ioThreadId = this.loginIoThreadId ?? this.ioThreadIdManager.getLastActiveIoThreadId()
    if (!ioThreadId) {
      return
    }
    const text = await this.formatClientError(error)
    const key = `${ioThreadId}:${text}`
    if (this.emittedErrors.has(key)) {
      return
    }
    this.emittedErrors.add(key)
    await this.sendAgent({
      ioThreadId,
      role: 'agent',
      text
    })
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
    this.threadIdByIoThreadId.set(ioThreadId, threadId)
    this.ioThreadIdByThreadId.set(threadId, ioThreadId)
  }

  private async sendAgent(message: Message): Promise<void> {
    const results = await this.eventBus.emitAsync(AppEvent.ChannelMessageSendRequested, {
      message
    })
    for (const result of results) {
      if (result.isFailed) {
        Logger.warn('codex agent output failed', {
          message: result.message
        })
      }
    }
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
