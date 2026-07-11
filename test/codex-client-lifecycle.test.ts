import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexioMetadata } from '../src/component/CodexioMetadata.js'
import { ChannelOutputManager } from '../src/component/channelo/ChannelOutputManager.js'
import { ThreadRegistry } from '../src/component/ThreadRegistry.js'
import { CodexAgent } from '../src/component/agent/CodexAgent.js'
import { CodexClient, CodexClientMessage } from '../src/component/agent/CodexClient.js'
import { CodexMessageStreamer } from '../src/component/agent/CodexMessageStreamer.js'
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

  it('keeps the observer baseline and state while replacing a timed out session', async () => {
    vi.useFakeTimers()
    const baselineUpdatedAt = Math.floor(Date.now() / 1000)
    const first = fakeProcess({
      threadList: true,
      threadListResponses: 1,
      threadListData: [
        { id: 'baseline-thread', updatedAt: baselineUpdatedAt }
      ]
    })
    const replacement = fakeProcess({
      threadList: true
    })
    execaMock.mockReturnValueOnce(first.child).mockReturnValueOnce(replacement.child)
    const client = createClient({
      observe: true,
      requestTimeoutMs: 100
    })
    const clientErrors: Error[] = []
    client.on('error', (error) => {
      clientErrors.push(error)
    })

    expect((await client.start()).isFailed).toBe(false)
    client['loginStarted'] = true
    await vi.waitFor(() => {
      expect(first.requests.some((request) => request.method === 'thread/list')).toBe(true)
    })
    const observerLifecycle = client['observerLifecycle']
    const observer = observerLifecycle['observer']
    const baseline = observer?.['baselineCompletedAt']
    const threadStates = observer?.['threadStates']
    await vi.waitFor(() => {
      expect(threadStates?.has('baseline-thread')).toBe(true)
    })

    await vi.advanceTimersByTimeAsync(4200)
    await vi.waitFor(() => {
      expect(execaMock).toHaveBeenCalledTimes(2)
      expect(replacement.requests.some((request) => request.method === 'thread/list')).toBe(true)
    })

    expect(client['observerLifecycle']).toBe(observerLifecycle)
    expect(client['observerLifecycle']['observer']).toBe(observer)
    expect(client['observerLifecycle']['observer']?.['baselineCompletedAt']).toBe(baseline)
    expect(client['observerLifecycle']['observer']?.['threadStates']).toBe(threadStates)
    expect(first.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(first.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
    expect(clientErrors).toEqual([])
    replacement.exit()
    await client.stop()
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
      'delta',
      'itemCompleted',
      'turnCompleted'
    ])
    expect(messages[1].occurredAt).toBe(3000)
    expect(messages[2].occurredAt).toBe(4000)
    expect(messages[3].occurredAt).toBe(5000)
    expect(messages[3].messages.map((message) => message.text)).toEqual(['visible'])
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
  it('shares startup and listener registration across concurrent receives', async () => {
    const client = new GatedCodexClient()
    const metadata = new CodexioMetadata({
      dataPath: join(tmpdir(), `codexio-agent-lifecycle-${randomUUID()}`)
    })
    const outputManager = successfulOutputManager()
    const agent = new CodexAgent(
      { get: async () => false } as never,
      outputManager,
      new ThreadRegistry(metadata),
      client as unknown as CodexClient,
      new CodexMessageStreamer(outputManager)
    )
    const first = agent.receive(receivedEvent('one'))
    const second = agent.receive(receivedEvent('two'))

    expect(client.startCalls).toBe(1)
    expect(client.listenerCount).toBe(5)
    client.finishStart()
    expect((await first).isFailed).toBe(false)
    expect((await second).isFailed).toBe(false)
    expect(client.startCalls).toBe(1)
    expect(client.listenerCount).toBe(5)
    await agent.stop()
  })

  it('checks client readiness again for every receive after agent startup', async () => {
    const client = new ReadyCodexClient()
    const metadata = new CodexioMetadata({
      dataPath: join(tmpdir(), `codexio-agent-readiness-${randomUUID()}`)
    })
    const agent = new CodexAgent(
      { get: async () => false } as never,
      successfulOutputManager(),
      new ThreadRegistry(metadata),
      client as unknown as CodexClient,
      new CodexMessageStreamer(successfulOutputManager())
    )

    expect((await agent.receive(receivedEvent('one'))).isFailed).toBe(false)
    expect((await agent.receive(receivedEvent('two'))).isFailed).toBe(false)
    expect(client.startCalls).toBe(2)
    await agent.stop()
  })
})

function successfulOutputManager(): ChannelOutputManager {
  return {
    sendAgent: async () => Result.successVoid()
  } as unknown as ChannelOutputManager
}

function createClient(options: {
  observe?: boolean
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
    requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
    observe: options.observe ? { intervalMs: 1000 } : undefined
  })
  return client
}

function fakeProcess(options: {
  threadList?: boolean
  threadListResponses?: number
  threadListData?: Array<{ id: string; updatedAt: number }>
  exitAfterInitialize?: boolean
} = {}): {
  child: never
  kill: ReturnType<typeof vi.fn>
  requests: Array<{ id: number; method: string }>
  respond: (method: string, result: unknown) => void
  exit: (result?: { exitCode?: number; signal?: string }) => void
} {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const requests: Array<{ id: number; method: string }> = []
  let resolveExit!: (value: { exitCode?: number; signal?: string; stderr?: string }) => void
  const childPromise = new Promise<{ exitCode?: number; signal?: string; stderr?: string }>((resolve) => {
    resolveExit = resolve
  })
  const kill = vi.fn()
  let remainingThreadListResponses = options.threadListResponses ?? Number.POSITIVE_INFINITY
  const child = Object.assign(childPromise, {
    stdin,
    stdout,
    stderr,
    kill
  })
  stdin.on('data', (data: Buffer) => {
    for (const line of data.toString('utf8').trim().split('\n')) {
      const request = JSON.parse(line) as { id?: number; method: string }
      if (request.id === undefined) {
        continue
      }
      requests.push({ id: request.id, method: request.method })
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
      if (request.method === 'thread/list' && options.threadList && remainingThreadListResponses > 0) {
        remainingThreadListResponses -= 1
        queueMicrotask(() => {
          stdout.write(`${JSON.stringify({
            id: request.id,
            result: {
              data: options.threadListData ?? [],
              nextCursor: null
            }
          })}\n`)
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
    exit(result = { exitCode: 0 }) {
      resolveExit({
        ...result,
        stderr: ''
      })
    }
  }
}

function receivedEvent(text: string) {
  return {
    source: 'web' as const,
    message: createMessage({
      id: text,
      thread: { id: text, name: text },
      role: 'user',
      text
    })
  }
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

  async login(): Promise<Result<boolean>> {
    return Result.success(true)
  }

  async send(input: { thread: { id: string } }): Promise<Result<{ threadId: string; turnId: string }>> {
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

  async login(): Promise<Result<boolean>> {
    return Result.success(true)
  }

  async send(input: { thread: { id: string } }): Promise<Result<{ threadId: string; turnId: string }>> {
    return Result.success({
      threadId: input.thread.id,
      turnId: input.thread.id
    })
  }
}
