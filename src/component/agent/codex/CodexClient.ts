import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { dirname, isAbsolute } from 'node:path'
import { inject, injectable } from 'inversify'
import { execa } from 'execa'
import { Configer } from '../../Configer.js'
import { CodexioMetadata } from '../../CodexioMetadata.js'
import { Logger } from '../../Logger.js'
import { ThreadWorkspaceResolver } from '../../ThreadWorkspaceResolver.js'
import { createProcessEnv } from '../../../util/ProcessEnvironment.js'
import { Result } from '../../../value/Result.js'
import { MessageThread } from '../../../value/Message.js'
import { CodexRuntimeConfig, CodexRuntimeResolver } from './CodexRuntimeResolver.js'
import { CodexSessionSupervisor } from './CodexSessionSupervisor.js'
import { CodexLiveItemTracker } from './CodexLiveItemTracker.js'
import {
  CodexClientEventMap,
  CodexClientCompletedMessage,
  CodexClientInput,
  CodexClientLoginEvent,
  CodexClientMessage,
  CodexClientThread,
  CodexClientTurn
} from './CodexProtocol.js'

export type {
  CodexClientCompletedMessage,
  CodexClientInput,
  CodexClientLoginEvent,
  CodexClientMessage,
  CodexClientThread,
  CodexClientTurn
} from './CodexProtocol.js'

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

type CodexChildExit = {
  exitCode?: number
  signal?: string
  stderr?: unknown
}

type CodexPendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

type CodexSession = {
  generation: number
  child: ReturnType<typeof execa>
  pendingRequests: Map<number, CodexPendingRequest>
  closePromise?: Promise<void>
}

@injectable()
export class CodexClient {
  private readonly events = new EventEmitter()
  private readonly threads = new Map<string, CodexClientThread>()
  private readonly turnIdByThreadId = new Map<string, string>()
  private readonly liveItems = new CodexLiveItemTracker()
  private readonly workspaceResolver: ThreadWorkspaceResolver
  private readonly runtimeResolver: CodexRuntimeResolver
  private readonly supervisor: CodexSessionSupervisor
  private session?: CodexSession
  private nextRequestId = 1
  private generation = 0
  private started = false
  private startPromise?: Promise<Result<void>>
  private stopPromise?: Promise<Result<void>>
  private loginStarted = false
  private loginEvent?: CodexClientLoginEvent

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(CodexioMetadata) private readonly metadata: CodexioMetadata,
    @inject(ThreadWorkspaceResolver) workspaceResolver: ThreadWorkspaceResolver
  ) {
    this.workspaceResolver = workspaceResolver
    this.runtimeResolver = new CodexRuntimeResolver(configer, metadata, workspaceResolver)
    this.supervisor = new CodexSessionSupervisor({
      generation: () => this.generation,
      canRecover: () => !this.started && !this.session && !this.startPromise,
      recover: () => {
        void this.ensureStarted()
      }
    })
  }

  on<K extends keyof CodexClientEventMap>(event: K, listener: CodexClientEventMap[K]): () => void {
    this.events.on(event, listener)
    return () => {
      this.events.off(event, listener)
    }
  }

  start(): Promise<Result<void>> {
    this.supervisor.requestStart()
    return this.ensureStarted()
  }

  private ensureStarted(): Promise<Result<void>> {
    if (this.started && this.session) {
      return Promise.resolve(Result.successVoid())
    }
    if (this.startPromise) {
      return this.startPromise
    }
    const generation = this.generation + 1
    this.generation = generation
    const stopping = this.stopPromise
    let session: CodexSession | undefined
    const startPromise = (async (): Promise<Result<void>> => {
      if (stopping) {
        await stopping
      }
      if (generation !== this.generation) {
        return Result.fail('codex client start superseded')
      }
      try {
        const config = await this.readRuntimeConfig()
        await this.workspaceResolver.ensureBase()
        if (generation !== this.generation) {
          return Result.fail('codex client start superseded')
        }
        const env = createProcessEnv(
          config.codexHomePath,
          config.codexHomePath ? `${config.codexHomePath}/config.toml` : undefined,
          config.proxyUrl,
          config.noProxyHosts,
          {},
          config.bundled
        )
        Logger.info('codex client starting', {
          cwd: config.processCwd,
          bundled: config.bundled,
          command: config.command,
          args: config.args,
          generation
        })
        const child = execa(config.command, config.args, {
          cwd: config.processCwd,
          env,
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
          reject: false
        })
        const createdSession: CodexSession = {
          generation,
          child,
          pendingRequests: new Map()
        }
        session = createdSession
        if (generation !== this.generation) {
          await this.terminateSession(createdSession)
          return Result.fail('codex client start superseded')
        }
        this.session = createdSession
        if (!child.stdout || !child.stdin) {
          throw new Error('codex app-server stdio not available')
        }
        createInterface({
          input: child.stdout
        }).on('line', (line) => this.receiveLine(createdSession, line))
        child.stderr?.on('data', (data: Buffer) => {
          if (this.session !== createdSession) {
            return
          }
          const text = data.toString('utf8')
          Logger.warn('codex app-server stderr', {
            text,
            generation
          })
          const error = readCodexStderrError(text)
          if (error) {
            this.emitError(error)
          }
        })
        void child.then((result) => {
          Logger.info('codex app-server exited', {
            exitCode: result.exitCode,
            signal: result.signal,
            generation
          })
          this.handleChildClosed(createdSession, new Error(formatChildExit(result)))
        }).catch((error) => {
          Logger.error('codex app-server failed', error)
          this.handleChildClosed(
            createdSession,
            error instanceof Error ? error : new Error(String(error))
          )
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
        }, config.requestTimeoutMs, createdSession)
        if (this.session !== createdSession || generation !== this.generation) {
          throw new Error('codex client start superseded')
        }
        child.stdin.write(`${JSON.stringify({
          method: 'initialized',
          params: {}
        })}\n`)
        this.started = true
        this.supervisor.sessionReady(generation)
        Logger.info('codex client ready', {
          generation
        })
        return Result.successVoid()
      } catch (error) {
        const reason = error instanceof Error ? error : new Error(String(error))
        if (session) {
          this.rejectPending(session, reason)
          if (this.session === session) {
            this.session = undefined
            this.started = false
            this.liveItems.clear()
            this.supervisor.sessionEnded()
            this.resetLogin()
          }
          await this.terminateSession(session)
        }
        return failFromError(error)
      }
    })()
    this.startPromise = startPromise
    void startPromise.then((result) => {
      if (this.startPromise === startPromise) {
        this.startPromise = undefined
      }
      if (result.isFailed || !this.started || !this.session) {
        this.supervisor.scheduleRecovery(result.isFailed
          ? result.message
          : 'codex app-server ended during startup')
      }
    }, (error) => {
      if (this.startPromise === startPromise) {
        this.startPromise = undefined
      }
      this.supervisor.scheduleRecovery(error instanceof Error ? error.message : String(error))
    })
    return startPromise
  }

  stop(): Promise<Result<void>> {
    this.supervisor.requestStop()
    this.generation += 1
    this.startPromise = undefined
    if (this.stopPromise) {
      return this.stopPromise
    }
    const stopped = new Error('codex client stopped')
    const session = this.session
    this.session = undefined
    if (session) {
      this.rejectPending(session, stopped)
    }
    this.resetLogin()
    this.started = false
    this.loginStarted = false
    this.loginEvent = undefined
    this.turnIdByThreadId.clear()
    this.liveItems.clear()
    this.threads.clear()
    const stopPromise = (async (): Promise<Result<void>> => {
      if (session) {
        await this.terminateSession(session)
      }
      return Result.successVoid()
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
      Logger.info('codex client routing turn', {
        ioThreadId: input.thread.id,
        requestedThreadId: normalizedThreadId || null,
        route: normalizedThreadId ? 'continue' : 'create',
        cachedThread: normalizedThreadId ? this.threads.has(normalizedThreadId) : false,
        activeTurnId: normalizedThreadId ? this.turnIdByThreadId.get(normalizedThreadId) ?? null : null
      })
      let threadId: string
      let model: string | undefined
      let reasoningEffort: CodexRuntimeConfig['reasoningEffort'] | undefined
      if (normalizedThreadId.length === 0) {
        const config = await this.readRuntimeConfig()
        threadId = (await this.startThread(input.thread, config)).id
        model = config.model
        reasoningEffort = config.reasoningEffort
      } else if (this.threads.has(normalizedThreadId)) {
        threadId = normalizedThreadId
      } else {
        threadId = (await this.resumeThread(normalizedThreadId, input.thread.name)).id
      }
      if (model === undefined || reasoningEffort === undefined) {
        [model, reasoningEffort] = await Promise.all([
          this.configer.get('agents.codex.model'),
          this.configer.get('agents.codex.reasoningEffort')
        ])
      }
      const turnInput = this.toTurnInput(input)
      const activeTurnId = this.turnIdByThreadId.get(threadId)
      if (activeTurnId) {
        Logger.info('codex client steering turn', {
          ioThreadId: input.thread.id,
          threadId,
          turnId: activeTurnId
        })
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
      Logger.info('codex client starting turn', {
        ioThreadId: input.thread.id,
        threadId
      })
      const response = await this.request('turn/start', {
        threadId,
        input: turnInput,
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { effort: reasoningEffort } : {})
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
      Logger.info('codex client turn started', {
        ioThreadId: input.thread.id,
        requestedThreadId: normalizedThreadId || null,
        threadId: result.threadId,
        turnId
      })
      this.emitMessage({
        thread: this.messageThread(result.threadId),
        turnId,
        status: 'started',
        role: 'assistant',
        text: '',
        messages: []
      })
      return Result.success(result)
    } catch (error) {
      return failFromError(error)
    }
  }

  private async resumeThread(threadId: string, fallbackTitle: string): Promise<CodexClientThread> {
    Logger.info('codex client resuming thread', {
      threadId
    })
    const response = await this.request('thread/resume', {
      threadId,
      excludeTurns: true
    })
    if (!response || typeof response !== 'object') {
      throw new Error('codex thread resume response not found')
    }
    const thread = this.readThread((response as Record<string, unknown>).thread)
    if (!thread) {
      throw new Error('codex resumed thread id not found')
    }
    if (thread.id !== threadId) {
      throw new Error(`codex resumed unexpected thread: ${thread.id}`)
    }
    if (!thread.title.trim()) {
      thread.title = fallbackTitle
    }
    this.upsertThread(thread)
    Logger.info('codex client thread resumed', {
      threadId: thread.id,
      title: thread.title,
      isWorking: thread.isWorking
    })
    return thread
  }

  private async startThread(messageThread: MessageThread, config?: CodexRuntimeConfig): Promise<CodexClientThread> {
    const runtimeConfig = config ?? await this.readRuntimeConfig()
    const cwd = await this.workspaceResolver.ensure(messageThread.id)
    const codexExecutablePath = runtimeConfig.bundled && runtimeConfig.args[0] && isAbsolute(runtimeConfig.args[0])
      ? runtimeConfig.args[0]
      : runtimeConfig.command
    const codexExecutableDirectory = isAbsolute(codexExecutablePath) ? dirname(codexExecutablePath) : ''
    const response = await this.request('thread/start', {
      ...(runtimeConfig.model ? { model: runtimeConfig.model } : {}),
      cwd,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      ephemeral: false,
      developerInstructions: [
        runtimeConfig.instruction,
        codexExecutableDirectory.length > 0
          ? [
              'Codex runtime context:',
              `- Codex executable directory: ${codexExecutableDirectory}`
            ].join('\n')
          : ''
      ].filter((item) => item.trim().length > 0).join('\n\n')
    })
    if (!response || typeof response !== 'object') {
      throw new Error('codex thread response not found')
    }
    const thread = this.readThread((response as Record<string, unknown>).thread)
    if (!thread) {
      throw new Error('codex thread id not found')
    }
    if (!thread.title.trim()) {
      thread.title = messageThread.name
    }
    this.upsertThread(thread)
    return thread
  }

  private async request(
    method: string,
    params?: unknown,
    timeoutMs?: number,
    targetSession = this.session
  ): Promise<unknown> {
    if (!targetSession?.child.stdin || this.session !== targetSession) {
      throw new Error('codex client not started')
    }
    const id = this.nextRequestId
    this.nextRequestId += 1
    const timeout = timeoutMs ?? (await this.readRuntimeConfig()).requestTimeoutMs
    if (this.session !== targetSession) {
      throw new Error('codex client stopped')
    }
    const result = new Promise<unknown>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        targetSession.pendingRequests.delete(id)
        const error = new Error(`codex app-server request timed out: ${method}`)
        reject(error)
        this.failSession(targetSession, error)
      }, timeout)
      targetSession.pendingRequests.set(id, {
        resolve,
        reject,
        timeout: timeoutHandle
      })
    })
    targetSession.child.stdin.write(`${JSON.stringify({
      method,
      id,
      params
    })}\n`)
    return result
  }

  private receiveLine(session: CodexSession, line: string): void {
    if (this.session !== session) {
      return
    }
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
      const pending = session.pendingRequests.get(message.id)
      if (!pending) {
        return
      }
      session.pendingRequests.delete(message.id)
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
          this.liveItems.clearThread(threadId)
          this.turnIdByThreadId.set(threadId, turnId)
          this.emitMessage({
            thread: this.messageThread(threadId),
            turnId,
            status: 'started',
            role: 'assistant',
            text: '',
            messages: []
          })
        }
        return
      }
      case 'item/started': {
        const threadId = readString(data, 'threadId')
        const turnId = readString(data, 'turnId') ?? (threadId ? this.turnIdByThreadId.get(threadId) : undefined)
        const item = data.item
        const itemId = readString(data, 'itemId') ?? readString(item, 'id')
        if (threadId && turnId && itemId) {
          this.liveItems.startItem(threadId, turnId, itemId, {
            phase: readString(item, 'phase') ?? undefined,
            startedAt: readNumber(data, 'startedAtMs')
          })
        }
        return
      }
      case 'item/agentMessage/delta': {
        const threadId = readString(data, 'threadId')
        const itemId = readString(data, 'itemId')
        const delta = readString(data, 'delta')
        const turnId = readString(data, 'turnId') ?? (threadId ? this.turnIdByThreadId.get(threadId) : undefined)
        const itemState = threadId && turnId && itemId
          ? this.liveItems.getItem(threadId, turnId, itemId)
          : undefined
        if (threadId && turnId && itemId && delta && itemState?.phase !== 'commentary') {
          this.emitMessage({
            thread: this.messageThread(threadId),
            turnId,
            itemId,
            status: 'delta',
            role: 'assistant',
            text: delta,
            occurredAt: itemState?.startedAt,
            messages: []
          })
        }
        return
      }
      case 'item/completed': {
        const threadId = readString(data, 'threadId')
        const item = data.item
        const itemId = readString(data, 'itemId') ?? readString(item, 'id')
        const type = readString(item, 'type')
        const text = readString(item, 'text') ?? ''
        const turnId = readString(data, 'turnId') ?? (threadId ? this.turnIdByThreadId.get(threadId) : undefined)
        const itemState = threadId && turnId && itemId
          ? this.liveItems.getItem(threadId, turnId, itemId)
          : undefined
        const phase = readString(item, 'phase') ?? itemState?.phase
        if (threadId && turnId && itemId && phase === 'commentary' && (!type || type === 'agentMessage') && text.trim().length > 0) {
          this.emitMessage({
            thread: this.messageThread(threadId),
            turnId,
            itemId,
            status: 'progressCompleted',
            role: 'assistant',
            text,
            occurredAt: readNumber(data, 'completedAtMs'),
            messages: []
          })
        } else if (threadId && turnId && itemId && phase !== 'commentary' && (!type || type === 'agentMessage')) {
          this.emitMessage({
            thread: this.messageThread(threadId),
            turnId,
            itemId,
            status: 'itemCompleted',
            role: 'assistant',
            text: '',
            occurredAt: readNumber(data, 'completedAtMs'),
            messages: [
              {
                itemId,
                role: 'assistant',
                text,
                sequence: 0
              }
            ]
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
          this.liveItems.clearThread(threadId)
          this.removeThread(threadId)
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
            thread: this.messageThread(threadId),
            turnId,
            status: 'failed',
            role: 'assistant',
            text: readString(error, 'message') ?? 'codex notification error',
            messages: []
          })
          this.liveItems.clearTurn(threadId, turnId)
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
        const itemId = readString(item, 'id') ?? `completed-${turnId}-${index}`
        const phase = readString(item, 'phase') ?? this.liveItems.getItem(threadId, turnId, itemId)?.phase
        if (type === 'agentMessage' && phase !== 'commentary' && text && text.trim().length > 0) {
          return [{
            itemId,
            role: 'assistant',
            text,
            sequence: index
          }]
        }
        return []
      })
    this.liveItems.clearTurn(threadId, turnId)
    this.emitMessage({
      thread: this.messageThread(threadId),
      turnId,
      status: 'turnCompleted',
      role: 'assistant',
      text: '',
      occurredAt: readEpochSecondsAsMilliseconds(turn, 'completedAt'),
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

  private emitMessage(message: CodexClientMessage): void {
    this.events.emit('message', message)
  }

  private upsertThread(thread: CodexClientThread): void {
    const existing = this.threads.get(thread.id)
    if (existing && existing.title === thread.title && existing.isWorking === thread.isWorking) {
      return
    }
    this.threads.set(thread.id, thread)
    this.events.emit('thread', thread)
  }

  private messageThread(threadId: string): CodexClientMessage['thread'] {
    return {
      id: threadId,
      name: this.threads.get(threadId)?.title.trim() || '新对话'
    }
  }

  private removeThread(threadId: string): void {
    const existing = this.threads.get(threadId)
    this.threads.delete(threadId)
    this.events.emit('thread', {
      id: threadId,
      title: existing?.title ?? '',
      isWorking: false,
      deleted: true
    })
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

  private async readRuntimeConfig(): Promise<CodexRuntimeConfig> {
    return this.runtimeResolver.resolve()
  }

  private rejectPending(session: CodexSession, error: Error): void {
    for (const pending of session.pendingRequests.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    session.pendingRequests.clear()
  }

  private emitError(error: unknown): void {
    this.events.emit('error', error instanceof Error ? error : new Error(String(error)))
  }

  private handleChildClosed(session: CodexSession, error: Error): void {
    this.rejectPending(session, error)
    if (this.session !== session) {
      return
    }
    this.session = undefined
    this.started = false
    this.liveItems.clear()
    this.supervisor.sessionEnded()
    this.resetLogin()
    this.supervisor.scheduleRecovery(error.message)
  }

  private failSession(session: CodexSession, error: Error): void {
    this.rejectPending(session, error)
    if (this.session !== session) {
      return
    }
    this.session = undefined
    this.started = false
    this.liveItems.clear()
    this.supervisor.sessionEnded()
    this.resetLogin()
    void this.terminateSession(session).then(() => {
      this.supervisor.scheduleRecovery(error.message)
    }, (terminationError) => {
      Logger.error('codex app-server termination failed', terminationError)
      this.supervisor.scheduleRecovery(error.message)
    })
  }

  private terminateSession(session: CodexSession): Promise<void> {
    if (session.closePromise) {
      return session.closePromise
    }
    const closePromise = (async () => {
      session.child.kill('SIGTERM')
      let timeout: NodeJS.Timeout | undefined
      const exited = await Promise.race([
        session.child.then(() => true, () => true),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), 2000)
        })
      ])
      if (timeout) {
        clearTimeout(timeout)
      }
      if (!exited) {
        Logger.warn('codex app-server termination timed out', {
          generation: session.generation
        })
        session.child.kill('SIGKILL')
      }
    })()
    session.closePromise = closePromise
    return closePromise
  }

  private resetLogin(): void {
    this.loginStarted = false
    this.loginEvent = undefined
  }
}

function readString(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const item = (value as Record<string, unknown>)[key]
  return typeof item === 'string' ? item : null
}

function readEpochSecondsAsMilliseconds(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const item = (value as Record<string, unknown>)[key]
  return typeof item === 'number' ? item * 1000 : undefined
}

function readNumber(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const item = (value as Record<string, unknown>)[key]
  return typeof item === 'number' ? item : undefined
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
