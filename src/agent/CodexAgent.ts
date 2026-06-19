import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { execa } from 'execa'
import { CodexioConfig } from '../ConfigService.js'
import { Agent } from './Agent.js'
import { createAgentEnv } from './AgentEnvironment.js'
import { CodexAppServer } from './CodexAppServer.js'
import { codexioRootPath } from '../AppMetadata.js'
import { CodexSessionStore } from './CodexSessionStore.js'
import { Logger } from '../component/Logger.js'

const codexEntryPath = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js')

type CodexAppServerHandle = Pick<CodexAppServer, 'start' | 'request' | 'waitForNotification' | 'stop'>
type CodexSessionStoreHandle = Pick<CodexSessionStore, 'read' | 'write' | 'clear'>

export type CodexAgentOptions = {
  workspacePath: string
  config: CodexioConfig
  toolBaseUrl: string
  send: (text: string) => Promise<void>
  appServer?: CodexAppServerHandle
  sessionStore?: CodexSessionStoreHandle
}

export class CodexAgent implements Agent {
  readonly type = 'codex'
  private started = false
  private threadId?: string
  private activeTurnId?: string
  private appServer?: CodexAppServerHandle
  private readonly sessionStore: CodexSessionStoreHandle
  private readonly messageByItemId = new Map<string, string>()

  constructor(private readonly options: CodexAgentOptions) {
    this.sessionStore = options.sessionStore ?? new CodexSessionStore()
  }

  async login(): Promise<void> {
    Logger.info('codex login started', {
      cwd: this.options.workspacePath
    })
    await execa(process.execPath, [
      codexEntryPath,
      'login',
      '--device-auth'
    ], {
      cwd: this.options.workspacePath,
      env: createAgentEnv(this.options.config),
      stdio: 'inherit'
    })
    Logger.info('codex login completed')
  }

  async start(_config: CodexioConfig): Promise<void> {
    Logger.info('codex agent starting', {
      cwd: this.options.workspacePath
    })
    this.appServer = this.createAppServer()
    await this.appServer.start()
    this.started = true
    await this.ensureLoggedIn()
    await this.resumeOrStartThread()
    Logger.info('codex agent ready', {
      threadId: this.threadId
    })
  }

  private createAppServer(): CodexAppServerHandle {
    return this.options.appServer ?? new CodexAppServer({
      command: process.execPath,
      args: [
        codexEntryPath,
        'app-server',
        '--stdio'
      ],
      cwd: this.options.workspacePath,
      env: createAgentEnv(this.options.config),
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

  async receive(text: string): Promise<void> {
    if (!this.started) {
      throw new Error('agent not started')
    }
    if (!this.threadId) {
      await this.startThread()
    }
    if (!this.threadId || !this.appServer) {
      throw new Error('codex app-server not started')
    }
    const input = [
      {
        type: 'text',
        text,
        text_elements: []
      }
    ]
    if (this.activeTurnId) {
      Logger.info('codex turn steered', {
        threadId: this.threadId,
        turnId: this.activeTurnId,
        length: text.length
      })
      await this.appServer.request('turn/steer', {
        threadId: this.threadId,
        expectedTurnId: this.activeTurnId,
        input
      })
      return
    }
    const response = await this.appServer.request('turn/start', {
      threadId: this.threadId,
      input
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
      length: text.length
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

  async restart(): Promise<void> {
    Logger.info('codex agent restarting', {
      threadId: this.threadId,
      turnId: this.activeTurnId
    })
    await this.interruptActiveTurn()
    await this.appServer?.stop()
    this.activeTurnId = undefined
    this.threadId = undefined
    this.messageByItemId.clear()
    this.appServer = undefined
    this.started = false
    this.appServer = this.createAppServer()
    await this.appServer.start()
    this.started = true
    await this.ensureLoggedIn()
    await this.resumeOrStartThread()
    Logger.info('codex agent restarted', {
      threadId: this.threadId
    })
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
    const status = await this.appServer.request('account/read', {
      refreshToken: false
    })
    if (status && typeof status === 'object' && (status as Record<string, unknown>).account) {
      Logger.info('codex account ready')
      return
    }
    Logger.warn('codex login required')
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
      'Codex login required.',
      `Open: ${data.verificationUrl}`,
      `Code: ${data.userCode}`
    ].join('\n')
    process.stdout.write(`${message}\n`)
    await this.options.send(message).catch(() => {})
    await this.appServer.waitForNotification('account/login/completed')
    const completedMessage = 'Codex login completed.'
    process.stdout.write(`${completedMessage}\n`)
    await this.options.send(completedMessage).catch(() => {})
    Logger.info('codex login notification completed')
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
        Logger.error('codex notification error', new Error((error as Record<string, string>).message))
        await this.options.send((error as Record<string, string>).message)
      }
    }
  }
}
