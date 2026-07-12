import { describe, expect, it } from 'vitest'
import { CodexMessageAssembler } from '../src/component/agent/codex/CodexMessageAssembler.js'
import { ChannelOutputManager } from '../src/component/channelo/ChannelOutputManager.js'
import { Message } from '../src/value/Message.js'
import { Result } from '../src/value/Result.js'

describe('Codex message assembly', () => {
  it('keeps deltas private and publishes one completed message', async () => {
    const sent = recordingMessages()
    const assembler = createAssembler(sent.outputManager)
    const thread = {
      thread: { id: 'io-thread', name: 'Thread' },
      agentThreadId: 'codex-thread',
      turnId: 'turn'
    }

    assembler.append(thread, 'item', '第一段。')
    assembler.append(thread, 'item', '\n\n第二段。')
    expect(sent.messages).toHaveLength(0)

    await assembler.completeItem(thread, 'item')

    expect(sent.messages).toHaveLength(1)
    expect(sent.messages[0]).toMatchObject({
      text: '第一段。\n\n第二段。',
      role: 'agent'
    })
    expect(Object.keys(sent.messages[0])).not.toContain('status')
    expect(Object.keys(sent.messages[0])).not.toContain('revision')
    expect(Object.keys(sent.messages[0])).not.toContain('sequence')
  })

  it('publishes authoritative turn items as immutable messages', async () => {
    const sent = recordingMessages()
    const assembler = createAssembler(sent.outputManager)
    const thread = {
      thread: { id: 'io-thread', name: 'Thread' },
      agentThreadId: 'codex-thread',
      turnId: 'turn'
    }

    await assembler.complete(thread, [
      { itemId: 'second', text: 'second' },
      { itemId: 'first', text: 'first' }
    ])

    expect(sent.messages.map((message) => message.text)).toEqual(['second', 'first'])
    expect(new Set(sent.messages.map((message) => message.id)).size).toBe(2)
  })

  it('uses staged content when turn completion has no items', async () => {
    const sent = recordingMessages()
    const assembler = createAssembler(sent.outputManager)
    const thread = {
      thread: { id: 'io-thread', name: 'Thread' },
      agentThreadId: 'codex-thread',
      turnId: 'turn'
    }

    assembler.append(thread, 'item', 'reply')
    await assembler.complete(thread, [])

    expect(sent.messages.map((message) => message.text)).toEqual(['reply'])
  })

  it('keeps a failed completion retryable', async () => {
    let attempts = 0
    const outputManager = {
      send: async () => {
        attempts += 1
        return attempts === 1 ? Result.fail('temporarily unavailable') : Result.successVoid()
      }
    } as unknown as ChannelOutputManager
    const assembler = createAssembler(outputManager)
    const thread = {
      thread: { id: 'io-thread', name: 'Thread' },
      agentThreadId: 'codex-thread',
      turnId: 'turn'
    }

    assembler.append(thread, 'item', 'reply')
    await expect(assembler.completeItem(thread, 'item')).rejects.toThrow('temporarily unavailable')
    await expect(assembler.completeItem(thread, 'item')).resolves.toBeUndefined()
    expect(attempts).toBe(2)
  })
})

function recordingMessages(): { outputManager: ChannelOutputManager, messages: Message[] } {
  const messages: Message[] = []
  const outputManager = {
    send: async (message: Message) => {
      messages.push(message)
      return Result.successVoid()
    }
  } as unknown as ChannelOutputManager
  return { outputManager, messages }
}

function createAssembler(outputManager: ChannelOutputManager): CodexMessageAssembler {
  const assembler = new CodexMessageAssembler()
  assembler.start({
    receiveAgentOutput: (message) => outputManager.send(message)
  })
  return assembler
}
