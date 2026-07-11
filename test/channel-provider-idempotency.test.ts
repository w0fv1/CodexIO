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
  it('uses the message revision in Feishu UUIDs', async () => {
    const calls: Array<{ data: { uuid: string } }> = []
    const output = new FeishuChannelOutput({} as never, threadRegistry())
    Reflect.set(output, 'chatId', 'chat')
    Reflect.set(output, 'client', {
      im: {
        v1: {
          message: {
            reply: async (payload: { data: { uuid: string } }) => {
              calls.push(payload)
              return { data: { message_id: randomUUID(), thread_id: 'thread' } }
            }
          }
        }
      }
    })
    const [first, second] = revisions()

    await output.send(first, { sourceMessageId: 'source' })
    await output.send(second, { sourceMessageId: 'source' })

    expect(calls.map((call) => call.data.uuid)).toEqual([
      deriveExternalDeliveryId('feishu', first, '0'),
      deriveExternalDeliveryId('feishu', second, '0')
    ])
    expect(calls[0].data.uuid).not.toBe(calls[1].data.uuid)
  })

  it('uses the message revision in SMTP Message-IDs', async () => {
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
    const [first, second] = revisions()

    await output.send(first)
    await output.send(second)

    expect(mail.map((item) => item.messageId)).toEqual([
      `<${deriveExternalDeliveryId('email', first)}@codexio.local>`,
      `<${deriveExternalDeliveryId('email', second)}@codexio.local>`
    ])
  })

  it('uses the message revision in webhook idempotency keys', async () => {
    const keys: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get('Idempotency-Key') ?? '')
      return { ok: true }
    }))
    const output = new FeishuWebhookChannelOutput({} as never)
    Reflect.set(output, 'config', {
      url: 'https://example.com/webhook'
    })
    const [first, second] = revisions()

    await output.send(first)
    await output.send(second)

    expect(keys).toEqual([
      deriveExternalDeliveryId('feishuWebhook', first),
      deriveExternalDeliveryId('feishuWebhook', second)
    ])
  })
})

function revisions() {
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
