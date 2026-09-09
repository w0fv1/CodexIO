import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CodexioMetadata } from '../src/component/CodexioMetadata.js'
import { ThreadRegistry } from '../src/component/ThreadRegistry.js'
import { WebThreadManager } from '../src/component/channel/WebThreadManager.js'
import { FeishuChannelOutput } from '../src/component/channelo/FeishuChannelOutput.js'
import { createMessage } from '../src/value/Message.js'

describe('thread identity persistence', () => {
  it.each(['web', 'email', 'feishu', 'userver'] as const)('uses the first message prefix for %s and keeps it after restart', async source => {
    const metadata = await createMetadata()
    const before = new ThreadRegistry(metadata)
    const key = { source, id: source === 'feishu' ? 'chat:thread:first-message-thread' : 'first-message-thread' }
    const placeholder = before.resolve(key)
    expect(placeholder.name).toBe('新对话')
    expect(before.resolve(key, '一二三四五六七八九十甲乙丙丁').name).toBe('一二三四五六七八九十甲乙')
    expect(before.resolve(key, '后来的消息').name).toBe('一二三四五六七八九十甲乙')
    await before.close()
    const after = new ThreadRegistry(metadata)
    expect(after.resolve(key, '重启后的消息').name).toBe('一二三四五六七八九十甲乙')
    await after.close()
  })

  it.each(['', '新对话', '😀一二三四五六七八九十甲乙'])('initializes a title exactly once even for %j', async text => {
    const registry = new ThreadRegistry(await createMetadata())
    const key = { source: 'web' as const, id: 'edge-case' }
    const first = registry.resolve(key, text)
    expect(first.name).toBe(text ? Array.from(text).slice(0, 12).join('') : '新对话')
    expect(registry.resolve(key, 'another message').name).toBe(first.name)
    await registry.close()
  })

  it('creates authoritative web identities on the server', async () => {
    const registry = new ThreadRegistry(await createMetadata())
    await registry.init()

    const created = registry.createWebThread()

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(registry.resolve({ source: 'web', id: created.id }).id).toBe(created.thread.id)
    await registry.close()
  })

  it('restores web, Feishu, and Codex identities from one durable registry', async () => {
    const metadata = await createMetadata()
    const before = new ThreadRegistry(metadata)
    await before.init()
    const thread = before.resolve({
      source: 'web',
      id: 'web-thread'
    }, 'Persistent thread')
    before.bind(thread.id, {
      source: 'feishu',
      id: 'chat-1:thread:topic-1'
    })
    before.bindAgentThread(thread.id, 'codex', 'default', 'codex-thread')
    await before.close()

    const after = new ThreadRegistry(metadata)
    await after.init()

    expect(after.resolve({ source: 'web', id: 'web-thread' }).id).toBe(thread.id)
    expect(after.resolve({ source: 'feishu', id: 'chat-1:thread:topic-1' }).id).toBe(thread.id)
    expect(after.getAgentThreadId(thread.id, 'codex', 'default')).toBe('codex-thread')
    expect(after.listWebThreads()).toMatchObject([{
      id: 'web-thread',
      thread: {
        id: thread.id,
        name: 'Persistent t'
      }
    }])
    await after.close()
  })

  it('projects a Feishu conversation through a durable web identity without forking', async () => {
    const registry = new ThreadRegistry(await createMetadata())
    await registry.init()
    const thread = registry.resolve({
      source: 'feishu',
      id: 'chat-1:thread:topic-1'
    })
    const web = new WebThreadManager(registry)

    const projected = web.appendMessage(createMessage({
      id: 'message',
      thread,
      role: 'agent',
      text: 'reply'
    }))

    expect(projected.webThreadId).not.toBe(`io:${thread.id}`)
    expect(registry.resolve({ source: 'web', id: projected.webThreadId }).id).toBe(thread.id)
    await registry.close()
  })

  it('restores web thread metadata without restoring transient messages', async () => {
    const metadata = await createMetadata()
    const before = new ThreadRegistry(metadata)
    await before.init()
    const thread = before.resolve({ source: 'web', id: 'web-thread' }, 'Saved title')
    const beforeWeb = new WebThreadManager(before)
    beforeWeb.appendMessage(createMessage({
      id: 'message',
      thread,
      role: 'agent',
      text: 'not persisted'
    }))
    await before.close()

    const after = new ThreadRegistry(metadata)
    await after.init()
    const afterWeb = new WebThreadManager(after)

    expect(afterWeb.snapshot()).toMatchObject({
      threads: [{
        id: 'web-thread',
        thread: {
          id: thread.id,
          name: 'Saved title'
        }
      }],
      messages: []
    })
    await after.close()
  })

  it('retires old Feishu bindings when the configured chat changes', async () => {
    const registry = new ThreadRegistry(await createMetadata())
    await registry.init()
    const oldThread = registry.resolve({
      source: 'feishu',
      id: 'old-chat:thread:old-topic'
    })

    registry.reconcileFeishuChat('new-chat')

    expect(registry.getFeishuRoute(oldThread.id, 'new-chat')).toEqual({ state: 'retired' })
    const newThread = registry.resolve({
      source: 'feishu',
      id: 'new-chat:thread:new-topic'
    })
    expect(newThread.id).not.toBe(oldThread.id)
    expect(registry.getFeishuRoute(newThread.id, 'new-chat')).toEqual({
      state: 'active',
      threadId: 'new-topic'
    })
    await registry.close()
  })

  it('does not deliver an old conversation into the newly bound Feishu chat', async () => {
    const registry = new ThreadRegistry(await createMetadata())
    await registry.init()
    const oldThread = registry.resolve({
      source: 'feishu',
      id: 'old-chat:thread:old-topic'
    })
    registry.reconcileFeishuChat('new-chat')
    const create = vi.fn()
    const list = vi.fn()
    const reply = vi.fn()
    const output = new FeishuChannelOutput({} as never, registry)
    Reflect.set(output, 'chatId', 'new-chat')
    Reflect.set(output, 'client', {
      im: {
        v1: {
          message: { create, list, reply }
        }
      }
    })

    const result = await output.send(createMessage({
      id: 'old-agent-message',
      thread: oldThread,
      role: 'agent',
      text: 'must stay retired'
    }))

    expect(result.isFailed).toBe(false)
    expect(create).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
    expect(reply).not.toHaveBeenCalled()
    await registry.close()
  })

  it('rejects assigning one Codex thread to two IO threads', async () => {
    const registry = new ThreadRegistry(await createMetadata())
    await registry.init()
    const first = registry.resolve({ source: 'web', id: 'web-1' })
    const second = registry.resolve({ source: 'web', id: 'web-2' })
    registry.bindAgentThread(first.id, 'codex', 'default', 'codex-thread')

    expect(() => registry.bindAgentThread(second.id, 'codex', 'default', 'codex-thread')).toThrow('agent thread already bound')
    await registry.close()
  })
})

async function createMetadata(): Promise<CodexioMetadata> {
  return new CodexioMetadata({
    dataPath: await mkdtemp(join(tmpdir(), 'codexio-thread-identity-'))
  })
}
