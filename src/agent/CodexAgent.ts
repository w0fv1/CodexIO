import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { execa } from 'execa'
import { CodexioConfig } from '../config/ConfigDefinition.js'
import { Agent, AgentInput, AgentLoginInProgressError } from './Agent.js'
import { createAgentEnv } from './AgentEnvironment.js'
import { CodexAppServer } from './CodexAppServer.js'
import { codexioRootPath } from '../AppMetadata.js'
import { CodexSessionStore } from './CodexSessionStore.js'
import { Logger } from '../component/Logger.js'
import { isImageFile } from '../component/FileStore.js'

const codexEntryPath = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js')

export type CodexCommand = {
  command: string
  args: string[]
}

export function createCodexCommand(config: CodexioConfig, args: string[]): CodexCommand {
  if (config.agents.codex?.bundled ?? true) {
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
type CodexSessionStoreHandle = Pick<CodexSessionStore, 'read' | 'write' | 'clear'>

const codexLoginInProgressMessage = '请先完成 Codex 登录。'

export type CodexAgentOptions = {
  workspacePath: string
  config: CodexioConfig
  toolBaseUrl: string
  send: (text: string) => Promise<void>
  system?: (text: string) => Promise<void>
  onLoginRequired?: (message: string) => Promise<void>
  onLoginCompleted?: () => Promise<void>
  appServer?: CodexAppServerHandle
  sessionStore?: CodexSessionStoreHandle
}

export class CodexAgent implements Agent {
  readonly type = 'codex'
  private started = false
  private threadId?: string
  private activeTurnId?: string
  private appServer?: CodexAppServerHandle
  private loginTask?: Promise<void>
  private readonly sessionStore: CodexSessionStoreHandle
  private readonly messageByItemId = new Map<string, string>()

  constructor(private readonly options: CodexAgentOptions) {
    this.sessionStore = options.sessionStore ?? new CodexSessionStore()
  }

  async login(): Promise<void> {
    Logger.info('codex login started', {
      cwd: this.options.workspacePath
    })
    const command = createCodexCommand(this.options.config, [
      'login',
      '--device-auth'
    ])
    await execa(command.command, command.args, {
      cwd: this.options.workspacePath,
      env: createAgentEnv(this.options.config),
      stdio: 'inherit'
    })
    Logger.info('codex login completed')
  }

  async start(_config: CodexioConfig): Promise<void> {
    if (this.started) {
      return
    }
    Logger.info('codex agent starting', {
      cwd: this.options.workspacePath
    })
    if (!this.appServer) {
      this.appServer = this.createAppServer()
      await this.appServer.start()
    }
    await this.ensureLoggedIn()
    await this.resumeOrStartThread()
    this.started = true
    Logger.info('codex agent ready', {
      threadId: this.threadId
    })
  }

  private createAppServer(): CodexAppServerHandle {
    const command = createCodexCommand(this.options.config, [
      'app-server',
      '--stdio'
    ])
    const env = createAgentEnv(this.options.config, {
      codexio: {
        apiUrl: this.options.toolBaseUrl,
        token: this.options.config.server.token
      }
    })
    return this.options.appServer ?? new CodexAppServer({
      command: command.command,
      args: command.args,
      cwd: this.options.workspacePath,
      env,
      onNotification: (method, params) => {
        void this.handleNotification(method, params)
      },
      onStderr: (data) => {
        Logger.warn('codex app-server stderr', {
          text: data.toString('utf8')
        })
        process.stderr.write(data)
      }
    })
  }

  async receive(input: AgentInput): Promise<void> {
    if (!this.started) {
      throw new Error('agent not started')
    }
    if (!this.threadId) {
      await this.startThread()
    }
    if (!this.threadId || !this.appServer) {
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
    if (this.activeTurnId) {
      Logger.info('codex turn steered', {
        threadId: this.threadId,
        turnId: this.activeTurnId,
        length: input.text.length,
        files: input.files?.length ?? 0
      })
      await this.appServer.request('turn/steer', {
        threadId: this.threadId,
        expectedTurnId: this.activeTurnId,
        input: turnInput
      })
      return
    }
    const response = await this.appServer.request('turn/start', {
      threadId: this.threadId,
      input: turnInput
    })
    if (!response || typeof response !== 'object') {
      throw new Error('codex turn response not found')
    }
    const turn = (response as Record<string, unknown>).turn
    if (!turn || typeof turn !== 'object' || typeof (turn as Record<string, unknown>).id !== 'string') {
      throw new Error('codex turn id not found')
    }
    this.activeTurnId = (turn as Record<string, string>).id
    Logger.info('codex turn started', {
      threadId: this.threadId,
      turnId: this.activeTurnId,
      length: input.text.length,
      files: input.files?.length ?? 0
    })
  }

  async clear(): Promise<void> {
    Logger.info('codex agent clearing', {
      threadId: this.threadId,
      turnId: this.activeTurnId
    })
    await this.interruptActiveTurn()
    this.activeTurnId = undefined
    this.threadId = undefined
    this.messageByItemId.clear()
    this.started = true
    if (this.appServer) {
      await this.startThread()
    }
  }

  async stop(): Promise<void> {
    Logger.info('codex agent stopping', {
      threadId: this.threadId,
      turnId: this.activeTurnId
    })
    await this.interruptActiveTurn()
    await this.appServer?.stop()
    this.activeTurnId = undefined
    this.threadId = undefined
    this.appServer = undefined
    this.loginTask = undefined
    this.messageByItemId.clear()
    this.started = false
  }

  private async startThread(): Promise<void> {
    if (!this.appServer) {
      throw new Error('codex app-server not started')
    }
    const response = await this.appServer.request('thread/start', {
      cwd: this.options.workspacePath,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      ephemeral: false,
      developerInstructions: await this.readDeveloperInstructions()
    })
    this.threadId = this.readThreadId(response)
    this.activeTurnId = undefined
    this.messageByItemId.clear()
    await this.sessionStore.write(this.threadId)
    Logger.info('codex thread started', {
      threadId: this.threadId
    })
  }

  private async resumeOrStartThread(): Promise<void> {
    const session = await this.sessionStore.read()
    if (session?.threadId) {
      try {
        Logger.info('codex thread resume requested', {
          threadId: session.threadId
        })
        await this.resumeThread(session.threadId)
        return
      } catch (error) {
        Logger.warn('codex thread resume failed', {
          threadId: session.threadId,
          error: error instanceof Error ? error.message : String(error)
        })
        await this.sessionStore.clear()
      }
    }
    await this.startThread()
  }

  private async resumeThread(threadId: string): Promise<void> {
    if (!this.appServer) {
      throw new Error('codex app-server not started')
    }
    const response = await this.appServer.request('thread/resume', {
      threadId,
      cwd: this.options.workspacePath,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      developerInstructions: await this.readDeveloperInstructions()
    })
    this.threadId = this.readThreadId(response)
    this.activeTurnId = undefined
    this.messageByItemId.clear()
    await this.sessionStore.write(this.threadId)
    Logger.info('codex thread resumed', {
      threadId: this.threadId
    })
  }

  private async readDeveloperInstructions(): Promise<string> {
    return (await readFile(join(codexioRootPath, 'instruction.md'), 'utf8'))
      .replaceAll('${toolBaseUrl}', this.options.toolBaseUrl)
      .replaceAll('${token}', this.options.config.server.token)
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

  private async interruptActiveTurn(): Promise<void> {
    if (this.threadId && this.activeTurnId && this.appServer) {
      Logger.info('codex turn interrupt requested', {
        threadId: this.threadId,
        turnId: this.activeTurnId
      })
      await this.appServer.request('turn/interrupt', {
        threadId: this.threadId,
        turnId: this.activeTurnId
      }).catch((error) => {
        Logger.warn('codex turn interrupt failed', {
          error: error instanceof Error ? error.message : String(error)
        })
      })
    }
  }

  private async ensureLoggedIn(): Promise<void> {
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
        await this.requireLogin()
      }
      throw error
    }
    if (status && typeof status === 'object' && (status as Record<string, unknown>).account) {
      Logger.info('codex account ready')
      return
    }
    await this.requireLogin()
  }

  private async requireLogin(): Promise<never> {
    Logger.warn('codex login required')
    await this.startDeviceLogin()
    throw new AgentLoginInProgressError(codexLoginInProgressMessage)
  }

  private async startDeviceLogin(): Promise<void> {
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
    await (this.options.system ?? this.options.send)(message).catch(() => {})
    const appServer = this.appServer
    const task = (async () => {
      await appServer.waitForNotification('account/login/completed')
      const completedMessage = 'Codex login completed.'
      process.stdout.write(`${completedMessage}\n`)
      await (this.options.system ?? this.options.send)(completedMessage).catch(() => {})
      await this.restartAfterLogin()
      await this.options.onLoginCompleted?.()
    })()
    this.loginTask = task
    await this.options.onLoginRequired?.(codexLoginInProgressMessage)
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
      await this.start(this.options.config)
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
    if (method === 'turn/started') {
      const turn = data.turn
      if (typeof data.threadId === 'string' && data.threadId === this.threadId && turn && typeof turn === 'object' && typeof (turn as Record<string, unknown>).id === 'string') {
        this.activeTurnId = (turn as Record<string, string>).id
      }
      return
    }
    if (method === 'item/agentMessage/delta') {
      if (typeof data.threadId === 'string' && data.threadId === this.threadId && typeof data.itemId === 'string' && typeof data.delta === 'string') {
        const current = this.messageByItemId.get(data.itemId) ?? ''
        this.messageByItemId.set(data.itemId, current + data.delta)
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
      if (typeof data.threadId !== 'string' || data.threadId !== this.threadId || !turn || typeof turn !== 'object') {
        return
      }
      const turnId = (turn as Record<string, unknown>).id
      if (typeof turnId === 'string' && turnId === this.activeTurnId) {
        this.activeTurnId = undefined
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
        for (const value of this.messageByItemId.values()) {
          const text = value.trim()
          if (text.length > 0) {
            messages.push(text)
          }
        }
      }
      this.messageByItemId.clear()
      if (messages.length > 0) {
        await this.options.send(messages.join('\n\n'))
      }
      return
    }
    if (method === 'error') {
      const error = data.error
      if (error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string') {
        const message = (error as Record<string, string>).message
        Logger.error('codex notification error', new Error(message))
        if (this.isAuthenticationInvalidated(error)) {
          await this.startDeviceLogin()
          return
        }
        await (this.options.system ?? this.options.send)(message)
      }
    }
  }
}
