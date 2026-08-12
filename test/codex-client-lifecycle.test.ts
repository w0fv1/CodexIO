import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexioMetadata } from '../src/component/CodexioMetadata.js'
import { ChannelOutputManager } from '../src/component/channelo/ChannelOutputManager.js'
import { ThreadRegistry } from '../src/component/ThreadRegistry.js'
import { CodexAgent } from '../src/component/agent/CodexAgent.js'
import { CodexClient, CodexClientMessage } from '../src/component/agent/codex/CodexClient.js'
import { CodexMessageAssembler } from '../src/component/agent/codex/CodexMessageAssembler.js'
import { CodexLiveItemTracker } from '../src/component/agent/codex/CodexLiveItemTracker.js'
import { createMessage } from '../src/value/Message.js'
import { Result } from '../src/value/Result.js'

const { execaMock } = vi.hoisted(() => ({
  execaMock: vi.fn()
}))

vi.mock('execa', () => ({
  execa: execaMock
}))

describe('Codex client lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers()
    execaMock.mockReset()
  })

  it('starts one child and one initialization for concurrent callers', async () => {
    const process = fakeProcess()
    execaMock.mockReturnValue(process.child)
    const client = createClient()

    const results = await Promise.all([
      client.start(),
      client.start(),
      client.start()
    ])

    expect(results.every((result) => !result.isFailed)).toBe(true)
    expect(execaMock).toHaveBeenCalledTimes(1)
    expect(process.requests.filter((request) => request.method === 'initialize')).toHaveLength(1)
    process.exit()
    await client.stop()
  })

  it('isolates a replacement child from the previous child exit and force kills a stuck child', async () => {
    vi.useFakeTimers()
    const first = fakeProcess()
    const second = fakeProcess()
    execaMock.mockReturnValueOnce(first.child).mockReturnValueOnce(second.child)
    const client = createClient()
    expect((await client.start()).isFailed).toBe(false)

    const stopping = client.stop()
    await vi.advanceTimersByTimeAsync(2000)
    expect((await stopping).isFailed).toBe(false)
    expect(first.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(first.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')

    expect((await client.start()).isFailed).toBe(false)
    const pending = client['request']('thread/read', { threadId: 'new-thread' }, 10_000)
    await vi.waitFor(() => {
      expect(second.requests.some((request) => request.method === 'thread/read')).toBe(true)
    })
    first.exit({ exitCode: 1 })
    await Promise.resolve()
    second.respond('thread/read', { thread: { id: 'new-thread' } })

    await expect(pending).resolves.toEqual({ thread: { id: 'new-thread' } })
    second.exit()
    await client.stop()
  })

  it('lets a repeated stop supersede a start queued behind termination', async () => {
    vi.useFakeTimers()
    const first = fakeProcess()
    const replacement = fakeProcess()
    execaMock.mockReturnValueOnce(first.child).mockReturnValueOnce(replacement.child)
    const client = createClient()
    expect((await client.start()).isFailed).toBe(false)

    const stopping = client.stop()
    const queuedStart = client.start()
    const repeatedStop = client.stop()
    await vi.advanceTimersByTimeAsync(2000)

    expect((await stopping).isFailed).toBe(false)
    expect((await repeatedStop).isFailed).toBe(false)
    expect((await queuedStart).isFailed).toBe(true)
    expect(execaMock).toHaveBeenCalledTimes(1)
  })

  it('recovers after an unexpected child exit while running is still desired', async () => {
    vi.useFakeTimers()
    const first = fakeProcess()
    const replacement = fakeProcess()
    execaMock.mockReturnValueOnce(first.child).mockReturnValueOnce(replacement.child)
    const client = createClient()

    expect((await client.start()).isFailed).toBe(false)
    first.exit({ exitCode: 1 })
    await vi.advanceTimersByTimeAsync(250)
    await vi.waitFor(() => {
      expect(execaMock).toHaveBeenCalledTimes(2)
    })

    const pending = client['request']('thread/read', { threadId: 'recovered' }, 10_000)
    replacement.respond('thread/read', { thread: { id: 'recovered' } })
    await expect(pending).resolves.toEqual({ thread: { id: 'recovered' } })
    replacement.exit()
    await client.stop()
  })

  it('recovers when a child exits between initialization and startup settlement', async () => {
    vi.useFakeTimers()
    const first = fakeProcess({
      exitAfterInitialize: true
    })
    const replacement = fakeProcess()
    execaMock.mockReturnValueOnce(first.child).mockReturnValueOnce(replacement.child)
    const client = createClient()

    await client.start()
    await vi.advanceTimersByTimeAsync(250)
    expect(execaMock).toHaveBeenCalledTimes(2)

    replacement.exit()
    await client.stop()
  })

  it('backs off consecutive unhealthy replacement sessions', async () => {
    vi.useFakeTimers()
    const first = fakeProcess()
    const second = fakeProcess()
    const third = fakeProcess()
    execaMock
      .mockReturnValueOnce(first.child)
      .mockReturnValueOnce(second.child)
      .mockReturnValueOnce(third.child)
    const client = createClient()

    expect((await client.start()).isFailed).toBe(false)
    first.exit({ exitCode: 1 })
    await vi.advanceTimersByTimeAsync(250)
    expect(execaMock).toHaveBeenCalledTimes(2)

    second.exit({ exitCode: 1 })
    await vi.advanceTimersByTimeAsync(499)
    expect(execaMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(execaMock).toHaveBeenCalledTimes(3)

    third.exit()
    await client.stop()
  })

  it('cancels pending recovery when stopped', async () => {
    vi.useFakeTimers()
    const first = fakeProcess()
    execaMock.mockReturnValue(first.child)
    const client = createClient()

    expect((await client.start()).isFailed).toBe(false)
    first.exit({ exitCode: 1 })
    await Promise.resolve()
    expect((await client.stop()).isFailed).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)

    expect(execaMock).toHaveBeenCalledTimes(1)
  })

  it('reads the current account without proactively refreshing its token', async () => {
    const process = fakeProcess()
    execaMock.mockReturnValue(process.child)
    const client = createClient()
    expect((await client.start()).isFailed).toBe(false)

    const login = client.login()
    await vi.waitFor(() => {
      expect(process.requests.some((request) => request.method === 'account/read')).toBe(true)
    })
    expect(process.requests.findLast((request) => request.method === 'account/read')?.params).toEqual({
      refreshToken: false
    })
    process.respond('account/read', {
      account: {
        type: 'chatgpt'
      }
    })

    expect((await login).data).toEqual({ status: 'authenticated' })
    process.exit()
    await client.stop()
  })

  it('keeps retrying turn errors active and emits one terminal failure', () => {
    const client = createClient()
    const messages: CodexClientMessage[] = []
    client.on('message', (message) => {
      messages.push(message)
    })
    client['handleNotification']('turn/started', {
      threadId: 'thread',
      turn: { id: 'turn' }
    })
    client['handleNotification']('error', {
      threadId: 'thread',
      turnId: 'turn',
      willRetry: true,
      error: { message: 'temporary failure' }
    })

    expect(messages.map((message) => message.status)).toEqual(['started'])
    expect(client['turnIdByThreadId'].get('thread')).toBe('turn')

    client['handleNotification']('error', {
      threadId: 'thread',
      turnId: 'turn',
      willRetry: false,
      error: { message: 'terminal failure' }
    })
    client['handleNotification']('error', {
      threadId: 'thread',
      turnId: 'turn',
      willRetry: false,
      error: { message: 'terminal failure' }
    })

    expect(messages.map((message) => message.status)).toEqual(['started', 'failed'])
    expect(messages[1].text).toBe('terminal failure')
    expect(client['turnIdByThreadId'].has('thread')).toBe(false)
  })

  it('reports the actual device login completion result', async () => {
    const process = fakeProcess()
    execaMock.mockReturnValue(process.child)
    const client = createClient()
    const completions: unknown[] = []
    client.on('login', (completion) => {
      completions.push(completion)
    })
    expect((await client.start()).isFailed).toBe(false)

    const login = client.login()
    await vi.waitFor(() => {
      expect(process.requests.some((request) => request.method === 'account/read')).toBe(true)
    })
    process.respond('account/read', { account: null })
    await vi.waitFor(() => {
      expect(process.requests.some((request) => request.method === 'account/login/start')).toBe(true)
    })
    process.respond('account/login/start', {
      type: 'chatgptDeviceCode',
      loginId: 'login-1',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'CODE-1'
    })

    expect((await login).data).toEqual({
      status: 'loginRequired',
      loginId: 'login-1',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'CODE-1'
    })

    client['handleNotification']('account/login/completed', {
      loginId: 'login-1',
      success: false,
      error: 'device code expired'
    })

    expect(completions).toEqual([{
      loginId: 'login-1',
      success: false,
      error: 'device code expired'
    }])
    process.exit()
    await client.stop()
  })

  it('tracks live item phase and millisecond timestamps across notifications', () => {
    const client = createClient()
    const messages: CodexClientMessage[] = []
    client.on('message', (message) => {
      messages.push(message)
    })

    client['handleNotification']('turn/started', {
      threadId: 'thread',
      turn: { id: 'turn' }
    })
    client['handleNotification']('item/started', {
      threadId: 'thread',
      turnId: 'turn',
      startedAtMs: 1000,
      item: {
        id: 'commentary',
        phase: 'commentary'
      }
    })
    client['handleNotification']('item/agentMessage/delta', {
      threadId: 'thread',
      turnId: 'turn',
      itemId: 'commentary',
      delta: 'hidden'
    })
    client['handleNotification']('item/completed', {
      threadId: 'thread',
      turnId: 'turn',
      completedAtMs: 2000,
      item: {
        id: 'commentary',
        type: 'agentMessage',
        text: 'hidden'
      }
    })
    client['handleNotification']('item/started', {
      threadId: 'thread',
      turnId: 'turn',
      startedAtMs: 3000,
      item: {
        id: 'final',
        phase: 'final_answer'
      }
    })
    client['handleNotification']('item/agentMessage/delta', {
      threadId: 'thread',
      turnId: 'turn',
      itemId: 'final',
      delta: 'visible'
    })
    client['handleNotification']('item/completed', {
      threadId: 'thread',
      turnId: 'turn',
      completedAtMs: 4000,
      item: {
        id: 'final',
        type: 'agentMessage',
        text: 'visible'
      }
    })
    client['handleNotification']('turn/completed', {
      threadId: 'thread',
      turn: {
        id: 'turn',
        completedAt: 5,
        items: [
          { id: 'commentary', type: 'agentMessage', text: 'hidden' },
          { id: 'final', type: 'agentMessage', text: 'visible' }
        ]
      }
    })

    expect(messages.map((message) => message.status)).toEqual([
      'started',
      'progressCompleted',
      'delta',
      'itemCompleted',
      'turnCompleted'
    ])
    expect(messages[1]).toMatchObject({
      itemId: 'commentary',
      text: 'hidden',
      occurredAt: 2000
    })
    expect(messages[2].occurredAt).toBe(3000)
    expect(messages[3].occurredAt).toBe(4000)
    expect(messages[4].occurredAt).toBe(5000)
    expect(messages[4].messages.map((message) => message.text)).toEqual(['visible'])
  })

  it('keeps a turn active after 300 seconds', async () => {
    vi.useFakeTimers()
    const process = fakeProcess()
    execaMock.mockReturnValue(process.child)
    const client = createClient()
    const messages: CodexClientMessage[] = []
    client.on('message', (message) => {
      messages.push(message)
    })
    expect((await client.start()).isFailed).toBe(false)

    client['handleNotification']('turn/started', {
      threadId: 'thread',
      turn: { id: 'turn' }
    })
    await vi.advanceTimersByTimeAsync(300_001)

    expect(process.requests.some((request) => request.method === 'turn/interrupt')).toBe(false)
    expect(messages.map((message) => message.status)).toEqual(['started'])
    expect(client['turnIdByThreadId'].get('thread')).toBe('turn')

    process.exit()
    await client.stop()
  })

  it('clears tracked live items at the turn boundary', () => {
    const tracker = new CodexLiveItemTracker()
    tracker.startItem('thread', 'turn', 'item', {
      phase: 'commentary',
      startedAt: 1000
    })

    expect(tracker.getItem('thread', 'turn', 'item')).toEqual({
      phase: 'commentary',
      startedAt: 1000
    })
    tracker.clearTurn('thread', 'turn')
    expect(tracker.getItem('thread', 'turn', 'item')).toBeUndefined()
  })
})

describe('Codex agent lifecycle', () => {
  it('keeps background app-server stderr out of every conversation', async () => {
    const process = fakeProcess()
    execaMock.mockReturnValue(process.child)
    const client = createClient()
    const metadata = new CodexioMetadata({
      dataPath: join(tmpdir(), `codexio-agent-stderr-${randomUUID()}`)
    })
    const registry = new ThreadRegistry(metadata)
    registry.ensure('previous-thread')
    const sent: import('../src/value/Message.js').Message[] = []
    const outputManager = {
      send: async (message: import('../src/value/Message.js').Message) => {
        sent.push(message)
        return Result.successVoid()
      }
    } as unknown as ChannelOutputManager
    const assembler = new CodexMessageAssembler()
    const agent = new CodexAgent(
      { get: async () => false } as never,
      registry,
      client,
      assembler
    )
    attachOutput(agent, assembler, outputManager)
    expect((await agent.start(Reflect.get(agent, 'outputReceiver'))).isFailed).toBe(false)

    process.writeStderr('Failed to refresh token: error sending request for url (https://auth.openai.com/oauth/token)')
    await new Promise((resolve) => setImmediate(resolve))

    expect(sent).toEqual([])
    process.exit()
    await agent.stop()
  })

  it('shares startup and listener registration across concurrent receives', async () => {
    const client = new GatedCodexClient()
    const metadata = new CodexioMetadata({
      dataPath: join(tmpdir(), `codexio-agent-lifecycle-${randomUUID()}`)
    })
    const outputManager = successfulOutputManager()
    const assembler = new CodexMessageAssembler()
    const agent = new CodexAgent(
      { get: async () => false } as never,
      new ThreadRegistry(metadata),
      client as unknown as CodexClient,
      assembler
    )
    attachOutput(agent, assembler, outputManager)
    const first = agent.receive(receivedEvent('one'))
    const second = agent.receive(receivedEvent('two'))
    await Promise.resolve()

    expect(client.startCalls).toBe(1)
    expect(client.listenerCount).toBe(3)
    client.finishStart()
    expect((await first).isFailed).toBe(false)
    expect((await second).isFailed).toBe(false)
    expect(client.startCalls).toBe(1)
    expect(client.listenerCount).toBe(3)
    await agent.stop()
  })

  it('checks client readiness again for every receive after agent startup', async () => {
    const client = new ReadyCodexClient()
    const metadata = new CodexioMetadata({
      dataPath: join(tmpdir(), `codexio-agent-readiness-${randomUUID()}`)
    })
    const outputManager = successfulOutputManager()
    const assembler = new CodexMessageAssembler()
    const agent = new CodexAgent(
      { get: async () => false } as never,
      new ThreadRegistry(metadata),
      client as unknown as CodexClient,
      assembler
    )
    attachOutput(agent, assembler, outputManager)

    expect((await agent.receive(receivedEvent('one'))).isFailed).toBe(false)
    expect((await agent.receive(receivedEvent('two'))).isFailed).toBe(false)
    expect(client.startCalls).toBe(2)
    await agent.stop()
  })
})

function successfulOutputManager(): ChannelOutputManager {
  return {
    send: async () => Result.successVoid()
  } as unknown as ChannelOutputManager
}

function attachOutput(agent: CodexAgent, assembler: CodexMessageAssembler, outputManager: ChannelOutputManager): void {
  const receiver = {
    receiveAgentOutput: (message: Parameters<import('../src/component/agent/Agent.js').AgentOutputReceiver['receiveAgentOutput']>[0]) => outputManager.send(message)
  }
  Reflect.set(agent, 'outputReceiver', receiver)
  assembler.start(receiver)
}

function createClient(options: {
  requestTimeoutMs?: number
} = {}): CodexClient {
  const client = new CodexClient(
    {} as never,
    new CodexioMetadata(),
    { ensureBase: async () => undefined } as never
  )
  client['readRuntimeConfig'] = async () => ({
    bundled: false,
    command: 'codex',
    args: ['app-server'],
    processCwd: tmpdir(),
    noProxyHosts: [],
    instruction: '',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    requestTimeoutMs: options.requestTimeoutMs ?? 10_000
  })
  return client
}

type FakeRequest = {
  id: number
  method: string
  params?: unknown
}

function fakeProcess(options: {
  exitAfterInitialize?: boolean
} = {}): {
  child: never
  kill: ReturnType<typeof vi.fn>
  requests: FakeRequest[]
  respond: (method: string, result: unknown) => void
  writeStderr: (text: string) => void
  exit: (result?: { exitCode?: number; signal?: string }) => void
} {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const requests: FakeRequest[] = []
  let resolveExit!: (value: { exitCode?: number; signal?: string; stderr?: string }) => void
  const childPromise = new Promise<{ exitCode?: number; signal?: string; stderr?: string }>((resolve) => {
    resolveExit = resolve
  })
  const kill = vi.fn()
  const child = Object.assign(childPromise, {
    stdin,
    stdout,
    stderr,
    kill
  })
  stdin.on('data', (data: Buffer) => {
    for (const line of data.toString('utf8').trim().split('\n')) {
      const request = JSON.parse(line) as { id?: number; method: string; params?: unknown }
      if (request.id === undefined) {
        continue
      }
      requests.push({ id: request.id, method: request.method, params: request.params })
      if (request.method === 'initialize') {
        queueMicrotask(() => {
          stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`)
          if (options.exitAfterInitialize) {
            resolveExit({
              exitCode: 1,
              stderr: ''
            })
          }
        })
      }
    }
  })
  return {
    child: child as never,
    kill,
    requests,
    respond(method, result) {
      const request = requests.findLast((candidate) => candidate.method === method)
      if (!request) {
        throw new Error(`request not found: ${method}`)
      }
      stdout.write(`${JSON.stringify({ id: request.id, result })}\n`)
    },
    writeStderr(text) {
      stderr.write(text)
    },
    exit(result = { exitCode: 0 }) {
      resolveExit({
        ...result,
        stderr: ''
      })
    }
  }
}

function receivedEvent(text: string) {
  return createMessage({
    id: text,
    thread: { id: text, name: text },
    role: 'user',
    text
  })
}

class GatedCodexClient {
  startCalls = 0
  listenerCount = 0
  private resolveStart!: (result: Result<void>) => void
  private readonly startResult = new Promise<Result<void>>((resolve) => {
    this.resolveStart = resolve
  })

  on(): () => void {
    this.listenerCount += 1
    return () => {
      this.listenerCount -= 1
    }
  }

  start(): Promise<Result<void>> {
    this.startCalls += 1
    return this.startResult
  }

  finishStart(): void {
    this.resolveStart(Result.successVoid())
  }

  async stop(): Promise<Result<void>> {
    return Result.successVoid()
  }

  async login() {
    return Result.success({ status: 'authenticated' as const })
  }

  async identityScope(): Promise<string> {
    return 'default'
  }

  async send(input: {
    thread: { id: string }
    threadResolved?: (threadId: string) => void | Promise<void>
  }): Promise<Result<{ threadId: string; turnId: string }>> {
    await input.threadResolved?.(input.thread.id)
    return Result.success({
      threadId: input.thread.id,
      turnId: input.thread.id
    })
  }
}

class ReadyCodexClient {
  startCalls = 0

  on(): () => void {
    return () => {}
  }

  async start(): Promise<Result<void>> {
    this.startCalls += 1
    return Result.successVoid()
  }

  async stop(): Promise<Result<void>> {
    return Result.successVoid()
  }

  async login() {
    return Result.success({ status: 'authenticated' as const })
  }

  async identityScope(): Promise<string> {
    return 'default'
  }

  async send(input: {
    thread: { id: string }
    threadResolved?: (threadId: string) => void | Promise<void>
  }): Promise<Result<{ threadId: string; turnId: string }>> {
    await input.threadResolved?.(input.thread.id)
    return Result.success({
      threadId: input.thread.id,
      turnId: input.thread.id
    })
  }
}
