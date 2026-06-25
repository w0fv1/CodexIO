import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { execa } from 'execa'
import { inject, injectable } from 'inversify'
import { Agent } from './Agent.js'
import { createProcessEnv } from '../util/ProcessEnvironment.js'
import { CodexAppServer, CodexAppServerRequestError } from './CodexAppServer.js'
import { CodexcClient, CodexcThread, CodexcThreadItem } from './CodexcClient.js'
import { CodexioMetadata } from '../component/CodexioMetadata.js'
import { Configer } from '../component/Configer.js'
import { Logger } from '../component/Logger.js'
import { ThreadManager } from '../component/ThreadManager.js'
import { isImageFile } from '../component/FileStore.js'
import { allIoThreadId, Message } from '../value/Message.js'
import { ChannelOutputManager } from '../channel/ChannelOutputManager.js'
import { CodexMessageStreamer } from './CodexMessageStreamer.js'
import { Result } from '../value/Result.js'
import { Thread } from '../value/Thread.js'

const codexEntryPath = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js')

export type CodexCommand = {
  command: string
  args: string[]
}

export function createCodexCommand(bundled: boolean | undefined, args: string[]): CodexCommand {
  if (bundled ?? false) {
    return {
      command: process.execPath,
      args: [
        codexEntryPath,
        ...args
      ]
    }
  }
  return {
    command: 'codex',
    args
  }
}

type CodexAppServerHandle = Pick<CodexAppServer, 'start' | 'request' | 'waitForNotification' | 'stop'>
type CodexcClientHandle = Pick<CodexcClient, 'start' | 'request' | 'waitForNotification' | 'refresh' | 'stop' | 'on'>

type ActiveCodexThread = Thread & {
  agentThreadId: string
}

const codexLoginInProgressMessage = '请先完成 Codex 登录。'

export class AgentLoginInProgressError extends Error {
  constructor(message = codexLoginInProgressMessage) {
    super(message)
    this.name = 'AgentLoginInProgressError'
  }
}

@injectable()
export class CodexAgent implements Agent {
  readonly type = 'codex'
  private started = false
  private client?: CodexcClientHandle
  private loginTask?: Promise<void>
  private readonly turnIdByIoThreadId = new Map<string, string>()
  private readonly disposeClientListeners: Array<() => void> = []

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(CodexioMetadata) private readonly metadata: CodexioMetadata,
    @inject(ChannelOutputManager) private readonly outputManager: ChannelOutputManager,
    @inject(CodexMessageStreamer) private readonly messageStreamer: CodexMessageStreamer,
    @inject(ThreadManager) private readonly threadManager: ThreadManager
  ) {}

  async login(): Promise<void> {
    const workspacePath = await this.configer.get('workspace.path')
    const bundled = await this.configer.get('agents.codex.bundled')
    const bundledEnabled = bundled ?? false
    const proxyEnabled = await this.configer.get('proxy.enabled')
    const proxyHost = await this.configer.get('proxy.host')
    const proxyPort = await this.configer.get('proxy.port')
    const serverHost = await this.configer.get('server.host')
    const codexHomePath = bundledEnabled ? this.metadata.codexHomePath : undefined
    Logger.info('codex login started', {
      cwd: workspacePath
    })
    const command = createCodexCommand(bundled, [
      'login',
      '--device-auth'
    ])
    await execa(command.command, command.args, {
      cwd: workspacePath,
      env: createProcessEnv(
        codexHomePath,
        codexHomePath ? join(codexHomePath, 'config.toml') : undefined,
        proxyEnabled ? `http://${proxyHost}:${proxyPort}` : undefined,
        proxyEnabled ? [
          'localhost',
          '127.0.0.1',
          '::1',
          serverHost
        ] : []
      ),
      stdio: 'inherit'
    })
    Logger.info('codex login completed')
  }

  async start(ioThreadId?: string): Promise<void> {
    if (this.started) {
      return
    }
    Logger.info('codex agent starting', {
      cwd: await this.configer.get('workspace.path')
    })
    if (!this.client) {
      this.client = await this.createCodexcClient()
      await this.client.start()
    }
    await this.ensureLoggedIn(ioThreadId)
    this.started = true
    await this.client.refresh()
    Logger.info('codex agent ready')
  }

  async receive(input: Message): Promise<void> {
    if (!this.started) {
      throw new Error('agent not started')
    }
    const thread = await this.ensureThread(input.ioThreadId)
    if (!this.client) {
      throw new Error('codex app-server not started')
    }
    const genericFiles = (input.files ?? []).filter((file) => !isImageFile(file))
    const text = genericFiles.length > 0
      ? `${input.text}\n\nFiles:\n${genericFiles.map((file) => file.path).join('\n')}`
      : input.text
    const turnInput: Array<Record<string, unknown>> = [
      {
        type: 'text',
        text,
        text_elements: []
      }
    ]
    for (const file of input.files ?? []) {
      if (isImageFile(file)) {
        turnInput.push({
          type: 'localImage',
          path: file.path,
          detail: 'auto'
        })
      }
    }
    const turnId = this.turnIdByIoThreadId.get(thread.id)
    if (turnId) {
      Logger.info('codex turn steered', {
        ioThreadId: thread.id,
        agentThreadId: thread.agentThreadId,
        turnId,
        length: input.text.length,
        files: input.files?.length ?? 0
      })
      await this.client.request('turn/steer', {
        threadId: thread.agentThreadId,
        expectedTurnId: turnId,
        input: turnInput
      })
      return
    }
    const response = await this.client.request('turn/start', {
      threadId: thread.agentThreadId,
      input: turnInput
    })
    if (!response || typeof response !== 'object') {
      throw new Error('codex turn response not found')
    }
    const turn = (response as Record<string, unknown>).turn
    if (!turn || typeof turn !== 'object' || typeof (turn as Record<string, unknown>).id !== 'string') {
      throw new Error('codex turn id not found')
    }
    this.turnIdByIoThreadId.set(thread.id, (turn as Record<string, string>).id)
    this.threadManager.setWorking(thread.id, true)
    Logger.info('codex turn started', {
      ioThreadId: thread.id,
      agentThreadId: thread.agentThreadId,
      turnId: this.turnIdByIoThreadId.get(thread.id),
      length: input.text.length,
      files: input.files?.length ?? 0
    })
  }

  async clear(ioThreadId: string): Promise<void> {
    const thread = this.threadManager.get(ioThreadId)
    Logger.info('codex agent clearing', {
      ioThreadId,
      agentThreadId: thread?.agentThreadId,
      turnId: this.turnIdByIoThreadId.get(ioThreadId)
    })
    if (thread?.agentThreadId) {
      await this.interruptActiveTurn(thread)
      this.messageStreamer.clearThread(ioThreadId)
      this.turnIdByIoThreadId.delete(ioThreadId)
      this.threadManager.remove(ioThreadId)
    }
    this.started = true
    if (this.client) {
      await this.startThread(ioThreadId)
    }
  }

  async stop(): Promise<void> {
    Logger.info('codex agent stopping', {
      threads: this.threadManager.list().length
    })
    for (const thread of this.threadManager.list()) {
      if (thread.agentThreadId) {
        await this.interruptActiveTurn(thread)
      }
    }
    await this.client?.stop()
    this.client = undefined
    this.disposeClientListeners.splice(0).forEach((dispose) => {
      dispose()
    })
    this.loginTask = undefined
    this.messageStreamer.clear()
    this.turnIdByIoThreadId.clear()
    this.threadManager.clear()
    this.started = false
  }

  private async startThread(ioThreadId: string): Promise<ActiveCodexThread> {
    if (!this.client) {
      throw new Error('codex app-server not started')
    }
    this.threadManager.ensure(ioThreadId)
    const response = await this.client.request('thread/start', {
      cwd: await this.configer.get('workspace.path'),
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      ephemeral: false,
      developerInstructions: await this.readDeveloperInstructions()
    })
    const agentThreadId = this.readThreadId(response)
    const thread = this.threadManager.bind(ioThreadId, agentThreadId) as ActiveCodexThread
    Logger.info('codex thread started', {
      ioThreadId,
      agentThreadId
    })
    return thread
  }

  private async readDeveloperInstructions(): Promise<string> {
    return readFile(join(this.metadata.rootPath, 'instruction.md'), 'utf8')
  }

  private readThreadId(response: unknown): string {
    if (!response || typeof response !== 'object') {
      throw new Error('codex thread response not found')
    }
    const thread = (response as Record<string, unknown>).thread
    if (!thread || typeof thread !== 'object' || typeof (thread as Record<string, unknown>).id !== 'string') {
      throw new Error('codex thread id not found')
    }
    return (thread as Record<string, string>).id
  }

  private async ensureThread(ioThreadId: string): Promise<ActiveCodexThread> {
    const existing = this.threadManager.get(ioThreadId)
    if (existing?.agentThreadId) {
      return existing as ActiveCodexThread
    }
    return this.startThread(ioThreadId)
  }

  private async interruptActiveTurn(thread: Thread): Promise<void> {
    const turnId = this.turnIdByIoThreadId.get(thread.id)
    if (thread.agentThreadId && turnId && this.client) {
      Logger.info('codex turn interrupt requested', {
        ioThreadId: thread.id,
        agentThreadId: thread.agentThreadId,
        turnId
      })
      await this.client.request('turn/interrupt', {
        threadId: thread.agentThreadId,
        turnId
      }).catch((error) => {
        Logger.warn('codex turn interrupt failed', {
          error: error instanceof Error ? error.message : String(error)
        })
      })
      this.threadManager.setWorking(thread.id, false)
    }
  }

  private async ensureLoggedIn(ioThreadId?: string): Promise<void> {
    if (!this.client) {
      throw new Error('codex app-server not started')
    }
    if (this.loginTask) {
      throw new AgentLoginInProgressError()
    }
    let status: unknown
    try {
      status = await this.client.request('account/read', {
        refreshToken: true
      })
    } catch (error) {
      if (this.isAuthenticationInvalidated(error)) {
        await this.requireLogin(ioThreadId)
      }
      throw error
    }
    if (status && typeof status === 'object' && (status as Record<string, unknown>).account) {
      Logger.info('codex account ready')
      return
    }
    await this.requireLogin(ioThreadId)
  }

  private async requireLogin(ioThreadId?: string): Promise<never> {
    Logger.warn('codex login required')
    await this.startDeviceLogin(ioThreadId)
    throw new AgentLoginInProgressError(codexLoginInProgressMessage)
  }

  private async startDeviceLogin(ioThreadId?: string): Promise<void> {
    if (!this.client) {
      throw new Error('codex app-server not started')
    }
    if (this.loginTask) {
      return
    }
    let login: unknown
    try {
      login = await this.client.request('account/login/start', {
        type: 'chatgptDeviceCode'
      })
    } catch (error) {
      const failed = Result.fromError(error)
      throw new Error([
        'Codex 登录请求失败，可能是网络或代理配置无法访问 OpenAI 登录服务。',
        '请在 config.yaml 开启或修正 proxy 配置后重试。',
        `原始错误：${failed.message}`
      ].join('\n'))
    }
    if (!login || typeof login !== 'object') {
      throw new Error('codex login response not found')
    }
    const data = login as Record<string, unknown>
    if (typeof data.verificationUrl !== 'string' || typeof data.userCode !== 'string') {
      throw new Error('codex login URL not found')
    }
    const message = [
      'Codex 登录已失效，请重新登录。',
      `打开：${data.verificationUrl}`,
      `验证码：${data.userCode}`
    ].join('\n')
    process.stdout.write(`${message}\n`)
    const loginMessage: Message = {
      ioThreadId: ioThreadId ?? allIoThreadId,
      role: 'agent',
      text: message,
      createdAt: Date.now()
    }
    await this.sendAgent(loginMessage)
    const client = this.client
    const task = (async () => {
      await client.waitForNotification('account/login/completed')
      const completedMessage = 'Codex 登录已完成。'
      process.stdout.write(`${completedMessage}\n`)
      const completionMessage: Message = {
        ioThreadId: ioThreadId ?? allIoThreadId,
        role: 'agent',
        text: completedMessage,
        createdAt: Date.now()
      }
      await this.sendAgent(completionMessage)
      await this.restartAfterLogin()
    })()
    this.loginTask = task
    void task.then(() => {
      if (this.loginTask === task) {
        this.loginTask = undefined
      }
      Logger.info('codex login notification completed')
    }, (error) => {
      if (this.loginTask === task) {
        this.loginTask = undefined
      }
      Logger.warn('codex login notification failed', {
        error: error instanceof Error ? error.message : String(error)
      })
    })
  }

  private async restartAfterLogin(): Promise<void> {
    const shouldRestart = this.started
    await this.stop()
    if (shouldRestart) {
      await this.start()
    }
  }

  private isAuthenticationInvalidated(error: unknown): boolean {
    if (error instanceof CodexAppServerRequestError && error.code === 401) {
      return true
    }
    const values = this.collectAuthenticationErrorValues(error).join('\n').toLowerCase()
    return [
      'refresh_token_invalidated',
      'token_invalidated',
      'refresh token was revoked',
      'authentication token has been invalidated',
      'session has ended',
      'please log out and sign in again',
      'please try signing in again'
    ].some((value) => values.includes(value))
  }

  private collectAuthenticationErrorValues(value: unknown): string[] {
    if (!value) {
      return []
    }
    if (typeof value === 'string') {
      return [
        value
      ]
    }
    if (value instanceof Error) {
      return [
        value.message,
        value.name,
        value.stack ?? ''
      ].filter((item) => item.length > 0)
    }
    if (typeof value !== 'object') {
      return [
        String(value)
      ]
    }
    const result: string[] = []
    for (const item of Object.values(value as Record<string, unknown>)) {
      result.push(...this.collectAuthenticationErrorValues(item))
    }
    return result
  }

  private async handleNotification(method: string, params: unknown): Promise<void> {
    if (!params || typeof params !== 'object') {
      return
    }
    const data = params as Record<string, unknown>
    const thread = this.resolveThread(data.threadId)
    if (method === 'thread/started') {
      const startedThread = data.thread
      const agentThreadId = readObjectString(startedThread, 'id')
      const existing = agentThreadId ? this.resolveThread(agentThreadId) : undefined
      const title = readObjectString(startedThread, 'name') ?? readObjectString(startedThread, 'preview')
      if (existing && title) {
        this.threadManager.setTitle(existing.id, title)
      }
      return
    }
    if (method === 'thread/name/updated') {
      if (thread && typeof data.threadName === 'string') {
        this.threadManager.setTitle(thread.id, data.threadName)
      }
      return
    }
    if (method === 'thread/status/changed') {
      const status = data.status
      if (thread && status && typeof status === 'object') {
        this.threadManager.setWorking(thread.id, (status as Record<string, unknown>).type === 'active')
      }
      return
    }
    if (method === 'turn/started') {
      const turn = data.turn
      if (thread && turn && typeof turn === 'object' && typeof (turn as Record<string, unknown>).id === 'string') {
        this.turnIdByIoThreadId.set(thread.id, (turn as Record<string, string>).id)
        this.threadManager.setWorking(thread.id, true)
      }
      return
    }
    if (method === 'item/agentMessage/delta') {
      if (thread && typeof data.itemId === 'string' && typeof data.delta === 'string') {
        await this.messageStreamer.append(streamThread(thread), data.itemId, data.delta)
      } else {
        Logger.warn('codex stream delta ignored', {
          hasThread: Boolean(thread),
          threadId: typeof data.threadId === 'string' ? data.threadId : null,
          itemIdType: typeof data.itemId,
          deltaType: typeof data.delta
        })
      }
      return
    }
    if (method === 'item/started') {
      const item = data.item
      if (item && typeof item === 'object' && (item as Record<string, unknown>).type === 'commandExecution' && typeof (item as Record<string, unknown>).command === 'string') {
        process.stdout.write(`\n$ ${(item as Record<string, string>).command}\n`)
      } else {
        Logger.info('codex item started', {
          type: readObjectString(item, 'type'),
          itemId: readObjectString(item, 'id'),
          threadId: readObjectString(data, 'threadId')
        })
      }
      return
    }
    if (method === 'item/completed') {
      const item = data.item
      if (item && typeof item === 'object' && (item as Record<string, unknown>).type === 'commandExecution' && typeof (item as Record<string, unknown>).aggregatedOutput === 'string') {
        process.stdout.write((item as Record<string, string>).aggregatedOutput)
      } else {
        if (thread && item && typeof item === 'object' && (item as Record<string, unknown>).type === 'agentMessage' && typeof (item as Record<string, unknown>).id === 'string') {
          await this.messageStreamer.completeItem(streamThread(thread), (item as Record<string, string>).id)
        }
        Logger.info('codex item completed', {
          type: readObjectString(item, 'type'),
          itemId: readObjectString(item, 'id'),
          threadId: readObjectString(data, 'threadId')
        })
      }
      return
    }
    if (method === 'turn/completed') {
      const turn = data.turn
      if (!thread || !turn || typeof turn !== 'object') {
        return
      }
      const turnId = (turn as Record<string, unknown>).id
      if (typeof turnId === 'string' && turnId === this.turnIdByIoThreadId.get(thread.id)) {
        this.turnIdByIoThreadId.delete(thread.id)
      }
      this.threadManager.setWorking(thread.id, false)
      const items = (turn as Record<string, unknown>).items
      const messages: Array<{ itemId: string, text: string }> = []
      if (Array.isArray(items)) {
        let index = 0
        for (const item of items) {
          if (item && typeof item === 'object' && (item as Record<string, unknown>).type === 'agentMessage' && typeof (item as Record<string, unknown>).text === 'string') {
            const text = (item as Record<string, string>).text.trim()
            if (text.length > 0) {
              const itemId = typeof (item as Record<string, unknown>).id === 'string' ? (item as Record<string, string>).id : `completed-${turnId}-${index}`
              messages.push({
                itemId,
                text
              })
            }
          }
          index += 1
        }
      }
      Logger.info('codex turn completed', {
        ioThreadId: thread.id,
        agentThreadId: thread.agentThreadId,
        turnId,
        agentMessages: messages.length
      })
      await this.messageStreamer.complete(streamThread(thread), messages)
      return
    }
    if (method === 'error') {
      const error = data.error
      if (error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string') {
        const message = (error as Record<string, string>).message
        Logger.error('codex notification error', new Error(message))
        if (thread) {
          this.threadManager.setWorking(thread.id, false)
        }
        if (this.isAuthenticationInvalidated(error)) {
          await this.startDeviceLogin(thread?.id ?? this.firstIoThreadId())
          return
        }
        await this.sendAgent({
          ioThreadId: thread?.id ?? this.firstIoThreadId() ?? allIoThreadId,
          role: 'agent',
          text: message,
          createdAt: Date.now()
        })
      }
      return
    }
    Logger.info('codex notification ignored', {
      method,
      threadId: readObjectString(data, 'threadId'),
      itemId: readObjectString(data, 'itemId'),
      itemType: readObjectString(data.item, 'type'),
      turnId: readObjectString(data.turn, 'id'),
      keys: Object.keys(data)
    })
  }

  private resolveThread(agentThreadId: unknown): ActiveCodexThread | undefined {
    if (typeof agentThreadId !== 'string') {
      return undefined
    }
    const thread = this.threadManager.getByAgentThreadId(agentThreadId)
    return thread?.agentThreadId ? thread as ActiveCodexThread : undefined
  }

  private firstIoThreadId(): string | undefined {
    return this.threadManager.list().at(0)?.id
  }

  private async sendAgent(message: Message): Promise<void> {
    await this.outputManager.sendAgent(message).catch(() => {})
  }

  protected async createCodexcClient(): Promise<CodexcClientHandle> {
    let client: CodexcClient
    const appServer = await this.createAppServer((method, params) => {
      client.handleNotification(method, params)
    })
    client = new CodexcClient({
      appServer,
      refreshIntervalMs: 5000
    })
    this.disposeClientListeners.push(client.on('notification', ({ method, params }) => {
      void this.handleNotification(method, params)
    }))
    this.disposeClientListeners.push(client.on('thread', (thread) => {
      this.syncCodexcThread(thread)
    }))
    this.disposeClientListeners.push(client.on('threadDeleted', (threadId) => {
      this.syncCodexcThreadDeleted(threadId)
    }))
    this.disposeClientListeners.push(client.on('item', (item) => {
      void this.syncCodexcItem(item)
    }))
    this.disposeClientListeners.push(client.on('error', (error) => {
      Logger.warn('codex client refresh failed', {
        error: error.message
      })
    }))
    return client
  }

  private syncCodexcThread(thread: CodexcThread): void {
    const existing = this.threadManager.getByAgentThreadId(thread.id)
    if (existing) {
      if (thread.title) {
        this.threadManager.setTitle(existing.id, thread.title)
      }
      this.threadManager.setWorking(existing.id, thread.isWorking)
      return
    }
    this.threadManager.bind(thread.id, thread.id)
    if (thread.title) {
      this.threadManager.setTitle(thread.id, thread.title)
    }
    this.threadManager.setWorking(thread.id, thread.isWorking)
  }

  private syncCodexcThreadDeleted(threadId: string): void {
    const existing = this.threadManager.getByAgentThreadId(threadId) ?? this.threadManager.get(threadId)
    if (existing) {
      this.threadManager.remove(existing.id)
    }
  }

  private async syncCodexcItem(item: CodexcThreadItem): Promise<void> {
    const thread = this.threadManager.getByAgentThreadId(item.threadId) ?? this.threadManager.get(item.threadId)
    if (!thread?.agentThreadId) {
      return
    }
    if (item.role === 'assistant') {
      await this.outputManager.sendAgent({
        ioThreadId: thread.id,
        role: 'agent',
        text: item.text,
        createdAt: Date.now(),
        source: 'codex'
      }).catch(() => {})
      return
    }
    if (item.role === 'user') {
      await this.outputManager.sendUser({
        ioThreadId: thread.id,
        role: 'user',
        text: item.text,
        createdAt: Date.now(),
        source: 'codex'
      }).catch(() => {})
    }
  }

  protected async createAppServer(onNotification: (method: string, params: unknown) => void): Promise<CodexAppServerHandle> {
    const bundled = await this.configer.get('agents.codex.bundled')
    const bundledEnabled = bundled ?? false
    const serverHost = await this.configer.get('server.host')
    const workspacePath = await this.configer.get('workspace.path')
    const proxyEnabled = await this.configer.get('proxy.enabled')
    const proxyHost = await this.configer.get('proxy.host')
    const proxyPort = await this.configer.get('proxy.port')
    const command = createCodexCommand(bundled, [
      'app-server',
      '--stdio'
    ])
    const codexHomePath = bundledEnabled ? this.metadata.codexHomePath : undefined
    return new CodexAppServer({
      command: command.command,
      args: command.args,
      cwd: workspacePath,
      env: createProcessEnv(
        codexHomePath,
        codexHomePath ? join(codexHomePath, 'config.toml') : undefined,
        proxyEnabled ? `http://${proxyHost}:${proxyPort}` : undefined,
        proxyEnabled ? [
          'localhost',
          '127.0.0.1',
          '::1',
          serverHost
        ] : []
      ),
      metadata: this.metadata,
      onNotification,
      onStderr: (data) => {
        Logger.warn('codex app-server stderr', {
          text: data.toString('utf8')
        })
        process.stderr.write(data)
      }
    })
  }
}

function readObjectString(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const item = (value as Record<string, unknown>)[key]
  return typeof item === 'string' ? item : null
}

function streamThread(thread: ActiveCodexThread): {
  ioThreadId: string
  agentThreadId: string
} {
  return {
    ioThreadId: thread.id,
    agentThreadId: thread.agentThreadId
  }
}
