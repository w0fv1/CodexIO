import { describe, expect, it } from 'vitest'
import { CodexMessageStreamer } from '../src/component/agent/CodexMessageStreamer.js'
import { KeyedSerialQueue } from '../src/component/KeyedSerialQueue.js'
import { EventBus } from '../src/component/EventBus.js'
import { AppEvent } from '../src/value/Event.js'
import { Message } from '../src/value/Message.js'
import { Result } from '../src/value/Result.js'

describe('Codex live ingestion', () => {
  it('does not lose concurrent completions from different turns in one thread', async () => {
    const sent = recordingMessages()
    const streamer = new CodexMessageStreamer(sent.eventBus)

    await Promise.all(Array.from({ length: 5 }, (_, index) => streamer.complete({
      thread: { id: 'io-thread', name: 'Thread' },
      agentThreadId: 'codex-thread',
      turnId: `turn-${index}`
    }, [{
      itemId: `item-${index}`,
      text: `reply-${index}`
    }])))

    expect(sent.messages.map((message) => message.text).sort()).toEqual([
      'reply-0',
      'reply-1',
      'reply-2',
      'reply-3',
      'reply-4'
    ])
    expect(new Set(sent.messages.map((message) => message.id)).size).toBe(5)
  })

  it('replays a duplicate completion with the same stable identity', async () => {
    const sent = recordingMessages()
    const streamer = new CodexMessageStreamer(sent.eventBus)
    const thread = {
      thread: { id: 'io-thread', name: 'Thread' },
      agentThreadId: 'codex-thread',
      turnId: 'turn'
    }

    await streamer.complete(thread, [{ itemId: 'item', text: 'reply' }])
    await streamer.complete(thread, [{ itemId: 'item', text: 'reply' }])

    expect(sent.messages).toHaveLength(2)
    expect(sent.messages.map((message) => message.id)).toEqual([
      sent.messages[0].id,
      sent.messages[0].id
    ])
    expect(sent.messages.map((message) => message.status)).toEqual([
      'completed',
      'completed'
    ])
    expect(sent.messages[1].revision).toBe(sent.messages[0].revision)
  })

  it('serializes one thread while allowing different threads to run in parallel', async () => {
    const mailbox = new KeyedSerialQueue()
    const order: string[] = []
    let releaseFirst: () => void = () => {}
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = mailbox.run('thread-a', async () => {
      order.push('a1:start')
      await firstGate
      order.push('a1:end')
    })
    const second = mailbox.run('thread-a', async () => {
      order.push('a2')
    })
    const parallel = mailbox.run('thread-b', async () => {
      order.push('b1')
    })

    await parallel
    expect(order).toEqual(['a1:start', 'b1'])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['a1:start', 'b1', 'a1:end', 'a2'])
  })

  it('continues a thread after one mailbox task fails', async () => {
    const mailbox = new KeyedSerialQueue()
    await expect(mailbox.run('thread', async () => {
      throw new Error('failed')
    })).rejects.toThrow('failed')
    await expect(mailbox.run('thread', async () => 'continued')).resolves.toBe('continued')
  })

  it('drains every in-flight thread before shutdown', async () => {
    const mailbox = new KeyedSerialQueue()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    void mailbox.run('thread-a', () => gate)
    void mailbox.run('thread-b', () => gate)
    let drained = false
    const draining = mailbox.drain().then(() => {
      drained = true
    })

    await Promise.resolve()
    expect(drained).toBe(false)
    release?.()
    await draining
    expect(drained).toBe(true)
  })

  it('uses one identity for streaming, live completion, and snapshot replay', async () => {
    const sent = recordingMessages()
    const streamer = new CodexMessageStreamer(sent.eventBus)
    const thread = {
      thread: { id: 'io-thread', name: 'Thread' },
      agentThreadId: 'codex-thread',
      turnId: 'turn'
    }
    const completedText = '第一段。\n\n第二段。'

    await streamer.append(thread, 'item', '第一段。\n\n第二')
    await streamer.append(thread, 'item', '段。')
    await streamer.completeItem(thread, 'item', completedText)
    await streamer.complete(thread, [{ itemId: 'item', text: completedText }])

    expect(sent.messages.map((message) => message.text)).toEqual([
      '第一段。',
      completedText,
      completedText
    ])
    expect(sent.messages.map((message) => message.status)).toEqual([
      'streaming',
      'completed',
      'completed'
    ])
    expect(new Set(sent.messages.map((message) => message.id)).size).toBe(1)
    expect(sent.messages[0].revision).not.toBe(sent.messages[1].revision)
    expect(sent.messages[2].revision).toBe(sent.messages[1].revision)
    expect(sent.messages[1].occurredAt).toBe(sent.messages[0].occurredAt)
  })

  it('keeps a completed item retryable when output delivery fails', async () => {
    const eventBus = new EventBus()
    let attempts = 0
    eventBus.on(AppEvent.ChannelMessageDisplayRequested, async () => {
      attempts += 1
      return attempts === 1 ? Result.fail('temporarily unavailable') : Result.successVoid()
    })
    const streamer = new CodexMessageStreamer(eventBus)
    const thread = {
      thread: { id: 'io-thread', name: 'Thread' },
      agentThreadId: 'codex-thread',
      turnId: 'turn'
    }

    await expect(streamer.completeItem(thread, 'item', 'reply')).rejects.toThrow('temporarily unavailable')
    await expect(streamer.completeItem(thread, 'item', 'reply')).resolves.toBeUndefined()
    expect(attempts).toBe(2)
  })

  it('stages item completion for Web and publishes externally only at turn completion', async () => {
    const sent = recordingMessages()
    const streamer = new CodexMessageStreamer(sent.eventBus)
    const thread = {
      thread: { id: 'io-thread', name: 'Thread' },
      agentThreadId: 'codex-thread',
      turnId: 'turn'
    }

    await streamer.stageItem(thread, 'item', 'reply')
    await streamer.complete(thread, [{ itemId: 'item', text: 'reply' }])

    expect(sent.messages.map((message) => message.status)).toEqual(['streaming', 'completed'])
    expect(sent.messages[1].id).toBe(sent.messages[0].id)
  })

  it('uses authoritative turn item order and clears only that turn', async () => {
    const sent = recordingMessages()
    const streamer = new CodexMessageStreamer(sent.eventBus)
    const firstTurn = {
      thread: { id: 'io-thread', name: 'Thread' },
      agentThreadId: 'codex-thread',
      turnId: 'turn-a'
    }
    const secondTurn = {
      ...firstTurn,
      turnId: 'turn-b'
    }

    await streamer.stageItem(firstTurn, 'stale', 'stale')
    await streamer.stageItem(secondTurn, 'kept', 'kept')
    await streamer.complete(firstTurn, [
      { itemId: 'second', text: 'second', sequence: 2 },
      { itemId: 'first', text: 'first', sequence: 1 }
    ])

    expect(sent.messages.filter((message) => message.status === 'completed').map((message) => message.sequence)).toEqual([2, 1])
    expect([...streamer['items'].values()].map((item) => item.turnId)).toEqual(['turn-b'])
  })
})

function recordingMessages(): { eventBus: EventBus, messages: Message[] } {
  const eventBus = new EventBus()
  const messages: Message[] = []
  eventBus.on(AppEvent.ChannelMessageDisplayRequested, async ({ message }) => {
    messages.push(message)
    await Promise.resolve()
    return Result.successVoid()
  })
  return { eventBus, messages }
}
