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
import { createMessage, Message } from '../src/value/Message.js'
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

    expect(context.registry.getIoThreadIdByAgentThread('codex', 'default', 'codex-thread')).toBeUndefined()
    await context.agent.stop()
  })

  it('serializes the production live listener without losing concurrent completions', async () => {
    const context = fixture()
    await context.agent.start(context.receiver)
    context.registry.ensure('codex-thread')
    context.registry.bindAgentThread('codex-thread', 'codex', 'default', 'codex-thread')

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
    context.registry.ensure('codex-thread')
    context.registry.bindAgentThread('codex-thread', 'codex', 'default', 'codex-thread')

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

  it('resumes the persisted Codex thread after the registry is reopened', async () => {
    const metadata = new CodexioMetadata({
      dataPath: join(tmpdir(), `codexio-agent-restart-${randomUUID()}`)
    })
    const first = fixture(metadata)
    await first.agent.receive(createMessage({
      id: 'first',
      thread: { id: 'io-thread', name: 'Persistent thread' },
      role: 'user',
      text: 'first'
    }))

    expect(first.client.sentThreadIds).toEqual([undefined])
    await first.agent.stop()
    await first.registry.close()

    const second = fixture(metadata)
    await second.agent.receive(createMessage({
      id: 'second',
      thread: { id: 'io-thread', name: 'Persistent thread' },
      role: 'user',
      text: 'second'
    }))

    expect(second.client.sentThreadIds).toEqual(['new-codex-thread'])
    await second.agent.stop()
    await second.registry.close()
  })
})

function fixture(metadata = new CodexioMetadata({
  dataPath: join(tmpdir(), `codexio-agent-ingestion-${randomUUID()}`)
})): {
  agent: CodexAgent
  client: RecordingCodexClient
  registry: ThreadRegistry
  web: WebThreadManager
  events: Message[]
  receiver: {
    receiveAgentOutput: (message: Message) => Promise<Result<void>>
  }
} {
  const registry = new ThreadRegistry(metadata)
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
  return { agent, client, registry, web, events, receiver }
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

  async identityScope(): Promise<string> {
    return 'default'
  }

  async send(input: {
    threadId?: string
    threadResolved?: (threadId: string) => void | Promise<void>
  }): Promise<Result<{ threadId: string, turnId: string }>> {
    this.sentThreadIds.push(input.threadId)
    const threadId = input.threadId ?? 'new-codex-thread'
    await input.threadResolved?.(threadId)
    return Result.success({
      threadId,
      turnId: 'turn'
    })
  }

  emitMessage(message: CodexClientMessage): void {
    for (const listener of this.listeners.get('message') ?? []) {
      listener(message as never)
    }
  }
}
