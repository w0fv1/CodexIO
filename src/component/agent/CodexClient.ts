import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { inject, injectable } from 'inversify'
import { execa } from 'execa'
import { Configer } from '../Configer.js'
import { CodexioMetadata } from '../CodexioMetadata.js'
import { Logger } from '../Logger.js'
import { createProcessEnv } from '../../util/ProcessEnvironment.js'
import { MessageFile } from '../../value/Message.js'
import { Result } from '../../value/Result.js'

const codexEntryPath = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js')

type RpcMessage = {
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: {
    code: number
    message: string
  }
}

export type CodexClientThread = {
  id: string
  title: string
  isWorking: boolean
}

export type CodexClientInput = {
  threadId?: string
  text: string
  files?: MessageFile[]
}

export type CodexClientTurn = {
  threadId: string
  turnId: string
}

export type CodexClientCompletedMessage = {
  itemId: string
  role: 'assistant'
  text: string
}

export type CodexClientMessage = {
  threadId: string
  turnId: string
  itemId?: string
  status: 'started' | 'delta' | 'completed' | 'failed'
  role: 'assistant'
  text: string
  messages: CodexClientCompletedMessage[]
}

export type CodexClientLoginEvent = {
  verificationUrl: string
  userCode: string
  loginCompleted: boolean
}

export type CodexClientEventMap = {
  thread: (thread: CodexClientThread) => void
  message: (message: CodexClientMessage) => void
  login: (login: CodexClientLoginEvent) => void
  error: (error: Error) => void
}

type CodexClientRuntimeConfig = {
  bundled: boolean
  command: string
  args: string[]
  cwd: string
  codexHomePath?: string
  proxyUrl?: string
  noProxyHosts: string[]
  developerInstructions: string
  requestTimeoutMs: number
}

type CodexChildExit = {
  exitCode?: number
  signal?: string
  stderr?: unknown
}

@injectable()
export class CodexClient {
  private readonly events = new EventEmitter()
  private readonly threads = new Map<string, CodexClientThread>()
  private readonly turnIdByThreadId = new Map<string, string>()
  private child?: ReturnType<typeof execa>
  private nextRequestId = 1
  private started = false
  private loginStarted = false
  private loginEvent?: CodexClientLoginEvent
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timeout: NodeJS.Timeout
  }>()

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(CodexioMetadata) private readonly metadata: CodexioMetadata
  ) {}

  on<K extends keyof CodexClientEventMap>(event: K, listener: CodexClientEventMap[K]): () => void {
    this.events.on(event, listener)
    return () => {
      this.events.off(event, listener)
    }
  }

  async start(): Promise<Result<void>> {
    if (this.started) {
      return Result.successVoid()
    }
    try {
      const config = await this.readRuntimeConfig()
      const env = createProcessEnv(
        config.codexHomePath,
        config.codexHomePath ? `${config.codexHomePath}/config.toml` : undefined,
        config.proxyUrl,
        config.noProxyHosts
      )
      Logger.info('codex client starting', {
        cwd: config.cwd,
        bundled: config.bundled,
        command: config.command,
        args: config.args
      })
      const child = execa(config.command, config.args, {
        cwd: config.cwd,
        env,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        reject: false
      })
      this.child = child
      if (!child.stdout || !child.stdin) {
        return Result.fail('codex app-server stdio not available')
      }
      createInterface({
        input: child.stdout
      }).on('line', (line) => this.receiveLine(line))
      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString('utf8')
        Logger.warn('codex app-server stderr', {
          text
        })
        const error = readCodexStderrError(text)
        if (error) {
          this.emitError(error)
        }
      })
      void child.then((result) => {
        Logger.info('codex app-server exited', {
          exitCode: result.exitCode,
          signal: result.signal
        })
        this.handleChildClosed(child, new Error(formatChildExit(result)))
      }).catch((error) => {
        Logger.error('codex app-server failed', error)
        this.handleChildClosed(child, error instanceof Error ? error : new Error(String(error)))
      })
      await this.request('initialize', {
        clientInfo: {
          name: 'codexio',
          title: 'Codexio',
          version: this.metadata.readVersion()
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false
        }
      }, config.requestTimeoutMs)
      child.stdin.write(`${JSON.stringify({
        method: 'initialized',
        params: {}
      })}\n`)
      this.started = true
      Logger.info('codex client ready')
      return Result.successVoid()
    } catch (error) {
      await this.stop()
      return failFromError(error)
    }
  }

  async stop(): Promise<Result<void>> {
    const stopped = new Error('codex client stopped')
    this.rejectPending(stopped)
    this.failLogin(stopped)
    this.started = false
    this.loginStarted = false
    this.loginEvent = undefined
    this.turnIdByThreadId.clear()
    this.threads.clear()
    const child = this.child
    this.child = undefined
    if (!child) {
      return Result.successVoid()
    }
    child.kill('SIGTERM')
    await Promise.race([
      child.catch(() => {}),
      new Promise<void>((resolve) => {
        setTimeout(resolve, 2000)
      })
    ])
    return Result.successVoid()
  }

  async login(): Promise<Result<boolean>> {
    try {
      const account = await this.request('account/read', {
        refreshToken: true
      })
      if (account && typeof account === 'object' && (account as Record<string, unknown>).account) {
        return Result.success(true)
      }
    } catch (error) {
      if (!this.isAuthenticationInvalidated(error)) {
        return failFromError(error)
      }
    }

    if (this.loginStarted) {
      return Result.success(false)
    }

    try {
      const response = await this.request('account/login/start', {
        type: 'chatgptDeviceCode'
      })
      if (!response || typeof response !== 'object') {
        return Result.fail('codex login response not found')
      }
      const verificationUrl = (response as Record<string, unknown>).verificationUrl
      const userCode = (response as Record<string, unknown>).userCode
      if (typeof verificationUrl !== 'string' || typeof userCode !== 'string') {
        return Result.fail('codex login URL not found')
      }
      const login = {
        verificationUrl,
        userCode,
        loginCompleted: false
      }
      this.loginEvent = login
      this.loginStarted = true
      this.events.emit('login', login)
      return Result.success(false)
    } catch (error) {
      return failFromError(error)
    }
  }

  async send(input: CodexClientInput): Promise<Result<CodexClientTurn>> {
    const normalizedThreadId = input.threadId?.trim() ?? ''
    if (input.text.trim().length === 0 && (!input.files || input.files.length === 0)) {
      return Result.fail('text or file is required')
    }
    try {
      const threadId = normalizedThreadId.length > 0 && this.threads.has(normalizedThreadId)
        ? normalizedThreadId
        : (await this.startThread()).id
      const turnInput = this.toTurnInput(input)
      const activeTurnId = this.turnIdByThreadId.get(threadId)
      if (activeTurnId) {
        await this.request('turn/steer', {
          threadId,
          expectedTurnId: activeTurnId,
          input: turnInput
        })
        return Result.success({
          threadId,
          turnId: activeTurnId
        })
      }
      const response = await this.request('turn/start', {
        threadId,
        input: turnInput
      })
      if (!response || typeof response !== 'object') {
        throw new Error('codex turn response not found')
      }
      const turn = (response as Record<string, unknown>).turn
      const turnId = readString(turn, 'id')
      if (!turnId) {
        throw new Error('codex turn id not found')
      }
      const result = {
        threadId: readString(response, 'threadId') ?? readString(turn, 'threadId') ?? threadId,
        turnId
      }
      this.turnIdByThreadId.set(threadId, turnId)
      this.emitMessage({
        threadId: result.threadId,
        turnId,
        status: 'started',
        text: '',
        messages: []
      })
      return Result.success(result)
    } catch (error) {
      return failFromError(error)
    }
  }

  private async startThread(): Promise<CodexClientThread> {
    const config = await this.readRuntimeConfig()
    const response = await this.request('thread/start', {
      cwd: config.cwd,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      ephemeral: false,
      developerInstructions: config.developerInstructions
    })
    if (!response || typeof response !== 'object') {
      throw new Error('codex thread response not found')
    }
    const thread = this.readThread((response as Record<string, unknown>).thread)
    if (!thread) {
      throw new Error('codex thread id not found')
    }
    this.upsertThread(thread)
    return thread
  }

  private async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (!this.child?.stdin) {
      throw new Error('codex client not started')
    }
    const id = this.nextRequestId
    this.nextRequestId += 1
    const timeout = timeoutMs ?? (await this.readRuntimeConfig()).requestTimeoutMs
    const result = new Promise<unknown>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`codex app-server request timed out: ${method}`))
      }, timeout)
      this.pendingRequests.set(id, {
        resolve,
        reject,
        timeout: timeoutHandle
      })
    })
    this.child.stdin.write(`${JSON.stringify({
      method,
      id,
      params
    })}\n`)
    return result
  }

  private receiveLine(line: string): void {
    let message: RpcMessage
    try {
      message = JSON.parse(line) as RpcMessage
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      Logger.warn('codex app-server invalid JSON', {
        reason
      })
      return
    }
    if (typeof message.id === 'number') {
      const pending = this.pendingRequests.get(message.id)
      if (!pending) {
        return
      }
      this.pendingRequests.delete(message.id)
      clearTimeout(pending.timeout)
      if (message.error) {
        pending.reject(new Error(message.error.message))
        return
      }
      pending.resolve(message.result)
      return
    }
    if (message.method) {
      this.handleNotification(message.method, message.params)
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === 'account/login/completed') {
      this.loginStarted = false
      if (this.loginEvent) {
        this.loginEvent = {
          ...this.loginEvent,
          loginCompleted: true
        }
        this.events.emit('login', this.loginEvent)
      }
      return
    }
    if (!params || typeof params !== 'object') {
      return
    }
    const data = params as Record<string, unknown>
    switch (method) {
      case 'thread/started': {
        const thread = this.readThread(data.thread)
        if (thread) {
          this.upsertThread(thread)
        }
        return
      }
      case 'thread/name/updated': {
        const threadId = readString(data, 'threadId')
        if (threadId && typeof data.threadName === 'string') {
          this.upsertThread({
            id: threadId,
            title: data.threadName,
            isWorking: this.threads.get(threadId)?.isWorking ?? false
          })
        }
        return
      }
      case 'thread/status/changed': {
        const threadId = readString(data, 'threadId')
        if (threadId) {
          this.upsertThread({
            id: threadId,
            title: this.threads.get(threadId)?.title ?? '',
            isWorking: this.isActiveStatus(data.status)
          })
        }
        return
      }
      case 'turn/started': {
        const threadId = readString(data, 'threadId')
        const turnId = readString(data.turn, 'id')
        if (threadId && turnId) {
          this.turnIdByThreadId.set(threadId, turnId)
          this.emitMessage({
            threadId,
            turnId,
            status: 'started',
            text: '',
            messages: []
          })
        }
        return
      }
      case 'item/agentMessage/delta': {
        const threadId = readString(data, 'threadId')
        const itemId = readString(data, 'itemId')
        const delta = readString(data, 'delta')
        const turnId = readString(data, 'turnId') ?? (threadId ? this.turnIdByThreadId.get(threadId) : undefined)
        if (threadId && turnId && itemId && delta) {
          this.emitMessage({
            threadId,
            turnId,
            itemId,
            status: 'delta',
            text: delta,
            messages: []
          })
        }
        return
      }
      case 'turn/completed':
        this.handleTurnCompleted(data)
        return
      case 'thread/deleted':
      case 'thread/archived':
      case 'thread/closed': {
        const threadId = readString(data, 'threadId')
        if (threadId) {
          this.threads.delete(threadId)
        }
        return
      }
      case 'error': {
        const error = data.error
        if (this.isAuthenticationInvalidated(error)) {
          void this.login()
          return
        }
        const threadId = readString(data, 'threadId')
        const turnId = threadId ? this.turnIdByThreadId.get(threadId) : undefined
        if (threadId && turnId) {
          this.emitMessage({
            threadId,
            turnId,
            status: 'failed',
            text: readString(error, 'message') ?? 'codex notification error',
            messages: []
          })
          this.turnIdByThreadId.delete(threadId)
        }
        this.emitError(new Error(readString(error, 'message') ?? 'codex notification error'))
      }
    }
  }

  private handleTurnCompleted(data: Record<string, unknown>): void {
    const threadId = readString(data, 'threadId')
    const turn = data.turn
    const turnId = readString(turn, 'id')
    if (!threadId || !turnId) {
      return
    }
    this.turnIdByThreadId.delete(threadId)
    this.upsertThread({
      id: threadId,
      title: this.threads.get(threadId)?.title ?? '',
      isWorking: false
    })
    const items = turn && typeof turn === 'object' && Array.isArray((turn as Record<string, unknown>).items)
      ? (turn as Record<string, unknown>).items as unknown[]
      : []
    const messages = items.flatMap((item, index): CodexClientCompletedMessage[] => {
        const type = readString(item, 'type')
        const text = readString(item, 'text')
        if (type === 'agentMessage' && text && text.trim().length > 0) {
          return [{
            itemId: readString(item, 'id') ?? `completed-${turnId}-${index}`,
            role: 'assistant',
            text
          }]
        }
        return []
      })
    this.emitMessage({
      threadId,
      turnId,
      status: 'completed',
      text: '',
      messages
    })
  }

  private toTurnInput(input: CodexClientInput): Array<Record<string, unknown>> {
    const files = input.files ?? []
    const genericFiles = files.filter((file) => !file.mime.startsWith('image/'))
    const text = genericFiles.length > 0
      ? `${input.text}\n\nFiles:\n${genericFiles.map((file) => file.path).join('\n')}`
      : input.text
    return [
      {
        type: 'text',
        text,
        text_elements: []
      },
      ...files
        .filter((file) => file.mime.startsWith('image/'))
        .map((file) => ({
          type: 'localImage',
          path: file.path,
          detail: 'auto'
        }))
    ]
  }

  private readThread(value: unknown): CodexClientThread | null {
    if (!value || typeof value !== 'object') {
      return null
    }
    const id = readString(value, 'id')
    if (!id) {
      return null
    }
    return {
      id,
      title: readString(value, 'name') ?? readString(value, 'preview') ?? '',
      isWorking: this.isActiveStatus((value as Record<string, unknown>).status)
    }
  }

  private emitMessage(message: Omit<CodexClientMessage, 'role'>): void {
    this.events.emit('message', {
      ...message,
      role: 'assistant'
    })
  }

  private upsertThread(thread: CodexClientThread): void {
    const existing = this.threads.get(thread.id)
    if (existing && existing.title === thread.title && existing.isWorking === thread.isWorking) {
      return
    }
    this.threads.set(thread.id, thread)
    this.events.emit('thread', thread)
  }

  private isActiveStatus(value: unknown): boolean {
    return Boolean(value && typeof value === 'object' && (value as Record<string, unknown>).type === 'active')
  }

  private isAuthenticationInvalidated(error: unknown): boolean {
    const values = collectValues(error).join('\n').toLowerCase()
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

  private async readRuntimeConfig(): Promise<CodexClientRuntimeConfig> {
    const [
      bundled,
      workspacePath,
      proxyEnabled,
      proxyHost,
      proxyPort,
      serverHost,
      codexCommand,
      developerInstructions,
      requestTimeoutSeconds
    ] = await Promise.all([
      this.configer.get('agents.codex.bundled'),
      this.configer.get('workspace.path'),
      this.configer.get('proxy.enabled'),
      this.configer.get('proxy.host'),
      this.configer.get('proxy.port'),
      this.configer.get('server.host'),
      this.configer.get('agents.codex.command'),
      this.configer.get('agents.codex.developerInstructions'),
      this.configer.get('agents.codex.requestTimeoutSeconds')
    ])
    const command = bundled
      ? {
          command: process.execPath,
          args: [
            codexEntryPath,
            'app-server',
            '--stdio'
          ]
        }
      : {
          command: codexCommand.trim().length > 0 ? codexCommand.trim() : 'codex',
          args: [
            'app-server',
            '--stdio'
          ]
        }
    return {
      bundled,
      command: command.command,
      args: command.args,
      cwd: workspacePath.trim().length > 0 ? workspacePath.trim() : this.metadata.rootPath,
      codexHomePath: bundled ? this.metadata.codexHomePath : undefined,
      proxyUrl: proxyEnabled ? `http://${proxyHost}:${proxyPort}` : undefined,
      noProxyHosts: [
        'localhost',
        '127.0.0.1',
        '::1',
        serverHost
      ],
      developerInstructions,
      requestTimeoutMs: requestTimeoutSeconds * 1000
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pendingRequests.clear()
  }

  private emitError(error: unknown): void {
    this.events.emit('error', error instanceof Error ? error : new Error(String(error)))
  }

  private handleChildClosed(child: ReturnType<typeof execa>, error: Error): void {
    if (this.child === child) {
      this.child = undefined
    }
    this.rejectPending(error)
    this.failLogin(error)
  }

  private failLogin(error: Error): void {
    if (this.loginStarted) {
      this.loginStarted = false
      this.emitError(error)
    }
  }
}

function readString(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const item = (value as Record<string, unknown>)[key]
  return typeof item === 'string' ? item : null
}

function collectValues(value: unknown): string[] {
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
      value.name,
      value.message,
      value.stack ?? ''
    ].filter((item) => item.length > 0)
  }
  if (typeof value !== 'object') {
    return [
      String(value)
    ]
  }
  return Object.values(value as Record<string, unknown>).flatMap((item) => collectValues(item))
}

function failFromError<T>(error: unknown): Result<T> {
  const failed = Result.fromError(error)
  return Result.fail(failed.message)
}

function formatChildExit(result: CodexChildExit): string {
  const reason = result.exitCode !== undefined
    ? `code ${result.exitCode}`
    : result.signal
      ? `signal ${result.signal}`
      : 'unknown status'
  const stderr = typeof result.stderr === 'string' && result.stderr.trim().length > 0
    ? `: ${result.stderr.trim()}`
    : ''
  return `codex app-server exited with ${reason}${stderr}`
}

function readCodexStderrError(text: string): Error | null {
  const normalized = stripAnsi(text)
  const lower = normalized.toLowerCase()
  if (lower.includes('unsupported_country_region_territory')) {
    return new Error([
      'Codex 登录刷新失败：当前网络所在国家、地区或区域不受支持。',
      '请开启可访问 ChatGPT/OpenAI 的代理后重试。'
    ].join('\n'))
  }
  if (lower.includes('failed to refresh token')) {
    return new Error([
      'Codex 登录刷新失败。',
      normalized.trim()
    ].join('\n'))
  }
  if (lower.includes('mcp authorization is invalid')) {
    return new Error('Codex MCP 授权无效，请重新登录 Codex。')
  }
  if (lower.includes('https://chatgpt.com/backend-api/ps/mcp') && lower.includes('http/request failed')) {
    return new Error('Codex MCP 网络请求失败，请检查代理或网络连接。')
  }
  return null
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
}
