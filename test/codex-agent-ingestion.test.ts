import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodexioMetadata } from '../src/component/CodexioMetadata.js'
import { ThreadRegistry } from '../src/component/ThreadRegistry.js'
import { CodexAgent } from '../src/component/agent/CodexAgent.js'
import { CodexClient, CodexClientMessage, CodexThreadSnapshot } from '../src/component/agent/CodexClient.js'
import { CodexClientEventMap } from '../src/component/agent/codex/CodexProtocol.js'
import { CodexMessageStreamer } from '../src/component/agent/CodexMessageStreamer.js'
import { WebThreadManager } from '../src/component/channel/WebThreadManager.js'
import { Result } from '../src/value/Result.js'
import { createMessage, Message } from '../src/value/Message.js'
import { ChannelOutputManager } from '../src/component/channelo/ChannelOutputManager.js'

describe('Codex agent ingestion', () => {
  it('serializes the production live listener without losing concurrent completions', async () => {
    const context = fixture()
    await context.agent.start()

    for (let index = 0; index < 5; index += 1) {
      context.client.emitMessage(completedMessage(index))
    }
    await context.agent['mailbox'].drain()

    expect(context.web.snapshot().messages.map((message) => message.text)).toEqual([
      'reply-0',
      'reply-1',
      'reply-2',
      'reply-3',
      'reply-4'
    ])
    await context.agent.stop()
  })

  it('delegates snapshots to the canonical output manager without channel overrides', async () => {
    const context = fixture()
    await context.agent.start()
    const snapshot: CodexThreadSnapshot = {
      thread: { id: 'codex-thread', name: 'VS Code thread' },
      messages: Array.from({ length: 5 }, (_, index) => ({
        turnId: `turn-${index}`,
        itemId: `item-${index}`,
        role: 'assistant',
        text: `reply-${index}`,
        completedAt: 100 + index
      }))
    }

    await context.client.emitSnapshot(snapshot)
    await context.client.emitSnapshot(snapshot)

    expect(context.web.snapshot().messages).toHaveLength(5)
    expect(context.events).toHaveLength(10)
    expect(context.events.every((event) => event.context === undefined || !('targets' in event.context))).toBe(true)
    await context.agent.stop()
  })

  it('uses one Web entity for live completion and snapshot reconciliation', async () => {
    const context = fixture()
    await context.agent.start()
    context.client.emitMessage(completedMessage(0))
    await context.agent['mailbox'].drain()
    await context.client.emitSnapshot({
      thread: { id: 'codex-thread', name: 'VS Code thread' },
      messages: [{
        turnId: 'turn-0',
        itemId: 'item-0',
        role: 'assistant',
        text: 'reply-0',
        completedAt: 100
      }]
    })

    expect(context.web.snapshot().messages).toHaveLength(1)
    await context.agent.stop()
  })

  it('continues an observed Codex thread after a channel thread is bound to it', async () => {
    const context = fixture()
    await context.agent.start()
    await context.client.emitSnapshot({
      thread: { id: 'codex-thread', name: 'VS Code thread' },
      messages: []
    })
    context.registry.bind('codex-thread', {
      source: 'feishu',
      id: 'chat:thread:omt_thread'
    })
    const thread = context.registry.resolve({
      source: 'feishu',
      id: 'chat:thread:omt_thread'
    })

    await context.agent.receive({
      source: 'feishu',
      sourceMessageId: 'om_reply',
      message: createMessage({
        id: 'feishu-message',
        thread,
        role: 'user',
        text: 'continue'
      })
    })

    expect(context.client.sentThreadIds).toEqual(['codex-thread'])
    await context.agent.stop()
  })

  it('routes reconciled completion back to the source channel after continuing an observed thread', async () => {
    const context = fixture()
    await context.agent.start()
    await context.client.emitSnapshot({
      thread: { id: 'codex-thread', name: 'VS Code thread' },
      messages: []
    })
    await context.agent.receive({
      source: 'feishu',
      sourceMessageId: 'om_user',
      message: createMessage({
        id: 'feishu-message',
        thread: { id: 'codex-thread', name: 'VS Code thread' },
        role: 'user',
        text: 'continue'
      })
    })

    await context.client.emitSnapshot({
      thread: { id: 'codex-thread', name: 'VS Code thread' },
      messages: [{
        turnId: 'turn',
        itemId: 'agent-item',
        role: 'assistant',
        text: 'completed reply',
        completedAt: 200
      }]
    })

    expect(context.events).toContainEqual({
      message: expect.objectContaining({
        thread: { id: 'codex-thread', name: 'VS Code thread' },
        role: 'agent',
        status: 'completed',
        text: 'completed reply'
      }),
      context: {
        source: 'feishu',
        sourceMessageId: 'om_user'
      }
    })
    await context.agent.stop()
  })
})

function fixture(): {
  agent: CodexAgent
  client: RecordingCodexClient
  web: WebThreadManager
  registry: ThreadRegistry
  events: Array<{ message: Message, context?: object }>
} {
  const registry = new ThreadRegistry(new CodexioMetadata({
    dataPath: join(tmpdir(), `codexio-agent-ingestion-${randomUUID()}`)
  }))
  const web = new WebThreadManager(registry)
  const events: Array<{ message: Message, context?: object }> = []
  const outputManager = {
    sendAgent: async (message: Message, context?: object) => {
      events.push({ message, context })
      web.appendMessage(message)
      return Result.successVoid()
    }
  } as unknown as ChannelOutputManager
  const client = new RecordingCodexClient()
  const agent = new CodexAgent(
    { get: async () => false } as never,
    outputManager,
    registry,
    client as unknown as CodexClient,
    new CodexMessageStreamer(outputManager)
  )
  return { agent, client, web, registry, events }
}

function completedMessage(index: number): CodexClientMessage {
  return {
    thread: { id: 'codex-thread', name: 'VS Code thread' },
    turnId: `turn-${index}`,
    status: 'turnCompleted',
    role: 'assistant',
    text: '',
    messages: [{
      itemId: `item-${index}`,
      role: 'assistant',
      text: `reply-${index}`
    }]
  }
}

class RecordingCodexClient {
  readonly sentThreadIds: Array<string | undefined> = []
  private readonly listeners = new Map<keyof CodexClientEventMap, Set<(...args: never[]) => unknown>>()

  on<K extends keyof CodexClientEventMap>(event: K, listener: CodexClientEventMap[K]): () => void {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(listener as (...args: never[]) => unknown)
    this.listeners.set(event, listeners)
    return () => listeners.delete(listener as (...args: never[]) => unknown)
  }

  async start(): Promise<Result<void>> {
    return Result.successVoid()
  }

  async stop(): Promise<Result<void>> {
    return Result.successVoid()
  }

  async login(): Promise<Result<boolean>> {
    return Result.success(true)
  }

  async send(input: { threadId?: string }): Promise<Result<{ threadId: string, turnId: string }>> {
    this.sentThreadIds.push(input.threadId)
    return Result.success({
      threadId: input.threadId ?? 'new-codex-thread',
      turnId: 'turn'
    })
  }

  emitMessage(message: CodexClientMessage): void {
    for (const listener of this.listeners.get('message') ?? []) {
      listener(message as never)
    }
  }

  async emitSnapshot(snapshot: CodexThreadSnapshot): Promise<void> {
    for (const listener of this.listeners.get('snapshot') ?? []) {
      await listener(snapshot as never)
    }
  }
}
