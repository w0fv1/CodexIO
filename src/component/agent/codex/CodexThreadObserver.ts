import { z } from 'zod'
import { CodexRpcClient, CodexThreadSnapshot } from './CodexProtocol.js'

const ThreadListResponseSchema = z.object({
  data: z.array(z.object({
    id: z.string().min(1),
    updatedAt: z.number()
  }).passthrough()),
  nextCursor: z.string().nullable().optional()
})

const ThreadReadResponseSchema = z.object({
  thread: z.object({
    id: z.string().min(1),
    name: z.string().nullish(),
    preview: z.string().nullish(),
    turns: z.array(z.object({
      id: z.string().min(1),
      status: z.string(),
      completedAt: z.number().nullish(),
      items: z.array(z.object({
        id: z.string().min(1),
        type: z.string(),
        text: z.string().optional(),
        phase: z.string().nullish()
      }).passthrough())
    }).passthrough()).default([])
  }).passthrough()
})

type ThreadCandidate = {
  id: string
  updatedAt: number
}

type ThreadSyncState = ThreadCandidate & {
  stableSince: number
  firstObservedAt: number
  reconciledUpdatedAt?: number
  lastReadAt?: number
  retryAttempt: number
  retryAt: number
}

export type CodexThreadObserverOptions = {
  intervalMs: number
  overlapSeconds?: number
}

export type CodexThreadObserverDiagnostic = {
  event: string
  data: Record<string, unknown>
}

export class CodexThreadObserver {
  private readonly ignoredThreadIds = new Set<string>()
  private readonly threadStates = new Map<string, ThreadSyncState>()
  private timer?: NodeJS.Timeout
  private polling?: Promise<void>
  private active = false
  private baselineCompletedAt = 0
  private updatedAtWatermark = 0
  private auditCursor: string | null = null

  constructor(
    private readonly rpc: CodexRpcClient,
    private readonly options: CodexThreadObserverOptions,
    private readonly emit: (snapshot: CodexThreadSnapshot) => Promise<void>,
    private readonly receiveError: (error: Error) => void = () => {},
    private readonly diagnose: (diagnostic: CodexThreadObserverDiagnostic) => void = () => {}
  ) {}

  async start(): Promise<void> {
    if (this.active) {
      return
    }
    this.active = true
    this.baselineCompletedAt = Math.floor(Date.now() / 1000)
    const observedAt = Date.now()
    try {
      const page = await this.listPage(null)
      this.updatedAtWatermark = page.data.length > 0
        ? Math.max(...page.data.map((thread) => thread.updatedAt))
        : this.baselineCompletedAt
      const observationBoundary = this.baselineCompletedAt - this.overlapSeconds()
      let crossedObservationBoundary = false
      for (const thread of page.data) {
        if (thread.updatedAt < observationBoundary) {
          crossedObservationBoundary = true
          continue
        }
        if (this.ignoredThreadIds.has(thread.id)) {
          continue
        }
        this.threadStates.set(thread.id, {
          ...thread,
          stableSince: observedAt,
          firstObservedAt: observedAt,
          reconciledUpdatedAt: thread.updatedAt < this.baselineCompletedAt ? thread.updatedAt : undefined,
          retryAttempt: 0,
          retryAt: 0
        })
      }
      this.auditCursor = crossedObservationBoundary ? null : page.nextCursor ?? null
      this.diagnose({
        event: 'baselineEstablished',
        data: {
          threadCount: page.data.length,
          intervalMs: this.options.intervalMs,
          baselineCompletedAt: this.baselineCompletedAt,
          updatedAtWatermark: this.updatedAtWatermark,
          truncated: Boolean(page.nextCursor)
        }
      })
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      this.updatedAtWatermark = this.baselineCompletedAt
      this.receiveError(failure)
      this.diagnose({
        event: 'baselineFailed',
        data: {
          intervalMs: this.options.intervalMs,
          baselineCompletedAt: this.baselineCompletedAt,
          reason: failure.message
        }
      })
    }
    this.schedule()
  }

  stop(): void {
    const state = {
      ignoredThreadCount: this.ignoredThreadIds.size,
      observedThreadCount: this.threadStates.size,
      pendingThreadCount: this.pendingThreadCount(),
      updatedAtWatermark: this.updatedAtWatermark
    }
    this.active = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.threadStates.clear()
    this.auditCursor = null
    this.diagnose({
      event: 'stopped',
      data: state
    })
  }

  ignoreThread(threadId: string): void {
    const normalized = threadId.trim()
    if (!normalized) {
      return
    }
    this.ignoredThreadIds.add(normalized)
    this.threadStates.delete(normalized)
    this.diagnose({
      event: 'threadIgnored',
      data: {
        threadId: normalized
      }
    })
  }

  private schedule(): void {
    if (!this.active || this.timer || this.polling) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.poll().catch((error) => {
        this.receiveError(error instanceof Error ? error : new Error(String(error)))
      })
    }, this.options.intervalMs)
    this.timer.unref()
  }

  private poll(): Promise<void> {
    if (!this.active) {
      return Promise.resolve()
    }
    if (this.polling) {
      return this.polling
    }
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    const polling = this.pollNow().finally(() => {
      if (this.polling === polling) {
        this.polling = undefined
      }
      this.schedule()
    })
    this.polling = polling
    return polling
  }

  private async pollNow(): Promise<void> {
    if (!this.active) {
      return
    }
    try {
      await this.scanCandidates()
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      this.receiveError(failure)
      this.diagnose({
        event: 'candidateScanFailed',
        data: {
          reason: failure.message,
          pendingThreadCount: this.pendingThreadCount(),
          updatedAtWatermark: this.updatedAtWatermark
        }
      })
    }
    const candidates = this.readyCandidates(Date.now())
    let succeededThreadCount = 0
    let pendingThreadCount = 0
    let failedThreadCount = 0
    let nextCandidateIndex = 0
    await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
      while (this.active) {
        const candidate = candidates[nextCandidateIndex]
        nextCandidateIndex += 1
        if (!candidate) {
          return
        }
        const state = this.threadStates.get(candidate.id)
        if (!state || this.ignoredThreadIds.has(candidate.id)) {
          continue
        }
        state.lastReadAt = Date.now()
        try {
          const reconciled = await this.readThread(candidate.id)
          if (!reconciled) {
            this.scheduleRetry(state)
            pendingThreadCount += 1
            continue
          }
          if (state.updatedAt === candidate.updatedAt) {
            state.reconciledUpdatedAt = candidate.updatedAt
            state.firstObservedAt = Date.now()
            state.retryAttempt = 0
            state.retryAt = 0
          }
          succeededThreadCount += 1
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error))
          this.scheduleRetry(state)
          failedThreadCount += 1
          this.receiveError(failure)
          this.diagnose({
            event: 'threadReconcileFailed',
            data: {
              threadId: candidate.id,
              updatedAt: candidate.updatedAt,
              retryAttempt: state.retryAttempt,
              retryAt: state.retryAt,
              reason: failure.message
            }
          })
        }
      }
    }))
    this.diagnose({
      event: 'pollCompleted',
      data: {
        readyThreadCount: candidates.length,
        succeededThreadCount,
        pendingThreadCount,
        failedThreadCount,
        unreconciledThreadCount: this.pendingThreadCount(),
        updatedAtWatermark: this.updatedAtWatermark
      }
    })
  }

  private async scanCandidates(): Promise<void> {
    const overlapSeconds = this.overlapSeconds()
    const boundary = Math.max(Math.floor(Date.now() / 1000), this.updatedAtWatermark) - overlapSeconds
    const observationBoundary = this.baselineCompletedAt - overlapSeconds
    const observedAt = Date.now()
    const observedThreadIds = new Set<string>()
    let cursor: string | null = null
    let pageCount = 0
    let crossedBoundary = false
    let crossedObservationBoundary = false
    let newestUpdatedAt = this.updatedAtWatermark
    let recentContinuation: string | null = null
    do {
      const page = await this.listPage(cursor)
      pageCount += 1
      for (const thread of page.data) {
        newestUpdatedAt = Math.max(newestUpdatedAt, thread.updatedAt)
        if (thread.updatedAt < observationBoundary) {
          crossedObservationBoundary = true
          crossedBoundary = true
          continue
        }
        if (thread.updatedAt < boundary) {
          crossedBoundary = true
        }
        if (this.ignoredThreadIds.has(thread.id)) {
          continue
        }
        observedThreadIds.add(thread.id)
        this.observe(thread, observedAt)
      }
      recentContinuation = page.nextCursor ?? null
      cursor = crossedBoundary ? null : recentContinuation
    } while (this.active && cursor)
    if (!this.active) {
      return
    }
    if (crossedObservationBoundary) {
      this.auditCursor = null
    } else {
      if (this.auditCursor === null) {
        this.auditCursor = recentContinuation
      }
      const auditCursor = this.auditCursor
      if (auditCursor) {
        let auditPage: z.infer<typeof ThreadListResponseSchema>
        try {
          auditPage = await this.listPage(auditCursor)
        } catch (error) {
          this.auditCursor = null
          throw error
        }
        pageCount += 1
        let auditCrossedObservationBoundary = false
        for (const thread of auditPage.data) {
          newestUpdatedAt = Math.max(newestUpdatedAt, thread.updatedAt)
          if (thread.updatedAt < observationBoundary) {
            auditCrossedObservationBoundary = true
            continue
          }
          if (this.ignoredThreadIds.has(thread.id)) {
            continue
          }
          observedThreadIds.add(thread.id)
          this.observe(thread, observedAt)
        }
        this.auditCursor = auditCrossedObservationBoundary ? null : auditPage.nextCursor ?? null
      }
    }
    this.updatedAtWatermark = newestUpdatedAt
    this.diagnose({
      event: 'candidateScanCompleted',
      data: {
        pageCount,
        candidateThreadCount: observedThreadIds.size,
        observedThreadCount: this.threadStates.size,
        unreconciledThreadCount: this.pendingThreadCount(),
        overlapSeconds,
        boundary,
        observationBoundary,
        auditPending: this.auditCursor !== null,
        crossedBoundary,
        updatedAtWatermark: this.updatedAtWatermark
      }
    })
  }

  private observe(thread: ThreadCandidate, observedAt: number): void {
    const state = this.threadStates.get(thread.id)
    if (!state) {
      this.threadStates.set(thread.id, {
        ...thread,
        stableSince: observedAt,
        firstObservedAt: observedAt,
        retryAttempt: 0,
        retryAt: 0
      })
      return
    }
    if (state.updatedAt === thread.updatedAt) {
      return
    }
    const wasReconciled = state.reconciledUpdatedAt === state.updatedAt
    state.updatedAt = thread.updatedAt
    state.stableSince = observedAt
    if (wasReconciled) {
      state.firstObservedAt = observedAt
      state.retryAttempt = 0
      state.retryAt = 0
    }
  }

  private readyCandidates(now: number): ThreadCandidate[] {
    const settleMs = 2000
    const maxWaitMs = 10000
    return [...this.threadStates.values()]
      .filter((state) => {
        if (state.reconciledUpdatedAt === state.updatedAt || state.retryAt > now) {
          return false
        }
        return state.retryAttempt > 0
          || now - state.stableSince >= settleMs
          || now - state.firstObservedAt >= maxWaitMs
      })
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(({ id, updatedAt }) => ({ id, updatedAt }))
  }

  private scheduleRetry(state: ThreadSyncState): void {
    state.retryAttempt += 1
    const baseDelay = Math.max(1000, this.options.intervalMs)
    state.retryAt = Date.now() + Math.min(10000, baseDelay * (2 ** (state.retryAttempt - 1)))
  }

  private overlapSeconds(): number {
    return this.options.overlapSeconds ?? Math.max(30, Math.ceil(this.options.intervalMs / 1000) * 3)
  }

  private pendingThreadCount(): number {
    return [...this.threadStates.values()].filter((state) => state.reconciledUpdatedAt !== state.updatedAt).length
  }

  private async listPage(cursor: string | null): Promise<z.infer<typeof ThreadListResponseSchema>> {
    return ThreadListResponseSchema.parse(await this.rpc.request('thread/list', {
      cursor,
      limit: 100,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      sourceKinds: ['vscode'],
      archived: false,
      useStateDbOnly: true
    }))
  }

  private async readThread(threadId: string): Promise<boolean> {
    const response = ThreadReadResponseSchema.parse(await this.rpc.request('thread/read', {
      threadId,
      includeTurns: true
    }))
    const statusCounts: Record<string, number> = {}
    const itemTypeCounts: Record<string, number> = {}
    let completedTurnCount = 0
    let terminalTurnWithoutTimestampCount = 0
    let terminalTurnWithoutAgentMessageCount = 0
    let nonTerminalTurnCount = 0
    let agentMessageCount = 0
    let sourceSequence = 0
    const messages: CodexThreadSnapshot['messages'] = []
    for (const turn of response.thread.turns) {
      statusCounts[turn.status] = (statusCounts[turn.status] ?? 0) + 1
      if (turn.status === 'completed') {
        completedTurnCount += 1
      }
      const publishableItems: Array<{ item: typeof turn.items[number], sequence: number }> = []
      for (const item of turn.items) {
        const sequence = sourceSequence
        sourceSequence += 1
        itemTypeCounts[item.type] = (itemTypeCounts[item.type] ?? 0) + 1
        if (item.type === 'agentMessage' && item.text?.trim()) {
          agentMessageCount += 1
          if (item.phase !== 'commentary') {
            publishableItems.push({ item, sequence })
          }
        }
      }
      if (turn.status !== 'completed' && turn.status !== 'interrupted' && turn.status !== 'failed') {
        nonTerminalTurnCount += 1
        continue
      }
      if (turn.status === 'failed') {
        continue
      }
      if (turn.completedAt == null) {
        terminalTurnWithoutTimestampCount += 1
        continue
      }
      if (turn.completedAt < this.baselineCompletedAt) {
        continue
      }
      if (publishableItems.length === 0) {
        terminalTurnWithoutAgentMessageCount += 1
      }
      for (const { item, sequence } of publishableItems) {
        messages.push({
          turnId: turn.id,
          itemId: item.id,
          role: 'assistant',
          text: item.text as string,
          completedAt: turn.completedAt,
          sequence
        })
      }
    }
    messages.sort((left, right) => left.completedAt - right.completedAt || left.sequence - right.sequence)
    const thread = {
      id: threadId,
      name: response.thread.name?.trim() || response.thread.preview?.trim() || '新对话'
    }
    this.diagnose({
      event: 'threadRead',
      data: {
        threadId,
        threadName: thread.name,
        turnCount: response.thread.turns.length,
        statusCounts,
        itemTypeCounts,
        completedTurnCount,
        terminalTurnWithoutTimestampCount,
        terminalTurnWithoutAgentMessageCount,
        nonTerminalTurnCount,
        agentMessageCount,
        baselineCompletedAt: this.baselineCompletedAt,
        snapshotMessageCount: messages.length
      }
    })
    if (messages.length > 0 && this.active) {
      await this.emit({
        thread,
        messages
      })
      this.diagnose({
        event: 'snapshotEmitted',
        data: {
          threadId,
          messageCount: messages.length,
          turnIds: [...new Set(messages.map((message) => message.turnId))],
          messageItemIds: messages.map((message) => message.itemId)
        }
      })
    }
    if (terminalTurnWithoutTimestampCount > 0 || terminalTurnWithoutAgentMessageCount > 0 || nonTerminalTurnCount > 0) {
      this.diagnose({
        event: 'threadReconcilePending',
        data: {
          threadId,
          terminalTurnWithoutTimestampCount,
          terminalTurnWithoutAgentMessageCount,
          nonTerminalTurnCount
        }
      })
      return false
    }
    return true
  }
}
