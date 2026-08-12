import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodexioMetadata } from '../src/component/CodexioMetadata.js'
import { Configer } from '../src/component/Configer.js'
import { ThreadRegistry } from '../src/component/ThreadRegistry.js'
import { AgentManager } from '../src/component/agent/AgentManager.js'
import { ChannelOutputManager } from '../src/component/channelo/ChannelOutputManager.js'
import { CommandExecutor } from '../src/controller/CommandExecutor.js'
import { ChannelInput } from '../src/controller/channeli/ChannelInput.js'
import { ChannelInputManager } from '../src/controller/channeli/ChannelInputManager.js'
import { Message } from '../src/value/Message.js'
import { Result } from '../src/value/Result.js'

describe('channel input errors', () => {
  it('reports an agent input failure once in the originating thread', async () => {
    const messages: Message[] = []
    const outputManager = {
      send: async (message: Message) => {
        messages.push(message)
        return Result.successVoid()
      }
    } as unknown as ChannelOutputManager
    const agentManager = {
      receive: async () => Result.fail('codex request failed')
    } as unknown as AgentManager
    const manager = new ChannelInputManager(
      {} as Configer,
      new ThreadRegistry(new CodexioMetadata({
        dataPath: join(tmpdir(), `codexio-channel-input-error-${randomUUID()}`)
      })),
      outputManager,
      agentManager,
      new CommandExecutor(outputManager),
      disabledInput('web'),
      disabledInput('feishu'),
      disabledInput('email'),
      disabledInput('nfirco')
    )
    const input = {
      channelThreadId: { source: 'feishu', id: 'chat:thread:failure' },
      sourceMessageId: 'failed-input',
      text: 'run'
    }

    const result = await manager.receive('feishu', input)
    const repeated = await manager.receive('feishu', input)

    expect(result.isFailed).toBe(false)
    expect(repeated.isFailed).toBe(false)
    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatchObject({
      role: 'agent',
      text: 'codex request failed',
      thread: messages[0].thread
    })
  })
})

function disabledInput(type: ChannelInput['type']): ChannelInput {
  return {
    type,
    start: async () => false,
    stop: async () => Result.successVoid()
  }
}
