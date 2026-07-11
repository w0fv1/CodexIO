import { describe, expect, it } from 'vitest'
import { MessageInbox } from '../src/component/MessageInbox.js'
import { Result } from '../src/value/Result.js'

describe('MessageInbox', () => {
  it('shares one successful result for a repeated identity and revision', async () => {
    const inbox = new MessageInbox<string>()
    let executions = 0
    const execute = () => inbox.run('message', 'revision', async () => {
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
    const execute = () => inbox.run('message', 'revision', async () => {
      executions += 1
      return executions === 1 ? Result.fail<string>('failed') : Result.success('retried')
    })

    expect((await execute()).isFailed).toBe(true)
    expect((await execute()).data).toBe('retried')
    expect(executions).toBe(2)
  })

  it('processes a new revision after the prior revision', async () => {
    const inbox = new MessageInbox<string>()
    const revisions: string[] = []

    await inbox.run('message', 'first', async () => {
      revisions.push('first')
      return Result.success('first')
    })
    await inbox.run('message', 'second', async () => {
      revisions.push('second')
      return Result.success('second')
    })

    expect(revisions).toEqual(['first', 'second'])
  })

  it('reuses every successful revision across an A to B to A delivery sequence', async () => {
    const inbox = new MessageInbox<string>()
    const revisions: string[] = []
    const execute = (revision: string) => inbox.run('message', revision, async () => {
      revisions.push(revision)
      return Result.success(revision)
    })

    expect((await execute('A')).data).toBe('A')
    expect((await execute('B')).data).toBe('B')
    expect((await execute('A')).data).toBe('A')

    expect(revisions).toEqual(['A', 'B'])
  })
})
