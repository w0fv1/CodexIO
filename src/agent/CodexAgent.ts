import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { execa } from 'execa'
import { inject, injectable } from 'inversify'
import { Agent } from './Agent.js'
import { createProcessEnv } from '../util/ProcessEnvironment.js'
import { CodexAppServer } from './CodexAppServer.js'
import { CodexioMetadata } from '../component/CodexioMetadata.js'
import { Configer } from '../component/Configer.js'
import { Logger } from '../component/Logger.js'
import { isImageFile } from '../component/FileStore.js'
import { allIoThreadId, Message } from '../value/Message.js'
import { AgentMessageClient } from './AgentMessageClient.js'

const codexEntryPath = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js')

export type CodexCommand = {
  command: string
  args: string[]
}

export function createCodexCommand(bundled: boolean | undefined, args: string[]): CodexCommand {
  if (bundled ?? true) {
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

type CodexThread = {
  ioThreadId: string
  agentThreadId: string
  turnId?: string
  messages: Map<string, string>
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
  private appServer?: CodexAppServerHandle
  private loginTask?: Promise<void>
  private readonly threads = new Map<string, CodexThread>()
  private readonly ioThreadIdByAgentThreadId = new Map<string, string>()

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(CodexioMetadata) private readonly metadata: CodexioMetadata,
    @inject(AgentMessageClient) private readonly messageClient: AgentMessageClient
  ) {}

  async login(): Promise<void> {
    const workspacePath = await this.configer.get('workspace.path')
    const bundled = await this.configer.get('agents.codex.bundled')
    const bundledEnabled = bundled ?? true
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
    if (!this.appServer) {
      this.appServer = await this.createAppServer((method, params) => {
        void this.handleNotification(method, params)
      })
      await this.appServer.start()
    }
    await this.ensureLoggedIn(ioThreadId)
    this.started = true
    Logger.info('codex agent ready')
  }

  async receive(input: Message): Promise<void> {
    if (!this.started) {
      throw new Error('agent not started')
    }
    const thread = await this.ensureThread(input.ioThreadId)
    if (!this.appServer) {
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
    if (thread.turnId) {
      Logger.info('codex turn steered', {
        ioThreadId: thread.ioThreadId,
        agentThreadId: thread.agentThreadId,
        turnId: thread.turnId,
        length: input.text.length,
        files: input.files?.length ?? 0
      })
      await this.appServer.request('turn/steer', {
        threadId: thread.agentThreadId,
        expectedTurnId: thread.turnId,
        input: turnInput
      })
      return
    }
    const response = await this.appServer.request('turn/start', {
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
    thread.turnId = (turn as Record<string, string>).id
    Logger.info('codex turn started', {
      ioThreadId: thread.ioThreadId,
      agentThreadId: thread.agentThreadId,
      turnId: thread.turnId,
      length: input.text.length,
      files: input.files?.length ?? 0
    })
  }

  async clear(ioThreadId: string): Promise<void> {
    const thread = this.threads.get(ioThreadId)
    Logger.info('codex agent clearing', {
      ioThreadId,
      agentThreadId: thread?.agentThreadId,
      turnId: thread?.turnId
    })
    if (thread) {
      await this.interruptActiveTurn(thread)
      this.ioThreadIdByAgentThreadId.delete(thread.agentThreadId)
      this.threads.delete(ioThreadId)
    }
    this.started = true
    if (this.appServer) {
      await this.startThread(ioThreadId)
    }
  }

  async stop(): Promise<void> {
    Logger.info('codex agent stopping', {
      threads: this.threads.size
    })
    for (const thread of this.threads.values()) {
      await this.interruptActiveTurn(thread)
    }
    await this.appServer?.stop()
    this.appServer = undefined
    this.loginTask = undefined
    this.threads.clear()
    this.ioThreadIdByAgentThreadId.clear()
    this.started = false
  }

  private async startThread(ioThreadId: string): Promise<CodexThread> {
    if (!this.appServer) {
      throw new Error('codex app-server not started')
    }
    const response = await this.appServer.request('thread/start', {
      cwd: await this.configer.get('workspace.path'),
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      ephemeral: false,
      developerInstructions: await this.readDeveloperInstructions(ioThreadId)
    })
    const agentThreadId = this.readThreadId(response)
    const thread: CodexThread = {
      ioThreadId,
      agentThreadId,
      messages: new Map<string, string>()
    }
    this.threads.set(ioThreadId, thread)
    this.ioThreadIdByAgentThreadId.set(agentThreadId, ioThreadId)
    Logger.info('codex thread started', {
      ioThreadId,
      agentThreadId
    })
    return thread
  }

  private async readDeveloperInstructions(ioThreadId: string): Promise<string> {
    const serverHost = await this.configer.get('server.host')
    const serverPort = await this.configer.get('server.port')
    const token = await this.configer.get('server.token')
    return (await readFile(join(this.metadata.rootPath, 'instruction.md'), 'utf8'))
      .replaceAll('${toolBaseUrl}', `http://${serverHost}:${serverPort}`)
      .replaceAll('${token}', token)
      .replaceAll('${ioThreadId}', ioThreadId)
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

  private async ensureThread(ioThreadId: string): Promise<CodexThread> {
    const existing = this.threads.get(ioThreadId)
    if (existing) {
      return existing
    }
    return this.startThread(ioThreadId)
  }

  private async interruptActiveTurn(thread: CodexThread): Promise<void> {
    if (thread.turnId && this.appServer) {
      Logger.info('codex turn interrupt requested', {
        ioThreadId: thread.ioThreadId,
        agentThreadId: thread.agentThreadId,
        turnId: thread.turnId
      })
      await this.appServer.request('turn/interrupt', {
        threadId: thread.agentThreadId,
        turnId: thread.turnId
      }).catch((error) => {
        Logger.warn('codex turn interrupt failed', {
          error: error instanceof Error ? error.message : String(error)
        })
      })
    }
  }

  private async ensureLoggedIn(ioThreadId?: string): Promise<void> {
    if (!this.appServer) {
      throw new Error('codex app-server not started')
    }
    if (this.loginTask) {
      throw new AgentLoginInProgressError()
    }
    let status: unknown
    try {
      status = await this.appServer.request('account/read', {
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
    if (!this.appServer) {
      throw new Error('codex app-server not started')
    }
    if (this.loginTask) {
      return
    }
    const login = await this.appServer.request('account/login/start', {
      type: 'chatgptDeviceCode'
    })
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
      `验证码：${data.userCode}`,
      '登录完成后 Codexio 会自动恢复。'
    ].join('\n')
    process.stdout.write(`${message}\n`)
    const loginMessage: Message = {
      ioThreadId: ioThreadId ?? allIoThreadId,
      role: 'agent',
      text: message,
      createdAt: Date.now()
    }
    await this.sendSystem(loginMessage)
    const appServer = this.appServer
    const task = (async () => {
      await appServer.waitForNotification('account/login/completed')
      const completedMessage = 'Codex login completed.'
      process.stdout.write(`${completedMessage}\n`)
      const completionMessage: Message = {
        ioThreadId: ioThreadId ?? allIoThreadId,
        role: 'agent',
        text: completedMessage,
        createdAt: Date.now()
      }
      await this.sendSystem(completionMessage)
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
    if (method === 'turn/started') {
      const turn = data.turn
      if (thread && turn && typeof turn === 'object' && typeof (turn as Record<string, unknown>).id === 'string') {
        thread.turnId = (turn as Record<string, string>).id
      }
      return
    }
    if (method === 'item/agentMessage/delta') {
      if (thread && typeof data.itemId === 'string' && typeof data.delta === 'string') {
        const current = thread.messages.get(data.itemId) ?? ''
        thread.messages.set(data.itemId, current + data.delta)
      }
      return
    }
    if (method === 'item/started') {
      const item = data.item
      if (item && typeof item === 'object' && (item as Record<string, unknown>).type === 'commandExecution' && typeof (item as Record<string, unknown>).command === 'string') {
        process.stdout.write(`\n$ ${(item as Record<string, string>).command}\n`)
      }
      return
    }
    if (method === 'item/completed') {
      const item = data.item
      if (item && typeof item === 'object' && (item as Record<string, unknown>).type === 'commandExecution' && typeof (item as Record<string, unknown>).aggregatedOutput === 'string') {
        process.stdout.write((item as Record<string, string>).aggregatedOutput)
      }
      return
    }
    if (method === 'turn/completed') {
      const turn = data.turn
      if (!thread || !turn || typeof turn !== 'object') {
        return
      }
      const turnId = (turn as Record<string, unknown>).id
      if (typeof turnId === 'string' && turnId === thread.turnId) {
        thread.turnId = undefined
      }
      const items = (turn as Record<string, unknown>).items
      const messages: string[] = []
      if (Array.isArray(items)) {
        for (const item of items) {
          if (item && typeof item === 'object' && (item as Record<string, unknown>).type === 'agentMessage' && typeof (item as Record<string, unknown>).text === 'string') {
            const text = (item as Record<string, string>).text.trim()
            if (text.length > 0) {
              messages.push(text)
            }
          }
        }
      }
      if (messages.length === 0) {
        for (const value of thread.messages.values()) {
          const text = value.trim()
          if (text.length > 0) {
            messages.push(text)
          }
        }
      }
      thread.messages.clear()
      if (messages.length > 0) {
        await this.messageClient.send({
          ioThreadId: thread.ioThreadId,
          role: 'agent',
          text: messages.join('\n\n'),
          createdAt: Date.now()
        })
      }
      return
    }
    if (method === 'error') {
      const error = data.error
      if (error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string') {
        const message = (error as Record<string, string>).message
        Logger.error('codex notification error', new Error(message))
        if (this.isAuthenticationInvalidated(error)) {
          await this.startDeviceLogin(thread?.ioThreadId ?? this.firstIoThreadId())
          return
        }
        await this.sendSystem({
          ioThreadId: thread?.ioThreadId ?? this.firstIoThreadId() ?? allIoThreadId,
          role: 'agent',
          text: message,
          createdAt: Date.now()
        })
      }
    }
  }

  private resolveThread(agentThreadId: unknown): CodexThread | undefined {
    if (typeof agentThreadId !== 'string') {
      return undefined
    }
    const ioThreadId = this.ioThreadIdByAgentThreadId.get(agentThreadId)
    if (!ioThreadId) {
      return undefined
    }
    return this.threads.get(ioThreadId)
  }

  private firstIoThreadId(): string | undefined {
    return this.threads.keys().next().value
  }

  private async sendSystem(message: Message): Promise<void> {
    await this.messageClient.send(message).catch(() => {})
  }

  protected async createAppServer(onNotification: (method: string, params: unknown) => void): Promise<CodexAppServerHandle> {
    const bundled = await this.configer.get('agents.codex.bundled')
    const bundledEnabled = bundled ?? true
    const serverHost = await this.configer.get('server.host')
    const serverPort = await this.configer.get('server.port')
    const serverToken = await this.configer.get('server.token')
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
        ] : [],
        {
          CODEXIO_API_URL: `http://${serverHost}:${serverPort}`,
          CODEXIO_TOKEN: serverToken
        }
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
