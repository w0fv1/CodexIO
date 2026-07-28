import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodexioMetadata } from '../src/component/CodexioMetadata.js'
import { ThreadRegistry } from '../src/component/ThreadRegistry.js'
import { CodexAgent } from '../src/component/agent/CodexAgent.js'
import { CodexClient, CodexClientMessage } from '../src/component/agent/codex/CodexClient.js'
import { CodexClientEventMap } from '../src/component/agent/codex/CodexProtocol.js'
import { CodexMessageAssembler } from '../src/component/agent/codex/CodexMessageAssembler.js'
import { WebThreadManager } from '../src/component/channel/WebThreadManager.js'
import { Result } from '../src/value/Result.js'
import { Message } from '../src/value/Message.js'
import { ChannelOutputManager } from '../src/component/channelo/ChannelOutputManager.js'

describe('Codex agent ingestion', () => {
  it('does not create a canonical thread mapping from a started notification', async () => {
    const context = fixture()
    await context.agent.start(context.receiver)

    context.client.emitMessage({
      thread: { id: 'codex-thread', name: 'Codexio thread' },
      turnId: 'turn',
      status: 'started',
      role: 'assistant',
      text: '',
      messages: []
    })
    await context.agent['mailbox'].drain()

    expect(context.agent['ioThreadIdByThreadId'].size).toBe(0)
    expect(context.agent['threadIdByIoThreadId'].size).toBe(0)
    await context.agent.stop()
  })

  it('serializes the production live listener without losing concurrent completions', async () => {
    const context = fixture()
    await context.agent.start(context.receiver)
    context.agent['bindThread']('codex-thread', 'codex-thread')

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

  it('publishes completed commentary as a channel progress message', async () => {
    const context = fixture()
    await context.agent.start(context.receiver)
    context.agent['bindThread']('codex-thread', 'codex-thread')

    context.client.emitMessage({
      thread: { id: 'codex-thread', name: 'Codexio thread' },
      turnId: 'turn',
      itemId: 'progress',
      status: 'progressCompleted',
      role: 'assistant',
      text: '图片正在生成中。',
      messages: []
    })
    await context.agent['mailbox'].drain()

    expect(context.events).toContainEqual(expect.objectContaining({
      role: 'agent',
      text: '图片正在生成中。'
    }))
    await context.agent.stop()
  })
})

function fixture(): {
  agent: CodexAgent
  client: RecordingCodexClient
  web: WebThreadManager
  events: Message[]
  receiver: {
    receiveAgentOutput: (message: Message) => Promise<Result<void>>
  }
} {
  const registry = new ThreadRegistry(new CodexioMetadata({
    dataPath: join(tmpdir(), `codexio-agent-ingestion-${randomUUID()}`)
  }))
  const web = new WebThreadManager(registry)
  const events: Message[] = []
  const outputManager = {
    send: async (message: Message) => {
      events.push(message)
      web.appendMessage(message)
      return Result.successVoid()
    }
  } as unknown as ChannelOutputManager
  const client = new RecordingCodexClient()
  const assembler = new CodexMessageAssembler()
  const agent = new CodexAgent(
    { get: async () => false } as never,
    registry,
    client as unknown as CodexClient,
    assembler
  )
  const receiver = {
    receiveAgentOutput: (message: Message) => outputManager.send(message)
  }
  Reflect.set(agent, 'outputReceiver', receiver)
  assembler.start(receiver)
  return { agent, client, web, events, receiver }
}

function completedMessage(index: number): CodexClientMessage {
  return {
    thread: { id: 'codex-thread', name: 'Codexio thread' },
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
}
