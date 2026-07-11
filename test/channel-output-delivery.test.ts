import { describe, expect, it, vi } from 'vitest'
import { ChannelOutputManager } from '../src/component/channelo/ChannelOutputManager.js'
import { ChannelOutput } from '../src/component/channelo/ChannelOutput.js'
import { Result } from '../src/value/Result.js'
import { Message } from '../src/value/Message.js'

describe('channel output delivery', () => {
  it('acknowledges a message only after the selected output completes', async () => {
    let complete: ((result: Result<void>) => void) | undefined
    let markStarted: (() => void) | undefined
    const pending = new Promise<Result<void>>((resolve) => {
      complete = resolve
    })
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const web = output('web', () => {
      markStarted?.()
      return pending
    })
    const manager = managerWith(web)
    let settled = false
    const sending = manager.sendAgent(message()).then((result) => {
      settled = true
      return result
    })

    await started
    await Promise.resolve()
    expect(settled).toBe(false)
    complete?.(Result.successVoid())
    await expect(sending).resolves.toMatchObject({ isFailed: false })
  })

  it('returns output failures to the message producer', async () => {
    const manager = managerWith(output('web', async () => Result.fail('web unavailable')))

    await expect(manager.sendAgent(message())).resolves.toMatchObject({
      isFailed: true,
      message: 'web: web unavailable'
    })
  })

  it('delivers completed agent messages to every enabled output', async () => {
    const sent: string[] = []
    const manager = managerWith(
      output('web', async () => {
        sent.push('web')
        return Result.successVoid()
      }),
      output('feishu', async () => {
        sent.push('feishu')
        return Result.successVoid()
      })
    )

    await manager.sendAgent(message())

    expect(sent).toEqual(['web', 'feishu'])
  })

  it('keeps streaming revisions inside the Web projection', async () => {
    const sent: string[] = []
    const manager = managerWith(
      output('web', async () => {
        sent.push('web')
        return Result.successVoid()
      }),
      output('feishu', async () => {
        sent.push('feishu')
        return Result.successVoid()
      })
    )

    await manager.sendAgent({
      ...message(),
      status: 'streaming'
    } as Message)

    expect(sent).toEqual(['web'])
  })

  it('delivers one output revision only once and retries failures', async () => {
    let attempts = 0
    const web = output('web', async () => {
      attempts += 1
      return attempts === 1 ? Result.fail('temporary') : Result.successVoid()
    })
    const manager = managerWith(web)

    expect((await manager.sendAgent(message())).isFailed).toBe(true)
    expect((await manager.sendAgent(message())).isFailed).toBe(false)
    expect((await manager.sendAgent(message())).isFailed).toBe(false)

    expect(web.send).toHaveBeenCalledTimes(2)
  })

  it('delivers each successful revision once across an A to B to A sequence', async () => {
    const web = output('web')
    const manager = managerWith(web)
    const first = message()
    const second = {
      ...first,
      revision: 'revision-2',
      text: 'revised'
    }

    expect((await manager.sendAgent(first)).isFailed).toBe(false)
    expect((await manager.sendAgent(second)).isFailed).toBe(false)
    expect((await manager.sendAgent(first)).isFailed).toBe(false)

    expect(web.send).toHaveBeenCalledTimes(2)
    expect(vi.mocked(web.send).mock.calls.map(([sent]) => sent.text)).toEqual(['hello', 'revised'])
  })

  it('preserves source ordering metadata through output preparation', async () => {
    const web = output('web')
    const manager = managerWith(web)

    await manager.sendAgent({
      ...message(),
      sequence: 7
    })

    expect(vi.mocked(web.send).mock.calls[0][0].sequence).toBe(7)
  })

  it('preserves system message identity and source context', async () => {
    const feishu = output('feishu')
    const manager = managerWith(feishu)
    const systemMessage = {
      ...message(),
      role: 'system' as const
    }

    await manager.send(systemMessage, {
      source: 'feishu',
      sourceMessageId: 'om_1'
    })

    expect(vi.mocked(feishu.send).mock.calls[0]).toMatchObject([
      {
        id: systemMessage.id,
        role: 'system'
      },
      {
        source: 'feishu',
        sourceMessageId: 'om_1'
      }
    ])
  })
})

function managerWith(...outputs: ChannelOutput[]): ChannelOutputManager {
  const manager = new ChannelOutputManager(
    {} as never,
    {} as never,
    {} as never,
    output('web'),
    output('feishu'),
    output('feishuWebhook'),
    output('email'),
    output('nfirco'),
    {} as never
  )
  for (const channelOutput of outputs) {
    manager['outputs'].set(channelOutput.type, channelOutput)
  }
  return manager
}

function output(
  type: ChannelOutput['type'],
  send: ChannelOutput['send'] = async () => Result.successVoid()
): ChannelOutput {
  return {
    type,
    start: async () => true,
    send: vi.fn(send),
    stop: async () => Result.successVoid()
  }
}

function message(): Message {
  return {
    id: 'message-1',
    revision: 'revision-1',
    occurredAt: 1,
    status: 'completed',
    thread: {
      id: 'thread-1',
      name: 'Thread'
    },
    role: 'agent',
    text: 'hello'
  } as Message
}
