import { mkdir, mkdtemp, readFile, readdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps ordinary HTTPS links as links without downloading them', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'codexio-http-link-'))
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const resolver = new MessageFileResolver(new FileStore(new CodexioMetadata({ rootPath })))
    const text = '[Codexio](https://next.firco.cn/download/release/codexio/latest?platform=electron)'

    const resolved = await resolver.resolve(createMessage({
      id: 'agent-link',
      thread: { id: 'thread', name: '链接' },
      role: 'agent',
      text
    }), rootPath)

    expect(resolved.text).toBe(text)
    expect(resolved.files).toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('downloads an explicitly embedded remote image', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'codexio-http-image-'))
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(png, {
      headers: {
        'content-length': String(png.length),
        'content-type': 'image/png'
      }
    })))
    const resolver = new MessageFileResolver(new FileStore(new CodexioMetadata({ rootPath })))

    const resolved = await resolver.resolve(createMessage({
      id: 'agent-image',
      thread: { id: 'thread', name: '图片' },
      role: 'agent',
      text: '![图片](https://example.com/image.png)'
    }), rootPath)

    expect(resolved.files).toMatchObject([{
      mime: 'image/png',
      size: png.length
    }])
  })

  it('rejects a remote image whose declared size exceeds the download limit', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'codexio-http-large-image-'))
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not read', {
      headers: {
        'content-length': String(10 * 1024 * 1024 + 1),
        'content-type': 'image/png'
      }
    })))
    const resolver = new MessageFileResolver(new FileStore(new CodexioMetadata({ rootPath })))

    const resolved = await resolver.resolve(createMessage({
      id: 'agent-large-image',
      thread: { id: 'thread', name: '图片' },
      role: 'agent',
      text: '![图片](https://example.com/image.png)'
    }), rootPath)

    expect(resolved.files).toBeUndefined()
    expect(await readdir(new CodexioMetadata({ rootPath }).filePath).catch(() => [])).toEqual([])
  })

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

  it('stores identical content once using its SHA-256 identity', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'codexio-deduplicated-file-'))
    const metadata = new CodexioMetadata({ rootPath })
    const fileStore = new FileStore(metadata)
    const first = await fileStore.importBuffer({
      buffer: Buffer.from('same content'),
      name: 'first.txt'
    })
    const second = await fileStore.importBuffer({
      buffer: Buffer.from('same content'),
      name: 'second.txt'
    })

    expect(second.id).toBe(first.id)
    expect(second.path).toBe(first.path)
    expect(await readdir(metadata.filePath)).toHaveLength(1)
  })

  it('cleans unreferenced files after the retention period', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'codexio-file-cleanup-'))
    const metadata = new CodexioMetadata({ rootPath })
    await mkdir(metadata.filePath, {
      recursive: true
    })
    const expiredPath = join(metadata.filePath, 'expired')
    await writeFile(expiredPath, 'expired')
    await utimes(expiredPath, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'))

    const result = await new FileStore(metadata).cleanup(30, new Date('2026-03-01T00:00:00Z'))

    expect(result).toEqual({
      deleted: 1,
      bytes: 7
    })
    expect(await readdir(metadata.filePath)).toEqual([])
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
