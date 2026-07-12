import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodexioMetadata } from '../src/component/CodexioMetadata.js'
import { ThreadRegistry } from '../src/component/ThreadRegistry.js'
import { WebThreadManager, WebThreadMessage } from '../src/component/channel/WebThreadManager.js'
import { createMessage } from '../src/value/Message.js'

describe('web message projection', () => {
  it('constructs immutable messages without delivery state', () => {
    const message = createMessage({
      id: 'message',
      occurredAt: 100,
      thread: { id: 'thread', name: 'Thread' },
      role: 'agent',
      text: 'answer'
    })

    expect(message).toEqual({
      id: 'message',
      occurredAt: 100,
      thread: { id: 'thread', name: 'Thread' },
      role: 'agent',
      text: 'answer',
      files: undefined
    })
  })

  it('appends each identity once without replacing existing content', () => {
    const manager = createManager()
    const projected: WebThreadMessage[] = []
    manager.on('message', (message) => projected.push(message))
    const original = createMessage({
      id: 'message',
      occurredAt: 200,
      thread: { id: 'thread', name: 'Thread' },
      role: 'agent',
      text: '**original**'
    })

    manager.appendMessage(original)
    manager.appendMessage(original)
    manager.appendMessage(createMessage({
      ...original,
      text: '**replacement**'
    }))

    expect(manager.snapshot().messages).toHaveLength(1)
    expect(manager.snapshot().messages[0]?.text).toBe('**original**')
    expect(projected).toHaveLength(1)
  })

  it('orders snapshots by occurrence time and immutable identity', () => {
    const manager = createManager()
    manager.appendMessage(createMessage({
      id: 'b',
      occurredAt: 100,
      thread: { id: 'thread', name: 'Thread' },
      role: 'agent',
      text: 'b'
    }))
    manager.appendMessage(createMessage({
      id: 'a',
      occurredAt: 100,
      thread: { id: 'thread', name: 'Thread' },
      role: 'agent',
      text: 'a'
    }))

    expect(manager.snapshot().messages.map((message) => message.id)).toEqual(['a', 'b'])
  })
})

function createManager(): WebThreadManager {
  return new WebThreadManager(new ThreadRegistry(new CodexioMetadata({
    dataPath: join(tmpdir(), `codexio-web-projection-${randomUUID()}`)
  })))
}
