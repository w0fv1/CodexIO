import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexioMetadata } from '../src/component/CodexioMetadata.js'
import { ThreadRegistry } from '../src/component/ThreadRegistry.js'
import { EmailChannelOutput } from '../src/component/channelo/EmailChannelOutput.js'
import { deriveExternalDeliveryId } from '../src/component/channelo/ExternalDeliveryIdentity.js'
import { FeishuChannelOutput } from '../src/component/channelo/FeishuChannelOutput.js'
import { FeishuWebhookChannelOutput } from '../src/component/channelo/FeishuWebhookChannelOutput.js'
import { createMessage } from '../src/value/Message.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('channel provider idempotency', () => {
  it('uses the immutable message identity in Feishu UUIDs', async () => {
    const calls: Array<{ data: { uuid: string } }> = []
    const output = new FeishuChannelOutput({} as never, threadRegistry())
    Reflect.set(output, 'chatId', 'chat')
    Reflect.set(output, 'client', {
      im: {
        v1: {
          message: {
            list: async () => ({
              data: {
                items: [{
                  message_id: 'created',
                  thread_id: 'thread'
                }]
              }
            }),
            create: async (payload: { data: { uuid: string } }) => {
              calls.push(payload)
              return { data: { message_id: 'created', thread_id: 'thread' } }
            },
            reply: async (payload: { data: { uuid: string } }) => {
              calls.push(payload)
              return { data: { message_id: randomUUID(), thread_id: 'thread' } }
            }
          }
        }
      }
    })
    const [first, second] = immutableMessages()

    await output.send(first, { source: 'feishu', sourceMessageId: 'source' })
    await output.send(second, { source: 'feishu', sourceMessageId: 'source' })

    expect(calls.map((call) => call.data.uuid)).toEqual([
      deriveExternalDeliveryId('feishu', first, '0'),
      deriveExternalDeliveryId('feishu', second, '0')
    ])
    expect(calls[0].data.uuid).toBe(calls[1].data.uuid)
  })

  it('never uses another channel message identity as a Feishu reply identity', async () => {
    const create = vi.fn(async () => ({
      data: {
        message_id: 'om_created',
        thread_id: 'omt_created'
      }
    }))
    const reply = vi.fn()
    const output = new FeishuChannelOutput({} as never, threadRegistry())
    Reflect.set(output, 'chatId', 'chat')
    Reflect.set(output, 'client', {
      im: {
        v1: {
          message: { create, reply }
        }
      }
    })

    const result = await output.send(immutableMessages()[0], {
      source: 'web',
      sourceMessageId: 'browser-message-id'
    })

    expect(result.isFailed).toBe(false)
    expect(create).toHaveBeenCalledOnce()
    expect(reply).not.toHaveBeenCalled()
  })

  it('recovers a Feishu reply anchor from the bound thread after restart', async () => {
    const registry = threadRegistry()
    registry.ensure('codex-thread')
    registry.bind('codex-thread', {
      source: 'feishu',
      id: 'chat:thread:omt_existing'
    })
    const list = vi.fn(async () => ({
      data: {
        items: [{
          message_id: 'om_existing',
          thread_id: 'omt_existing'
        }]
      }
    }))
    const reply = vi.fn(async () => ({
      data: {
        message_id: 'om_reply',
        thread_id: 'omt_existing'
      }
    }))
    const create = vi.fn()
    const output = new FeishuChannelOutput({} as never, registry)
    Reflect.set(output, 'chatId', 'chat')
    Reflect.set(output, 'client', {
      im: {
        v1: {
          message: { list, reply, create }
        }
      }
    })

    const result = await output.send(createMessage({
      id: 'agent-message',
      thread: { id: 'codex-thread', name: 'Thread' },
      role: 'agent',
      text: 'reply'
    }))

    expect(result.isFailed).toBe(false)
    expect(list).toHaveBeenCalledWith({
      params: {
        container_id_type: 'thread',
        container_id: 'omt_existing',
        sort_type: 'ByCreateTimeAsc',
        page_size: 1
      }
    })
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      path: {
        message_id: 'om_existing'
      }
    }))
    expect(create).not.toHaveBeenCalled()
  })

  it('never creates a replacement Feishu thread when a bound thread has no reply anchor', async () => {
    const registry = threadRegistry()
    registry.ensure('codex-thread')
    registry.bind('codex-thread', {
      source: 'feishu',
      id: 'chat:thread:omt_existing'
    })
    const list = vi.fn(async () => ({ data: { items: [] } }))
    const reply = vi.fn()
    const create = vi.fn()
    const output = new FeishuChannelOutput({} as never, registry)
    Reflect.set(output, 'chatId', 'chat')
    Reflect.set(output, 'client', {
      im: {
        v1: {
          message: { list, reply, create }
        }
      }
    })

    const result = await output.send(createMessage({
      id: 'agent-message',
      thread: { id: 'codex-thread', name: 'Thread' },
      role: 'agent',
      text: 'reply'
    }))

    expect(result.isFailed).toBe(true)
    expect(result.message).toContain('feishu thread reply message not found')
    expect(reply).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it.each([
    ['image/png', 10 * 1024 * 1024 + 1, 'image'],
    ['application/octet-stream', 30 * 1024 * 1024 + 1, 'file']
  ])('skips oversized Feishu %s attachments and still sends the text', async (mime, size, uploadType) => {
    const registry = threadRegistry()
    registry.ensure('codex-thread')
    registry.bind('codex-thread', {
      source: 'feishu',
      id: 'chat:thread:omt_existing'
    })
    const imageCreate = vi.fn()
    const fileCreate = vi.fn()
    const reply = vi.fn(async () => ({
      data: {
        message_id: 'om_reply',
        thread_id: 'omt_existing'
      }
    }))
    const output = new FeishuChannelOutput({} as never, registry)
    Reflect.set(output, 'chatId', 'chat')
    Reflect.set(output, 'client', {
      im: {
        v1: {
          image: { create: imageCreate },
          file: { create: fileCreate },
          message: {
            list: async () => ({
              data: {
                items: [{ message_id: 'om_existing', thread_id: 'omt_existing' }]
              }
            }),
            reply
          }
        }
      }
    })

    const result = await output.send(createMessage({
      id: `oversized-${uploadType}`,
      thread: { id: 'codex-thread', name: 'Thread' },
      role: 'agent',
      text: 'answer',
      files: [{
        id: 'file-id',
        mime,
        name: 'oversized.bin',
        size,
        sha256: 'hash',
        path: 'missing-file'
      }]
    }))

    expect(result.isFailed).toBe(false)
    expect(imageCreate).not.toHaveBeenCalled()
    expect(fileCreate).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledOnce()
    expect(Reflect.get(reply.mock.calls[0][0].data, 'content')).toContain('附件未发送')
  })

  it('uses the immutable message identity in SMTP Message-IDs', async () => {
    const mail: Array<{ messageId: string }> = []
    const output = new EmailChannelOutput({} as never)
    Reflect.set(output, 'config', {
      user: 'recipient@example.com',
      account: {
        smtp: {
          user: 'sender@example.com'
        }
      }
    })
    Reflect.set(output, 'smtp', {
      sendMail: async (payload: { messageId: string }) => {
        mail.push(payload)
      }
    })
    const [first, second] = immutableMessages()

    await output.send(first)
    await output.send(second)

    expect(mail.map((item) => item.messageId)).toEqual([
      `<${deriveExternalDeliveryId('email', first)}@codexio.local>`,
      `<${deriveExternalDeliveryId('email', second)}@codexio.local>`
    ])
  })

  it('uses the immutable message identity in webhook idempotency keys', async () => {
    const keys: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get('Idempotency-Key') ?? '')
      return { ok: true }
    }))
    const output = new FeishuWebhookChannelOutput({} as never)
    Reflect.set(output, 'config', {
      url: 'https://example.com/webhook'
    })
    const [first, second] = immutableMessages()

    await output.send(first)
    await output.send(second)

    expect(keys).toEqual([
      deriveExternalDeliveryId('feishuWebhook', first),
      deriveExternalDeliveryId('feishuWebhook', second)
    ])
  })
})

function immutableMessages() {
  const thread = { id: 'io-thread', name: 'Thread' }
  return [
    createMessage({
      id: 'stable-message',
      thread,
      role: 'agent',
      text: 'first'
    }),
    createMessage({
      id: 'stable-message',
      thread,
      role: 'agent',
      text: 'second'
    })
  ] as const
}

function threadRegistry(): ThreadRegistry {
  return new ThreadRegistry(new CodexioMetadata({
    dataPath: join(tmpdir(), `codexio-provider-identity-${randomUUID()}`)
  }))
}
