import { describe, expect, it } from 'vitest'
import { MessageInbox } from '../src/component/MessageInbox.js'
import { Result } from '../src/value/Result.js'

describe('MessageInbox', () => {
  it('shares one successful result for a repeated identity', async () => {
    const inbox = new MessageInbox<string>()
    let executions = 0
    const execute = () => inbox.run('message', async () => {
      executions += 1
      return Result.success('processed')
    })

    const [first, second] = await Promise.all([execute(), execute()])

    expect(first.data).toBe('processed')
    expect(second.data).toBe('processed')
    expect(executions).toBe(1)
  })

  it('allows a failed message to be retried', async () => {
    const inbox = new MessageInbox<string>()
    let executions = 0
    const execute = () => inbox.run('message', async () => {
      executions += 1
      return executions === 1 ? Result.fail<string>('failed') : Result.success('retried')
    })

    expect((await execute()).isFailed).toBe(true)
    expect((await execute()).data).toBe('retried')
    expect(executions).toBe(2)
  })

  it('turns a synchronous task exception into a retryable rejection', async () => {
    const inbox = new MessageInbox<string>()

    await expect(inbox.run('message', () => {
      throw new Error('failed')
    })).rejects.toThrow('failed')
    await expect(inbox.run('message', async () => Result.success('retried'))).resolves.toMatchObject({
      data: 'retried'
    })
  })

  it('processes different immutable message identities', async () => {
    const inbox = new MessageInbox<string>()
    const messages: string[] = []

    await inbox.run('first', async () => {
      messages.push('first')
      return Result.success('first')
    })
    await inbox.run('second', async () => {
      messages.push('second')
      return Result.success('second')
    })

    expect(messages).toEqual(['first', 'second'])
  })

  it('reuses every successful message across an A to B to A delivery sequence', async () => {
    const inbox = new MessageInbox<string>()
    const messages: string[] = []
    const execute = (id: string) => inbox.run(id, async () => {
      messages.push(id)
      return Result.success(id)
    })

    expect((await execute('A')).data).toBe('A')
    expect((await execute('B')).data).toBe('B')
    expect((await execute('A')).data).toBe('A')

    expect(messages).toEqual(['A', 'B'])
  })
})
