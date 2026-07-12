import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodexioMetadata } from '../src/component/CodexioMetadata.js'
import { FileStore } from '../src/component/FileStore.js'
import { MessageFileResolver } from '../src/component/MessageFileResolver.js'
import { Agent } from '../src/component/agent/Agent.js'
import { AgentManager } from '../src/component/agent/AgentManager.js'
import { ChannelOutputManager } from '../src/component/channelo/ChannelOutputManager.js'
import { Configer } from '../src/component/Configer.js'
import { ThreadWorkspaceResolver } from '../src/component/ThreadWorkspaceResolver.js'
import { createMessage, Message } from '../src/value/Message.js'
import { Result } from '../src/value/Result.js'

describe('message file resolver', () => {
  it('materializes every markdown attachment before delivery', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'codexio-file-resolver-'))
    const workspacePath = join(rootPath, 'workspace')
    await writeFile(join(rootPath, 'report.txt'), 'report')
    const metadata = new CodexioMetadata({
      rootPath,
      configPath: join(rootPath, 'config.yaml')
    })
    const resolver = new MessageFileResolver(new FileStore(metadata))
    const resolved = await resolver.resolve(createMessage({
      id: 'agent-output',
      thread: { id: 'thread', name: '文件' },
      role: 'agent',
      text: '[报告](../report.txt "下载")'
    }), workspacePath)

    expect(resolved.text).toBe('`../report.txt`')
    expect(resolved.files).toHaveLength(1)
    expect(resolved.files?.[0].name).toBe('report.txt')
    expect(await readFile(resolved.files?.[0].path ?? '', 'utf8')).toBe('report')
  })

  it('stores files larger than the previous global limit', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'codexio-large-file-'))
    const metadata = new CodexioMetadata({
      rootPath,
      configPath: join(rootPath, 'config.yaml')
    })
    const fileStore = new FileStore(metadata)
    const buffer = Buffer.alloc(21 * 1024 * 1024, 1)
    const file = await fileStore.importBuffer({
      buffer,
      name: 'large.bin'
    })

    expect(file.size).toBe(buffer.length)
  })

  it('materializes Agent output in AgentManager before channel delivery', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'codexio-agent-output-file-'))
    await writeFile(join(rootPath, 'result.txt'), 'result')
    const metadata = new CodexioMetadata({
      rootPath,
      configPath: join(rootPath, 'config.yaml')
    })
    const delivered: Message[] = []
    const outputManager = {
      send: async (message: Message) => {
        delivered.push(message)
        return Result.successVoid()
      }
    } as unknown as ChannelOutputManager
    const agent: Agent = {
      type: 'test',
      start: async () => Result.successVoid(),
      receive: async () => Result.successVoid(),
      stop: async () => Result.successVoid()
    }
    const manager = new AgentManager(
      {} as Configer,
      agent,
      agent,
      { resolve: async () => rootPath } as ThreadWorkspaceResolver,
      new MessageFileResolver(new FileStore(metadata)),
      outputManager
    )

    const result = await manager.receiveAgentOutput(createMessage({
      id: 'agent-file-output',
      thread: { id: 'thread', name: '文件' },
      role: 'agent',
      text: '[结果](./result.txt)'
    }))

    expect(result.isFailed).toBe(false)
    expect(delivered[0].files?.[0].name).toBe('result.txt')
    expect(delivered[0]).not.toHaveProperty('revision')
  })
})
