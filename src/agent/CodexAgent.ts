import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { execa } from 'execa'
import { CodexioConfig } from '../ConfigService.js'
import { Agent } from './Agent.js'
import { createAgentEnv } from './AgentEnvironment.js'
import { CodexAppServer } from './CodexAppServer.js'
import { codexioRootPath } from '../AppMetadata.js'

const codexEntryPath = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js')

type CodexAppServerHandle = Pick<CodexAppServer, 'start' | 'request' | 'waitForNotification' | 'stop'>

export type CodexAgentOptions = {
  workspacePath: string
  config: CodexioConfig
  toolBaseUrl: string
  send: (text: string) => Promise<void>
  appServer?: CodexAppServerHandle
}

export class CodexAgent implements Agent {
  readonly type = 'codex'
  private started = false
  private threadId?: string
  private activeTurnId?: string
  private appServer?: CodexAppServerHandle
  private readonly messageByItemId = new Map<string, string>()

  constructor(private readonly options: CodexAgentOptions) {}

  async login(): Promise<void> {
    await execa(process.execPath, [
      codexEntryPath,
      'login',
      '--device-auth'
    ], {
      cwd: this.options.workspacePath,
      env: createAgentEnv(this.options.config),
      stdio: 'inherit'
    })
  }

  async start(_config: CodexioConfig): Promise<void> {
    this.appServer = this.options.appServer ?? new CodexAppServer({
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
        process.stderr.write(data)
      }
    })
    await this.appServer.start()
    this.started = true
    await this.ensureLoggedIn()
    await this.startThread()
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
  }

  async clear(): Promise<void> {
    if (this.threadId && this.activeTurnId && this.appServer) {
      await this.appServer.request('turn/interrupt', {
        threadId: this.threadId,
        turnId: this.activeTurnId
      }).catch(() => {})
    }
    this.activeTurnId = undefined
    this.threadId = undefined
    this.messageByItemId.clear()
    this.started = true
    if (this.appServer) {
      await this.startThread()
    }
  }

  async stop(): Promise<void> {
    if (this.threadId && this.activeTurnId && this.appServer) {
      await this.appServer.request('turn/interrupt', {
        threadId: this.threadId,
        turnId: this.activeTurnId
      }).catch(() => {})
    }
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
      ephemeral: true,
      developerInstructions: (await readFile(join(codexioRootPath, 'instruction.md'), 'utf8'))
        .replaceAll('${toolBaseUrl}', this.options.toolBaseUrl)
        .replaceAll('${token}', this.options.config.server.token)
    })
    if (!response || typeof response !== 'object') {
      throw new Error('codex thread response not found')
    }
    const thread = (response as Record<string, unknown>).thread
    if (!thread || typeof thread !== 'object' || typeof (thread as Record<string, unknown>).id !== 'string') {
      throw new Error('codex thread id not found')
    }
    this.threadId = (thread as Record<string, string>).id
    this.activeTurnId = undefined
    this.messageByItemId.clear()
  }

  private async ensureLoggedIn(): Promise<void> {
    if (!this.appServer) {
      throw new Error('codex app-server not started')
    }
    const status = await this.appServer.request('account/read', {
      refreshToken: false
    })
    if (status && typeof status === 'object' && (status as Record<string, unknown>).account) {
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
        await this.options.send((error as Record<string, string>).message)
      }
    }
  }
}
