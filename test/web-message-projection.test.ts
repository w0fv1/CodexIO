import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodexioMetadata } from '../src/component/CodexioMetadata.js'
import { ThreadRegistry } from '../src/component/ThreadRegistry.js'
import { WebThreadManager, WebThreadMessage } from '../src/component/channel/WebThreadManager.js'
import { createMessage, deriveMessageRevision } from '../src/value/Message.js'
import type { Message, MessageContent } from '../src/value/Message.js'

function revision(content: MessageContent): string {
  return deriveMessageRevision(content)
}

describe('web message projection', () => {
  it('constructs canonical messages from one content source', () => {
    const message = createMessage({
      id: 'message',
      occurredAt: 100,
      thread: { id: 'thread', name: 'Thread' },
      role: 'agent',
      text: 'answer'
    })

    expect(message).toMatchObject({
      id: 'message',
      occurredAt: 100,
      status: 'completed'
    })
    expect(message.revision).toBe(deriveMessageRevision(message))
  })

  it('derives revisions only from visible message content', () => {
    const content: MessageContent = {
      status: 'completed',
      role: 'agent',
      text: 'answer'
    }
    expect(revision(content)).toBe(revision({
      ...content,
      files: []
    }))
    expect(revision(content)).not.toBe(revision({
      ...content,
      status: 'streaming'
    }))
    expect(revision(content)).not.toBe(revision({
      ...content,
      text: 'revised answer'
    }))
    const file = {
      id: 'first-id',
      mime: 'text/plain',
      name: 'answer.txt',
      size: 6,
      sha256: 'content-hash',
      path: 'first-path',
      url: '/api/files/first-id'
    }
    expect(revision({
      ...content,
      files: [file]
    })).toBe(revision({
      ...content,
      files: [{
        ...file,
        id: 'second-id',
        path: 'second-path',
        url: '/api/files/second-id'
      }]
    }))
  })

  it('projects message revisions idempotently in source occurrence order', () => {
    const manager = new WebThreadManager(new ThreadRegistry(new CodexioMetadata({
      dataPath: join(tmpdir(), `codexio-web-projection-${randomUUID()}`)
    })))
    const projected: WebThreadMessage[] = []
    manager.on('message', (message) => projected.push(message))
    const lateContent: MessageContent = {
      status: 'streaming',
      role: 'agent',
      text: 'draft'
    }
    const late: Message = {
      id: 'late',
      revision: revision(lateContent),
      occurredAt: 200,
      thread: { id: 'thread', name: 'Thread' },
      ...lateContent
    }
    const earlyContent: MessageContent = {
      status: 'completed',
      role: 'agent',
      text: 'first'
    }
    const early: Message = {
      id: 'early',
      revision: revision(earlyContent),
      occurredAt: 100,
      thread: { id: 'thread', name: 'Thread' },
      ...earlyContent
    }
    manager.appendMessage(late)
    manager.appendMessage(late)
    manager.appendMessage(early)
    const finalContent: MessageContent = {
      status: 'completed',
      role: 'agent',
      text: '**final**',
      files: [{
        id: 'file',
        mime: 'text/plain',
        name: 'answer.txt',
        size: 5,
        sha256: 'hash',
        path: 'answer.txt'
      }]
    }
    manager.appendMessage({
      ...late,
      ...finalContent,
      revision: revision(finalContent)
    })
    const correctedContent: MessageContent = {
      ...finalContent,
      text: '**corrected**'
    }
    manager.appendMessage({
      ...late,
      ...correctedContent,
      revision: revision(correctedContent)
    })
    const staleContent: MessageContent = {
      status: 'streaming',
      role: 'agent',
      text: 'stale'
    }
    manager.appendMessage({
      ...late,
      ...staleContent,
      revision: revision(staleContent)
    })

    const snapshot = manager.snapshot()
    expect(snapshot.messages.map((message) => message.id)).toEqual(['early', 'late'])
    expect(snapshot.messages[1]).toMatchObject({
      revision: revision(correctedContent),
      occurredAt: 200,
      status: 'completed',
      text: '**corrected**',
      files: [{ id: 'file' }]
    })
    expect(snapshot.messages[1]?.html).toContain('<strong>corrected</strong>')
    expect(snapshot.threads[0]?.updatedAt).toBe(200)
    expect(projected.map((message) => `${message.id}:${message.status}:${message.text}`)).toEqual([
      'late:streaming:draft',
      'early:completed:first',
      'late:completed:**final**',
      'late:completed:**corrected**'
    ])
  })

  it('uses source sequence before message identity for equal timestamps', () => {
    const manager = new WebThreadManager(new ThreadRegistry(new CodexioMetadata({
      dataPath: join(tmpdir(), `codexio-web-projection-${randomUUID()}`)
    })))
    for (const [sequence, id] of ['b', 'a'].entries()) {
      const content: MessageContent = {
        status: 'completed',
        role: 'agent',
        text: id
      }
      manager.appendMessage({
        id,
        revision: revision(content),
        occurredAt: 100,
        sequence,
        thread: { id: 'thread', name: 'Thread' },
        ...content
      })
    }
    expect(manager.snapshot().messages.map((message) => message.id)).toEqual(['b', 'a'])
  })
})
