import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexThreadObserver } from '../src/component/agent/codex/CodexThreadObserver.js'
import { CodexThreadSnapshot } from '../src/component/agent/codex/CodexProtocol.js'

describe('CodexThreadObserver', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('emits one snapshot for each stable source version after the observer baseline', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T00:00:00.500Z'))
    const snapshots: CodexThreadSnapshot[] = []
    let listCount = 0
    const observer = new CodexThreadObserver({
      request: async (method) => {
        if (method === 'thread/list') {
          listCount += 1
          return {
            data: [{ id: 'thread-1', updatedAt: listCount === 1 ? 1783728000 : 1783728001 }],
            nextCursor: null
          }
        }
        if (method === 'thread/read') {
          return {
            thread: {
              id: 'thread-1',
              name: 'Architecture review',
              turns: [
                {
                  id: 'old-turn',
                  status: 'completed',
                  completedAt: 1783727999,
                  items: [{ id: 'old-message', type: 'agentMessage', text: 'old' }]
                },
                {
                  id: 'new-turn',
                  status: 'completed',
                  completedAt: 1783728001,
                  items: [{ id: 'new-message', type: 'agentMessage', text: 'new' }]
                }
              ]
            }
          }
        }
        throw new Error(method)
      }
    }, {
      intervalMs: 1000
    }, async (snapshot) => {
      snapshots.push(snapshot)
    })

    await observer.start()
    await observer['poll']()
    vi.setSystemTime(new Date('2026-07-11T00:00:02.500Z'))
    await observer['poll']()

    expect(snapshots).toEqual([
      {
        thread: {
          id: 'thread-1',
          name: 'Architecture review'
        },
        messages: [{
          turnId: 'new-turn',
          itemId: 'new-message',
          role: 'assistant',
          text: 'new',
          completedAt: 1783728001,
          sequence: 1
        }]
      }
    ])
    observer.stop()
  })

  it('accepts null completion timestamps on unfinished turns', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T00:00:00Z'))
    const snapshots: CodexThreadSnapshot[] = []
    let updatedAt = 1783728000
    const observer = new CodexThreadObserver({
      request: async (method) => {
        if (method === 'thread/list') {
          return {
            data: [{ id: 'thread-1', updatedAt }],
            nextCursor: null
          }
        }
        if (method === 'thread/read') {
          return {
            thread: {
              id: 'thread-1',
              name: 'Thread',
              turns: [
                {
                  id: 'active-turn',
                  status: 'inProgress',
                  completedAt: null,
                  items: []
                },
                {
                  id: 'completed-turn',
                  status: 'completed',
                  completedAt: 1783728001,
                  items: [{ id: 'message', type: 'agentMessage', text: 'reply' }]
                }
              ]
            }
          }
        }
        throw new Error(method)
      }
    }, {
      intervalMs: 1000
    }, async (snapshot) => {
      snapshots.push(snapshot)
    })

    await observer.start()
    updatedAt = 1783728001
    await observer['poll']()
    vi.setSystemTime(new Date('2026-07-11T00:00:02Z'))
    await observer['poll']()

    expect(snapshots).toMatchObject([{
      messages: [{ itemId: 'message', text: 'reply' }]
    }])
    observer.stop()
  })

  it('preserves source order when completion timestamps are equal', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T00:00:00Z'))
    const snapshots: CodexThreadSnapshot[] = []
    let updatedAt = 1783728000
    const observer = new CodexThreadObserver({
      request: async (method) => {
        if (method === 'thread/list') {
          return {
            data: [{ id: 'thread-1', updatedAt }],
            nextCursor: null
          }
        }
        if (method === 'thread/read') {
          return {
            thread: {
              id: 'thread-1',
              name: 'Thread',
              turns: [
                {
                  id: 'turn-z',
                  status: 'completed',
                  completedAt: 1783728001,
                  items: [{ id: 'item-a', type: 'agentMessage', text: 'third' }]
                },
                {
                  id: 'turn-a',
                  status: 'completed',
                  completedAt: 1783728001,
                  items: [
                    { id: 'item-z', type: 'agentMessage', text: 'second' },
                    { id: 'item-b', type: 'agentMessage', text: 'first' }
                  ]
                }
              ]
            }
          }
        }
        throw new Error(method)
      }
    }, {
      intervalMs: 1000
    }, async (snapshot) => {
      snapshots.push(snapshot)
    })

    await observer.start()
    updatedAt = 1783728001
    await observer['poll']()
    vi.setSystemTime(new Date('2026-07-11T00:00:02Z'))
    await observer['poll']()

    expect(snapshots[0].messages.map((message) => `${message.turnId}/${message.itemId}`)).toEqual([
      'turn-z/item-a',
      'turn-a/item-z',
      'turn-a/item-b'
    ])
    observer.stop()
  })

  it('stops candidate pagination after crossing the overlap watermark', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T00:00:00Z'))
    const listParams: unknown[] = []
    let listCount = 0
    const observer = new CodexThreadObserver({
      request: async (method, params) => {
        if (method === 'thread/list') {
          listParams.push(params)
          listCount += 1
          return listCount === 1
            ? {
                data: [{ id: 'baseline', updatedAt: 1783728000 }],
                nextCursor: 'baseline-next'
              }
            : listCount === 2
              ? {
                data: [
                  { id: 'recent', updatedAt: 1783728002 },
                  { id: 'outside-overlap', updatedAt: 1783727960 }
                ],
                nextCursor: 'must-not-be-read'
              }
              : {
                  data: [],
                  nextCursor: null
                }
        }
        if (method === 'thread/read') {
          return {
            thread: {
              id: 'recent',
              name: 'Recent',
              turns: []
            }
          }
        }
        throw new Error(method)
      }
    }, {
      intervalMs: 1000,
      overlapSeconds: 30
    }, async () => {})

    await observer.start()
    await observer['poll']()

    expect(listParams).toHaveLength(2)
    expect(listParams).not.toContainEqual(expect.objectContaining({
      cursor: 'must-not-be-read'
    }))
    observer.stop()
  })

  it('lets the overlap window advance when no newer thread appears', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T00:00:00Z'))
    let readCount = 0
    const observer = new CodexThreadObserver({
      request: async (method) => {
        if (method === 'thread/list') {
          return {
            data: [{ id: 'thread-1', updatedAt: 1783727999 }],
            nextCursor: null
          }
        }
        if (method === 'thread/read') {
          readCount += 1
          return {
            thread: {
              id: 'thread-1',
              name: 'Thread',
              turns: []
            }
          }
        }
        throw new Error(method)
      }
    }, {
      intervalMs: 1000,
      overlapSeconds: 30
    }, async () => {})

    await observer.start()
    await observer['poll']()
    expect(readCount).toBe(0)

    vi.setSystemTime(new Date('2026-07-11T00:00:31Z'))
    await observer['poll']()
    expect(readCount).toBe(0)
    observer.stop()
  })

  it('reports an initial list failure and recovers through the scheduled loop', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T00:00:00Z'))
    const errors: Error[] = []
    const snapshots: CodexThreadSnapshot[] = []
    let listCount = 0
    const observer = new CodexThreadObserver({
      request: async (method) => {
        if (method === 'thread/list') {
          listCount += 1
          if (listCount === 1) {
            throw new Error('initial list unavailable')
          }
          return {
            data: [{ id: 'thread-1', updatedAt: 1783728001 }],
            nextCursor: null
          }
        }
        if (method === 'thread/read') {
          return {
            thread: {
              id: 'thread-1',
              name: 'Recovered',
              turns: [{
                id: 'turn-1',
                status: 'completed',
                completedAt: 1783728001,
                items: [{ id: 'message-1', type: 'agentMessage', text: 'reply' }]
              }]
            }
          }
        }
        throw new Error(method)
      }
    }, {
      intervalMs: 1000
    }, async (snapshot) => {
      snapshots.push(snapshot)
    }, (error) => {
      errors.push(error)
    })

    await observer.start()
    expect(errors.map((error) => error.message)).toEqual(['initial list unavailable'])

    await vi.advanceTimersByTimeAsync(3000)
    expect(listCount).toBe(4)
    expect(snapshots).toHaveLength(1)
    observer.stop()
  })

  it('isolates thread read failures and retries them without blocking other snapshots', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T00:00:00Z'))
    const snapshots: CodexThreadSnapshot[] = []
    const errors: Error[] = []
    let failedRead = false
    let updatedAt = 1783727999
    const observer = new CodexThreadObserver({
      request: async (method, params) => {
        if (method === 'thread/list') {
          return {
            data: [
              { id: 'thread-a', updatedAt },
              { id: 'thread-b', updatedAt }
            ],
            nextCursor: null
          }
        }
        if (method === 'thread/read') {
          const threadId = (params as { threadId: string }).threadId
          if (threadId === 'thread-a' && !failedRead) {
            failedRead = true
            throw new Error('temporary read failure')
          }
          return {
            thread: {
              id: threadId,
              name: threadId,
              turns: [{
                id: `${threadId}-turn`,
                status: 'completed',
                completedAt: 1783728001,
                items: [{
                  id: `${threadId}-message`,
                  type: 'agentMessage',
                  text: threadId
                }]
              }]
            }
          }
        }
        throw new Error(method)
      }
    }, {
      intervalMs: 1000
    }, async (snapshot) => {
      snapshots.push(snapshot)
    }, (error) => {
      errors.push(error)
    })

    await observer.start()
    updatedAt = 1783728001
    await observer['poll']()
    vi.setSystemTime(new Date('2026-07-11T00:00:02Z'))
    await observer['poll']()
    expect(snapshots.map((snapshot) => snapshot.thread.id)).toEqual(['thread-b'])
    expect(errors.map((error) => error.message)).toEqual(['temporary read failure'])

    vi.setSystemTime(new Date('2026-07-11T00:00:03Z'))
    await observer['poll']()
    expect(snapshots.map((snapshot) => snapshot.thread.id)).toEqual([
      'thread-b',
      'thread-a'
    ])
    observer.stop()
  })

  it('retries a snapshot until asynchronous ingestion acknowledges it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T00:00:00Z'))
    let ingestAttempts = 0
    let updatedAt = 1783728000
    const errors: Error[] = []
    const observer = new CodexThreadObserver({
      request: async (method) => {
        if (method === 'thread/list') {
          return {
            data: [{ id: 'thread-1', updatedAt }],
            nextCursor: null
          }
        }
        if (method === 'thread/read') {
          return {
            thread: {
              id: 'thread-1',
              name: 'Thread',
              turns: [{
                id: 'turn-1',
                status: 'completed',
                completedAt: 1783728001,
                items: [{ id: 'message-1', type: 'agentMessage', text: 'reply' }]
              }]
            }
          }
        }
        throw new Error(method)
      }
    }, {
      intervalMs: 1000
    }, async () => {
      ingestAttempts += 1
      if (ingestAttempts === 1) {
        throw new Error('ingestion unavailable')
      }
    }, (error) => {
      errors.push(error)
    })

    await observer.start()
    updatedAt = 1783728001
    await observer['poll']()
    vi.setSystemTime(new Date('2026-07-11T00:00:02Z'))
    await observer['poll']()
    vi.setSystemTime(new Date('2026-07-11T00:00:03Z'))
    await observer['poll']()

    expect(ingestAttempts).toBe(2)
    expect(errors.map((error) => error.message)).toEqual(['ingestion unavailable'])
    observer.stop()
  })

  it('schedules the next poll only after the current poll finishes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T00:00:00Z'))
    let listCount = 0
    let finishPoll: (() => void) | undefined
    const observer = new CodexThreadObserver({
      request: async (method) => {
        if (method !== 'thread/list') {
          throw new Error(method)
        }
        listCount += 1
        if (listCount === 2) {
          await new Promise<void>((resolve) => {
            finishPoll = resolve
          })
        }
        return {
          data: [],
          nextCursor: null
        }
      }
    }, {
      intervalMs: 1000
    }, async () => {})

    await observer.start()
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(5000)
    expect(listCount).toBe(2)

    finishPoll?.()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(999)
    expect(listCount).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(listCount).toBe(3)
    observer.stop()
  })

  it('emits an interrupted final answer without commentary', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T00:00:00Z'))
    let updatedAt = 1783728000
    const snapshots: CodexThreadSnapshot[] = []
    const observer = new CodexThreadObserver({
      request: async (method) => {
        if (method === 'thread/list') {
          return {
            data: [{ id: 'thread-1', updatedAt }],
            nextCursor: null
          }
        }
        if (method === 'thread/read') {
          return {
            thread: {
              id: 'thread-1',
              name: 'Thread',
              turns: [{
                id: 'turn-1',
                status: 'interrupted',
                completedAt: 1783728001,
                items: [
                  { id: 'commentary', type: 'agentMessage', phase: 'commentary', text: 'working' },
                  { id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'answer' }
                ]
              }]
            }
          }
        }
        throw new Error(method)
      }
    }, {
      intervalMs: 1000
    }, async (snapshot) => {
      snapshots.push(snapshot)
    })

    await observer.start()
    updatedAt = 1783728001
    await observer['poll']()
    vi.setSystemTime(new Date('2026-07-11T00:00:02Z'))
    await observer['poll']()

    expect(snapshots).toMatchObject([{
      messages: [{
        itemId: 'final',
        text: 'answer',
        sequence: 1
      }]
    }])
    observer.stop()
  })

  it('reconciles each stable source version once', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T00:00:00Z'))
    let updatedAt = 1783728000
    let readCount = 0
    const observer = new CodexThreadObserver({
      request: async (method) => {
        if (method === 'thread/list') {
          return {
            data: [{ id: 'thread-1', updatedAt }],
            nextCursor: null
          }
        }
        if (method === 'thread/read') {
          readCount += 1
          return {
            thread: {
              id: 'thread-1',
              name: 'Thread',
              turns: []
            }
          }
        }
        throw new Error(method)
      }
    }, {
      intervalMs: 1000
    }, async () => {})

    await observer.start()
    updatedAt = 1783728001
    await observer['poll']()
    expect(readCount).toBe(0)

    vi.setSystemTime(new Date('2026-07-11T00:00:02Z'))
    await observer['poll']()
    await observer['poll']()
    expect(readCount).toBe(1)
    observer.stop()
  })

  it('does not acknowledge an in-progress view for a stable source version', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T00:00:00Z'))
    let updatedAt = 1783727999
    let status = 'inProgress'
    const snapshots: CodexThreadSnapshot[] = []
    const observer = new CodexThreadObserver({
      request: async (method) => {
        if (method === 'thread/list') {
          return {
            data: [{ id: 'thread-1', updatedAt }],
            nextCursor: null
          }
        }
        if (method === 'thread/read') {
          return {
            thread: {
              id: 'thread-1',
              name: 'Thread',
              turns: [{
                id: 'turn-1',
                status,
                completedAt: status === 'completed' ? 1783728001 : null,
                items: status === 'completed'
                  ? [{ id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'answer' }]
                  : []
              }]
            }
          }
        }
        throw new Error(method)
      }
    }, {
      intervalMs: 1000
    }, async (snapshot) => {
      snapshots.push(snapshot)
    })

    await observer.start()
    updatedAt = 1783728001
    await observer['poll']()
    vi.setSystemTime(new Date('2026-07-11T00:00:02Z'))
    await observer['poll']()
    expect(snapshots).toEqual([])

    status = 'completed'
    vi.setSystemTime(new Date('2026-07-11T00:00:03Z'))
    await observer['poll']()
    expect(snapshots).toMatchObject([{
      messages: [{ itemId: 'final', text: 'answer' }]
    }])
    observer.stop()
  })

  it('does not lose a source version from the baseline second', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T00:00:00Z'))
    const snapshots: CodexThreadSnapshot[] = []
    const observer = new CodexThreadObserver({
      request: async (method) => {
        if (method === 'thread/list') {
          return {
            data: [{ id: 'thread-1', updatedAt: 1783728000 }],
            nextCursor: null
          }
        }
        if (method === 'thread/read') {
          return {
            thread: {
              id: 'thread-1',
              name: 'Thread',
              turns: [{
                id: 'turn-1',
                status: 'completed',
                completedAt: 1783728000,
                items: [{ id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'answer' }]
              }]
            }
          }
        }
        throw new Error(method)
      }
    }, {
      intervalMs: 1000
    }, async (snapshot) => {
      snapshots.push(snapshot)
    })

    await observer.start()
    vi.setSystemTime(new Date('2026-07-11T00:00:02Z'))
    await observer['poll']()

    expect(snapshots).toHaveLength(1)
    observer.stop()
  })

  it('reconciles a continuously changing thread at the max wait boundary', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T00:00:00Z'))
    let updatedAt = 1783727999
    let readCount = 0
    const observer = new CodexThreadObserver({
      request: async (method) => {
        if (method === 'thread/list') {
          return {
            data: [{ id: 'thread-1', updatedAt }],
            nextCursor: null
          }
        }
        if (method === 'thread/read') {
          readCount += 1
          return {
            thread: {
              id: 'thread-1',
              name: 'Thread',
              turns: []
            }
          }
        }
        throw new Error(method)
      }
    }, {
      intervalMs: 1000
    }, async () => {})

    await observer.start()
    for (let second = 1; second <= 10; second += 1) {
      updatedAt += 1
      vi.setSystemTime(new Date(`2026-07-11T00:00:${String(second).padStart(2, '0')}Z`))
      await observer['poll']()
    }
    expect(readCount).toBe(0)

    updatedAt += 1
    vi.setSystemTime(new Date('2026-07-11T00:00:11Z'))
    await observer['poll']()
    expect(readCount).toBe(1)
    observer.stop()
  })

  it('preserves pending retry backoff across source version churn', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T00:00:00Z'))
    let updatedAt = 1783727999
    let readCount = 0
    const observer = new CodexThreadObserver({
      request: async (method) => {
        if (method === 'thread/list') {
          return {
            data: [{ id: 'thread-1', updatedAt }],
            nextCursor: null
          }
        }
        if (method === 'thread/read') {
          readCount += 1
          return {
            thread: {
              id: 'thread-1',
              name: 'Thread',
              turns: [{
                id: 'turn-1',
                status: 'completed',
                completedAt: null,
                items: []
              }]
            }
          }
        }
        throw new Error(method)
      }
    }, {
      intervalMs: 1000
    }, async () => {})

    await observer.start()
    updatedAt = 1783728001
    await observer['poll']()
    for (const second of [2, 3, 5]) {
      vi.setSystemTime(new Date(`2026-07-11T00:00:0${second}Z`))
      await observer['poll']()
    }
    expect(readCount).toBe(3)

    updatedAt = 1783728002
    vi.setSystemTime(new Date('2026-07-11T00:00:06Z'))
    await observer['poll']()
    vi.setSystemTime(new Date('2026-07-11T00:00:08Z'))
    await observer['poll']()
    expect(readCount).toBe(3)

    vi.setSystemTime(new Date('2026-07-11T00:00:09Z'))
    await observer['poll']()
    expect(readCount).toBe(4)
    observer.stop()
  })

  it('finds a source update that becomes visible after the overlap duration', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T00:00:00Z'))
    let visible = false
    let readCount = 0
    const observer = new CodexThreadObserver({
      request: async (method) => {
        if (method === 'thread/list') {
          return {
            data: visible ? [{ id: 'thread-1', updatedAt: 1783728001 }] : [],
            nextCursor: null
          }
        }
        if (method === 'thread/read') {
          readCount += 1
          return {
            thread: {
              id: 'thread-1',
              name: 'Thread',
              turns: [{
                id: 'turn-1',
                status: 'completed',
                completedAt: 1783728001,
                items: [{ id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'answer' }]
              }]
            }
          }
        }
        throw new Error(method)
      }
    }, {
      intervalMs: 1000,
      overlapSeconds: 30
    }, async () => {})

    await observer.start()
    visible = true
    vi.setSystemTime(new Date('2026-07-11T00:01:00Z'))
    await observer['poll']()
    vi.setSystemTime(new Date('2026-07-11T00:01:02Z'))
    await observer['poll']()

    expect(readCount).toBe(1)
    observer.stop()
  })

  it('bounds historical audit pagination per poll', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T00:00:00Z'))
    let baseline = true
    const cursors: Array<string | null> = []
    const observer = new CodexThreadObserver({
      request: async (method, params) => {
        if (method === 'thread/list') {
          const cursor = (params as { cursor: string | null }).cursor
          cursors.push(cursor)
          if (baseline) {
            return { data: [], nextCursor: null }
          }
          if (cursor === null) {
            return {
              data: [
                { id: 'recent', updatedAt: 1783731600 },
                { id: 'older-1', updatedAt: 1783728001 }
              ],
              nextCursor: 'older-1'
            }
          }
          if (cursor === 'older-1') {
            return {
              data: [{ id: 'older-2', updatedAt: 1783728001 }],
              nextCursor: 'older-2'
            }
          }
          return {
            data: [{ id: 'older-3', updatedAt: 1783728001 }],
            nextCursor: null
          }
        }
        if (method === 'thread/read') {
          return {
            thread: {
              id: 'thread',
              name: 'Thread',
              turns: []
            }
          }
        }
        throw new Error(method)
      }
    }, {
      intervalMs: 1000,
      overlapSeconds: 30
    }, async () => {})

    await observer.start()
    baseline = false
    vi.setSystemTime(new Date('2026-07-11T01:00:00Z'))
    await observer['poll']()

    expect(cursors).toEqual([null, null, 'older-1'])
    observer.stop()
  })

  it('keeps a completed turn without a timestamp unreconciled', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T00:00:00Z'))
    let updatedAt = 1783728000
    let completedAt: number | null = null
    let readCount = 0
    const snapshots: CodexThreadSnapshot[] = []
    const observer = new CodexThreadObserver({
      request: async (method) => {
        if (method === 'thread/list') {
          return {
            data: [{ id: 'thread-1', updatedAt }],
            nextCursor: null
          }
        }
        if (method === 'thread/read') {
          readCount += 1
          return {
            thread: {
              id: 'thread-1',
              name: 'Thread',
              turns: [{
                id: 'turn-1',
                status: 'completed',
                completedAt,
                items: [{ id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'answer' }]
              }]
            }
          }
        }
        throw new Error(method)
      }
    }, {
      intervalMs: 1000
    }, async (snapshot) => {
      snapshots.push(snapshot)
    })

    await observer.start()
    updatedAt = 1783728001
    await observer['poll']()
    vi.setSystemTime(new Date('2026-07-11T00:00:02Z'))
    await observer['poll']()
    expect(readCount).toBe(1)
    expect(snapshots).toEqual([])

    completedAt = 1783728001
    vi.setSystemTime(new Date('2026-07-11T00:00:03Z'))
    await observer['poll']()
    expect(readCount).toBe(2)
    expect(snapshots).toHaveLength(1)
    observer.stop()
  })

  it.each(['completed', 'interrupted'])('keeps a %s turn without its final item unreconciled', async (status) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T00:00:00Z'))
    let updatedAt = 1783728000
    let items: unknown[] = []
    let readCount = 0
    const snapshots: CodexThreadSnapshot[] = []
    const observer = new CodexThreadObserver({
      request: async (method) => {
        if (method === 'thread/list') {
          return {
            data: [{ id: 'thread-1', updatedAt }],
            nextCursor: null
          }
        }
        if (method === 'thread/read') {
          readCount += 1
          return {
            thread: {
              id: 'thread-1',
              name: 'Thread',
              turns: [{
                id: 'turn-1',
                status,
                completedAt: 1783728001,
                items
              }]
            }
          }
        }
        throw new Error(method)
      }
    }, {
      intervalMs: 1000
    }, async (snapshot) => {
      snapshots.push(snapshot)
    })

    await observer.start()
    updatedAt = 1783728001
    await observer['poll']()
    vi.setSystemTime(new Date('2026-07-11T00:00:02Z'))
    await observer['poll']()
    expect(readCount).toBe(1)
    expect(snapshots).toEqual([])

    items = [{ id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'answer' }]
    vi.setSystemTime(new Date('2026-07-11T00:00:03Z'))
    await observer['poll']()
    expect(readCount).toBe(2)
    expect(snapshots).toMatchObject([{
      messages: [{ itemId: 'final', text: 'answer' }]
    }])
    observer.stop()
  })

  it.each(['completed', 'interrupted'])('keeps a %s shell without timestamp or items unreconciled', async (status) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T00:00:00Z'))
    let updatedAt = 1783727999
    let completedAt: number | null = null
    let items: unknown[] = []
    const snapshots: CodexThreadSnapshot[] = []
    const observer = new CodexThreadObserver({
      request: async (method) => {
        if (method === 'thread/list') {
          return {
            data: [{ id: 'thread-1', updatedAt }],
            nextCursor: null
          }
        }
        if (method === 'thread/read') {
          return {
            thread: {
              id: 'thread-1',
              name: 'Thread',
              turns: [{
                id: 'turn-1',
                status,
                completedAt,
                items
              }]
            }
          }
        }
        throw new Error(method)
      }
    }, {
      intervalMs: 1000
    }, async (snapshot) => {
      snapshots.push(snapshot)
    })

    await observer.start()
    updatedAt = 1783728001
    await observer['poll']()
    vi.setSystemTime(new Date('2026-07-11T00:00:02Z'))
    await observer['poll']()
    expect(snapshots).toEqual([])

    completedAt = 1783728001
    items = [{ id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'answer' }]
    vi.setSystemTime(new Date('2026-07-11T00:00:03Z'))
    await observer['poll']()
    expect(snapshots).toMatchObject([{
      messages: [{ itemId: 'final', text: 'answer' }]
    }])
    observer.stop()
  })

  it('retries a known thread even when the next list request fails', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T00:00:00Z'))
    let updatedAt = 1783728000
    let failList = false
    let readCount = 0
    const observer = new CodexThreadObserver({
      request: async (method) => {
        if (method === 'thread/list') {
          if (failList) {
            throw new Error('list unavailable')
          }
          return {
            data: [{ id: 'thread-1', updatedAt }],
            nextCursor: null
          }
        }
        if (method === 'thread/read') {
          readCount += 1
          if (readCount === 1) {
            throw new Error('read unavailable')
          }
          return {
            thread: {
              id: 'thread-1',
              name: 'Thread',
              turns: []
            }
          }
        }
        throw new Error(method)
      }
    }, {
      intervalMs: 1000
    }, async () => {})

    await observer.start()
    updatedAt = 1783728001
    await observer['poll']()
    vi.setSystemTime(new Date('2026-07-11T00:00:02Z'))
    await observer['poll']()
    failList = true
    vi.setSystemTime(new Date('2026-07-11T00:00:03Z'))
    await observer['poll']()

    expect(readCount).toBe(2)
    observer.stop()
  })

  it('does not let one slow thread block another ready candidate', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T00:00:00Z'))
    let updatedAt = 1783727999
    let releaseSlow: (() => void) | undefined
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })
    const snapshots: CodexThreadSnapshot[] = []
    const observer = new CodexThreadObserver({
      request: async (method, params) => {
        if (method === 'thread/list') {
          return {
            data: [
              { id: 'thread-a', updatedAt },
              { id: 'thread-b', updatedAt }
            ],
            nextCursor: null
          }
        }
        if (method === 'thread/read') {
          const threadId = (params as { threadId: string }).threadId
          if (threadId === 'thread-a') {
            await slow
          }
          return {
            thread: {
              id: threadId,
              name: threadId,
              turns: [{
                id: `${threadId}-turn`,
                status: 'completed',
                completedAt: 1783728001,
                items: [{ id: `${threadId}-final`, type: 'agentMessage', phase: 'final_answer', text: threadId }]
              }]
            }
          }
        }
        throw new Error(method)
      }
    }, {
      intervalMs: 1000
    }, async (snapshot) => {
      snapshots.push(snapshot)
    })

    await observer.start()
    updatedAt = 1783728001
    await observer['poll']()
    vi.setSystemTime(new Date('2026-07-11T00:00:02Z'))
    const polling = observer['poll']()
    await vi.advanceTimersByTimeAsync(1)

    expect(snapshots.map((snapshot) => snapshot.thread.id)).toEqual(['thread-b'])
    releaseSlow?.()
    await polling
    expect(snapshots.map((snapshot) => snapshot.thread.id).sort()).toEqual(['thread-a', 'thread-b'])
    observer.stop()
  })
})
