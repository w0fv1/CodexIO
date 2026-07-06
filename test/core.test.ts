import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ChannelOutputManager } from '../src/component/channelo/ChannelOutputManager.js'
import { ChannelOutput } from '../src/component/channelo/ChannelOutput.js'
import { FeishuChannelOutput } from '../src/component/channelo/FeishuChannelOutput.js'
import { WebChannelOutput } from '../src/component/channelo/WebChannelOutput.js'
import { Configer } from '../src/component/Configer.js'
import { CodexioMetadata } from '../src/component/CodexioMetadata.js'
import { EventBus } from '../src/component/EventBus.js'
import { FileStore } from '../src/component/FileStore.js'
import { IoThreadIdManager } from '../src/component/IoThreadIdManager.js'
import { ThreadWorkspaceResolver } from '../src/component/ThreadWorkspaceResolver.js'
import { Agent } from '../src/component/agent/Agent.js'
import { AgentManager } from '../src/component/agent/AgentManager.js'
import { CodexClient, CodexClientThread } from '../src/component/agent/CodexClient.js'
import { CodexMessageStreamer } from '../src/component/agent/CodexMessageStreamer.js'
import { CommandExecutor, parseCommandInput } from '../src/controller/CommandExecutor.js'
import { ChannelInput } from '../src/controller/channeli/ChannelInput.js'
import { ChannelInputManager } from '../src/controller/channeli/ChannelInputManager.js'
import { AppEvent, ChannelMessageReceivedEvent } from '../src/value/Event.js'
import { ConfigSchema, createDefaultConfig, parseCodexioConfig, validateCodexioConfig } from '../src/value/ConfigDefinition.js'
import { Result } from '../src/value/Result.js'
import type { Message } from '../src/value/Message.js'
import { shouldReceiveFeishuMessage, shouldReceiveFeishuSender } from '../src/value/FeishuMessage.js'
import { parseMarkdownAttachmentReferences, renderMarkdownHtml } from '../src/util/Markdown.js'
import { resolveUserPath } from '../src/util/Path.js'
import { parseNfircoThreadSocketEvent } from '../src/component/channel/NfircoThreadClient.js'
import { WebThreadManager } from '../src/component/channel/WebThreadManager.js'
import { applyRuntimeConfig } from '../src/CodexioApplication.js'

const testMetadata = new CodexioMetadata()

function createTestCodexClient(configer: Configer, metadata = testMetadata): CodexClient {
  return new CodexClient(configer, metadata, new ThreadWorkspaceResolver(configer, metadata))
}

describe('core', () => {
  it('creates channel-only default config', () => {
    const config = createDefaultConfig()
    expect(config.server.host).toBe('127.0.0.1')
    expect(config.agents.instruction).toContain('Markdown reference')
    expect(config.agents.instruction).toContain('previews without a file path')
    expect(config.agents.echo.enabled).toBe(true)
    expect(config.agents.codex.bundled).toBe(true)
    expect(config.workspace.path).toBe('')
    expect(config.proxy.host).toBe('127.0.0.1')
    expect(config.proxy.noProxy).toBe('')
    expect(config.channeli.web?.enabled).toBe(true)
    expect(config.channeli.feishu?.aite).toBe(true)
    expect(config.channeli.feishu?.allowedOpenIds).toEqual([])
    expect(config.channeli.nfirco?.enabled).toBe(false)
    expect(config.channelo.nfirco?.enabled).toBe(false)
    expect(config.channelo.web?.enabled).toBe(true)
  })

  it('parses nfirco thread message events', () => {
    expect(parseNfircoThreadSocketEvent({
      type: 'thread.message.created',
      eventId: 'event-1',
      threadUuid: 'thread-1',
      section: 'section-1',
      messageUuid: 'message-1',
      text: 'hello',
      files: [
        {
          id: 11,
          originalFilename: '需求.md',
          mimeType: 'text/markdown',
          size: 12,
          url: 'http://127.0.0.1/file/11'
        }
      ],
      images: [
        {
          id: 12,
          originalFilename: '截图.png',
          mimeType: 'image/png',
          size: 13,
          url: 'http://127.0.0.1/file/12'
        }
      ]
    })).toEqual({
      type: 'thread.message.created',
      eventId: 'event-1',
      threadUuid: 'thread-1',
      section: 'section-1',
      messageUuid: 'message-1',
      text: 'hello',
      files: [
        {
          id: '11',
          name: '需求.md',
          mime: 'text/markdown',
          size: 12,
          url: 'http://127.0.0.1/file/11'
        }
      ],
      images: [
        {
          id: '12',
          name: '截图.png',
          mime: 'image/png',
          size: 13,
          url: 'http://127.0.0.1/file/12'
        }
      ]
    })
    expect(parseNfircoThreadSocketEvent({
      type: 'thread.created',
      eventId: 'thread-2',
      threadUuid: 'thread-2',
      section: 'section-1',
      text: 'thread body'
    })).toEqual({
      type: 'thread.created',
      eventId: 'thread-2',
      threadUuid: 'thread-2',
      section: 'section-1',
      text: 'thread body',
      files: [],
      images: []
    })
  })

  it('parses nfirco thread file-only message events', () => {
    expect(parseNfircoThreadSocketEvent({
      type: 'thread.message.created',
      eventId: 'event-file',
      threadUuid: 'thread-file',
      messageUuid: 'message-file',
      text: '',
      files: [
        {
          id: 21,
          filename: 'file.bin',
          url: 'http://127.0.0.1/file/21'
        }
      ]
    })).toEqual({
      type: 'thread.message.created',
      eventId: 'event-file',
      threadUuid: 'thread-file',
      section: undefined,
      messageUuid: 'message-file',
      text: '',
      files: [
        {
          id: '21',
          name: 'file.bin',
          mime: undefined,
          size: undefined,
          url: 'http://127.0.0.1/file/21'
        }
      ],
      images: []
    })
  })

  it('controls whether feishu group messages require aite', () => {
    expect(shouldReceiveFeishuMessage('group', [], true)).toBe(false)
    expect(shouldReceiveFeishuMessage('group', [
      {
        key: '@_user_1'
      }
    ], true)).toBe(true)
    expect(shouldReceiveFeishuMessage('group', [], false)).toBe(true)
    expect(shouldReceiveFeishuMessage('p2p', [], true)).toBe(true)
  })

  it('allows feishu senders by open id list', () => {
    expect(shouldReceiveFeishuSender(undefined, [])).toBe(true)
    expect(shouldReceiveFeishuSender('ou_1', [])).toBe(true)
    expect(shouldReceiveFeishuSender('ou_1', [
      'ou_1'
    ])).toBe(true)
    expect(shouldReceiveFeishuSender('ou_2', [
      'ou_1'
    ])).toBe(false)
  })

  it('parses command prefixes', () => {
    expect(parseCommandInput('$test')).toEqual({
      type: 'command',
      name: 'test',
      args: []
    })
    expect(parseCommandInput('￥help now')).toEqual({
      type: 'command',
      name: 'help',
      args: [
        'now'
      ]
    })
    expect(parseCommandInput('hello')).toEqual({
      type: 'message',
      text: 'hello'
    })
  })

  it('consumes test commands without sending them to the agent event', async () => {
    const eventBus = new EventBus()
    const executor = new CommandExecutor(eventBus)
    const result = await executor.receive({
      source: 'feishu',
      message: {
        ioThreadId: 'io-thread',
        role: 'user',
        text: '$test'
      },
      input: {
        channelThreadId: {
          source: 'feishu',
          id: 'chat:thread:omt_1'
        },
        text: '$test',
        mentioned: true,
        sender: {
          openId: 'ou_1'
        }
      }
    })
    expect(result.data?.consumed).toBe(true)
  })

  it('publishes input messages to display and agent manager events', async () => {
    const eventBus = new EventBus()
    const events: Array<{ type: string, source: string | undefined, sourceMessageId?: string, text: string }> = []
    eventBus.on(AppEvent.ChannelMessageDisplayRequested, async (event) => {
      events.push({
        type: 'display',
        source: event.source,
        sourceMessageId: event.sourceMessageId,
        text: event.message.text
      })
      return Result.successVoid()
    })
    eventBus.on(AppEvent.ChannelMessageReceived, async (event) => {
      events.push({
        type: 'agent',
        source: event.source,
        sourceMessageId: event.sourceMessageId,
        text: event.message.text
      })
      return Result.successVoid()
    })
    const manager = new ChannelInputManager(
      {} as Configer,
      eventBus,
      createIoThreadIdManager(),
      new CommandExecutor(eventBus),
      disabledInput('web'),
      disabledInput('feishu'),
      disabledInput('email'),
      disabledInput('nfirco')
    )
    const result = await manager.receive('feishu', {
      channelThreadId: {
        source: 'feishu',
        id: 'chat:thread:omt_1'
      },
      sourceMessageId: 'om_1',
      text: 'hello'
    })
    expect(result.isFailed).toBe(false)
    expect(events).toEqual([
      {
        type: 'display',
        source: 'feishu',
        sourceMessageId: 'om_1',
        text: 'hello'
      },
      {
        type: 'agent',
        source: 'feishu',
        sourceMessageId: 'om_1',
        text: 'hello'
      }
    ])
  })

  it('rejects configs without enabled channel input and output', () => {
    const config = ConfigSchema.parse({
      channeli: {
        web: {
          enabled: false
        }
      },
      channelo: {
        web: {
          enabled: false
        }
      }
    })
    expect(() => validateCodexioConfig(config)).toThrow('one channeli must be enabled')
    expect(() => validateCodexioConfig(config)).toThrow('one channelo must be enabled')
  })

  it('rejects configs without enabled agents', () => {
    const config = ConfigSchema.parse({
      agents: {
        echo: {
          enabled: false
        },
        codex: {
          enabled: false
        }
      }
    })
    expect(() => validateCodexioConfig(config)).toThrow('one agent must be enabled')
  })

  it('keeps codex agent and workspace config fields when importing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-config-'))
    const configPath = join(dir, 'config.yaml')
    await writeFile(configPath, [
      'server:',
      '  token: test-token',
      'agents:',
      '  instruction: Shared instruction',
      '  echo:',
      '    enabled: false',
      '  codex:',
      '    enabled: true',
      '    bundled: false',
      '    command: codex-dev',
      'workspace:',
      '  path: workspace',
      'proxy:',
      '  enabled: true',
      '  host: 127.0.0.1',
      '  port: 7891',
      '  noProxy: next.firco.cn,*.firco.cn',
      'channeli:',
      '  web:',
      '    enabled: true',
      'channelo:',
      '  web:',
      '    enabled: true'
    ].join('\n'))
    const configer = new Configer(new CodexioMetadata({
      rootPath: testMetadata.rootPath,
      configPath
    }))
    const exported = await configer.exportText()
    expect(exported).toContain('agents:')
    expect(exported).toContain('workspace:')
    expect(await configer.get('agents.instruction')).toBe('Shared instruction')
    expect(await configer.get('agents.echo.enabled')).toBe(false)
    expect(await configer.get('agents.codex.enabled')).toBe(true)
    expect(await configer.get('agents.codex.bundled')).toBe(false)
    expect(await configer.get('agents.codex.command')).toBe('codex-dev')
    expect(await configer.get('workspace.path')).toBe('workspace')
    expect(await configer.get('proxy.port')).toBe(7891)
    expect(await configer.get('proxy.noProxy')).toBe('next.firco.cn,*.firco.cn')
    expect(await configer.get('channeli.web.enabled')).toBe(true)
    expect(await configer.get('channelo.web.enabled')).toBe(true)
  })

  it('does not rewrite an existing config during init', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-config-preserve-'))
    const configPath = join(dir, 'config.yaml')
    const text = [
      '# keep this comment',
      'server:',
      '  token: keep-token',
      'agents:',
      '  echo:',
      '    enabled: true',
      'channeli:',
      '  web:',
      '    enabled: true',
      'channelo:',
      '  web:',
      '    enabled: true'
    ].join('\n')
    await writeFile(configPath, text, 'utf8')
    const configer = new Configer(new CodexioMetadata({
      rootPath: testMetadata.rootPath,
      configPath
    }))
    await configer.init(false)
    expect(await readFile(configPath, 'utf8')).toBe(text)
  })

  it('enables auto port from runtime args', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-runtime-config-'))
    const configPath = join(dir, 'config.yaml')
    await writeFile(configPath, [
      'server:',
      '  token: test-token',
      '  autoPort: false',
      'channeli:',
      '  web:',
      '    enabled: true',
      'channelo:',
      '  web:',
      '    enabled: true'
    ].join('\n'))
    const configer = new Configer(new CodexioMetadata({
      rootPath: testMetadata.rootPath,
      configPath
    }))
    await applyRuntimeConfig(configer, [
      'node',
      'CodexioApplication.js',
      '--auto-port'
    ])
    expect(await configer.get('server.autoPort')).toBe(true)
  })

  it('passes configured no proxy hosts to the codex process', async () => {
    const values = new Map<string, unknown>([
      ['agents.codex.bundled', false],
      ['workspace.path', 'workspace'],
      ['proxy.enabled', true],
      ['proxy.host', '127.0.0.1'],
      ['proxy.port', 7890],
      ['proxy.noProxy', 'next.firco.cn, *.firco.cn ,'],
      ['server.host', '127.0.0.1'],
      ['agents.codex.command', 'codex'],
      ['agents.instruction', ''],
      ['agents.codex.developerInstructions', ''],
      ['agents.codex.requestTimeoutSeconds', 120]
    ])
    const client = createTestCodexClient({
      get: async (path: string) => values.get(path)
    } as unknown as Configer)
    const runtimeConfig = await client['readRuntimeConfig']()
    expect(runtimeConfig.noProxyHosts).toEqual([
      'localhost',
      '127.0.0.1',
      '::1',
      '127.0.0.1',
      'next.firco.cn',
      '*.firco.cn'
    ])
  })

  it('uses data workspace and a filesystem codex command by default', async () => {
    const values = new Map<string, unknown>([
      ['agents.codex.bundled', true],
      ['workspace.path', ''],
      ['proxy.enabled', false],
      ['proxy.host', '127.0.0.1'],
      ['proxy.port', 7890],
      ['proxy.noProxy', ''],
      ['server.host', '127.0.0.1'],
      ['agents.codex.command', 'codex'],
      ['agents.instruction', ''],
      ['agents.codex.developerInstructions', ''],
      ['agents.codex.requestTimeoutSeconds', 120]
    ])
    const dir = await mkdtemp(join(tmpdir(), 'codexio-default-workspace-'))
    const metadata = new CodexioMetadata({
      rootPath: testMetadata.rootPath,
      dataPath: dir
    })
    const client = createTestCodexClient({
      get: async (path: string) => values.get(path)
    } as unknown as Configer, metadata)
    const runtimeConfig = await client['readRuntimeConfig']()
    expect(runtimeConfig.processCwd).toBe(join(dir, 'workspace'))
    expect(runtimeConfig.command).not.toContain('app.asar')
  })

  it('resolves the system codex command from known install locations', async () => {
    const previousPath = process.env.PATH
    const previousLocalAppData = process.env.LOCALAPPDATA
    const previousUserProfile = process.env.USERPROFILE
    const localAppData = await mkdtemp(join(tmpdir(), 'codexio-localappdata-'))
    const userProfile = await mkdtemp(join(tmpdir(), 'codexio-userprofile-'))
    const localBin = join(localAppData, 'OpenAI', 'Codex', 'bin', 'system-codex')
    const vscodeBin = join(userProfile, '.vscode', 'extensions', 'openai.chatgpt-test', 'bin', 'windows-x86_64')
    await mkdir(localBin, {
      recursive: true
    })
    await mkdir(vscodeBin, {
      recursive: true
    })
    await writeFile(join(localBin, 'codex.exe'), '')
    await writeFile(join(vscodeBin, 'codex.exe'), '')
    process.env.PATH = ''
    process.env.LOCALAPPDATA = localAppData
    process.env.USERPROFILE = userProfile
    try {
      const values = new Map<string, unknown>([
        ['agents.codex.bundled', false],
        ['workspace.path', ''],
        ['proxy.enabled', false],
        ['proxy.host', '127.0.0.1'],
        ['proxy.port', 7890],
        ['proxy.noProxy', ''],
        ['server.host', '127.0.0.1'],
        ['agents.codex.command', 'codex'],
        ['agents.instruction', ''],
        ['agents.codex.developerInstructions', ''],
        ['agents.codex.requestTimeoutSeconds', 120]
      ])
      const metadata = new CodexioMetadata({
        rootPath: testMetadata.rootPath,
        dataPath: await mkdtemp(join(tmpdir(), 'codexio-command-resolution-'))
      })
      const client = createTestCodexClient({
        get: async (path: string) => values.get(path)
      } as unknown as Configer, metadata)
      const runtimeConfig = await client['readRuntimeConfig']()
      expect(runtimeConfig.command).toBe(join(vscodeBin, 'codex.exe'))
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH
      } else {
        process.env.PATH = previousPath
      }
      if (previousLocalAppData === undefined) {
        delete process.env.LOCALAPPDATA
      } else {
        process.env.LOCALAPPDATA = previousLocalAppData
      }
      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE
      } else {
        process.env.USERPROFILE = previousUserProfile
      }
    }
  })

  it('adds Codexio file delivery instructions to new codex threads', async () => {
    const values = new Map<string, unknown>([
      ['agents.codex.bundled', false],
      ['workspace.path', '~'],
      ['proxy.enabled', false],
      ['proxy.host', '127.0.0.1'],
      ['proxy.port', 7890],
      ['proxy.noProxy', ''],
      ['server.host', '127.0.0.1'],
      ['agents.codex.command', 'codex'],
      ['agents.instruction', 'File rule with Markdown reference'],
      ['agents.codex.developerInstructions', 'Project rule'],
      ['agents.codex.requestTimeoutSeconds', 120]
    ])
    const client = createTestCodexClient({
      get: async (path: string) => values.get(path)
    } as unknown as Configer)
    let threadStartParams: Record<string, unknown> | undefined
    client['request'] = async (method: string, params?: unknown) => {
      if (method === 'thread/start') {
        threadStartParams = params as Record<string, unknown>
        return {
          thread: {
            id: 'thread-1',
            name: 'thread'
          }
        }
      }
      throw new Error(method)
    }
    await client['startThread']()
    expect(String(threadStartParams?.developerInstructions)).toContain('Markdown reference')
    expect(String(threadStartParams?.developerInstructions)).toContain('Project rule')
  })

  it('starts new codex threads inside the io thread workspace when enabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-thread-workspace-'))
    const values = new Map<string, unknown>([
      ['agents.codex.bundled', false],
      ['workspace.path', dir],
      ['workspace.perIoThread', true],
      ['proxy.enabled', false],
      ['proxy.host', '127.0.0.1'],
      ['proxy.port', 7890],
      ['proxy.noProxy', ''],
      ['server.host', '127.0.0.1'],
      ['agents.codex.command', 'codex'],
      ['agents.instruction', ''],
      ['agents.codex.developerInstructions', ''],
      ['agents.codex.requestTimeoutSeconds', 120]
    ])
    const client = createTestCodexClient({
      get: async (path: string) => values.get(path)
    } as unknown as Configer)
    let threadStartParams: Record<string, unknown> | undefined
    client['request'] = async (method: string, params?: unknown) => {
      if (method === 'thread/start') {
        threadStartParams = params as Record<string, unknown>
        return {
          thread: {
            id: 'thread-1',
            name: 'thread'
          }
        }
      }
      throw new Error(method)
    }
    await client['startThread']('io-thread')
    expect(threadStartParams?.cwd).toBe(join(dir, 'io-thread'))
  })

  it('emits codex client thread callbacks as single threads', () => {
    const client = createTestCodexClient({
      get: async () => undefined
    } as unknown as Configer)
    const threads: CodexClientThread[] = []
    client.on('thread', (thread) => {
      threads.push(thread)
    })
    client['upsertThread']({
      id: 'codex-thread',
      title: 'Thread',
      isWorking: false
    })
    client['removeThread']('codex-thread')
    expect(threads).toEqual([
      {
        id: 'codex-thread',
        title: 'Thread',
        isWorking: false
      },
      {
        id: 'codex-thread',
        title: 'Thread',
        isWorking: false,
        deleted: true
      }
    ])
  })

  it('sends non-web channel messages to the web thread history', async () => {
    const sent: Message[] = []
    const output = new WebChannelOutput({
      get: async (path: string) => {
        if (path === 'channelo.web') {
          return {
            enabled: true
          }
        }
        if (path === 'server.host') {
          return '127.0.0.1'
        }
        if (path === 'server.port') {
          return 8787
        }
        return undefined
      }
    } as unknown as Configer, {
      send: (message: Message) => {
        sent.push(message)
        return Result.successVoid()
      }
    })
    expect(await output.start()).toBe(true)
    const result = await output.send({
      ioThreadId: 'external-io-thread',
      role: 'agent',
      text: 'external'
    })
    expect(result.isFailed).toBe(false)
    expect(sent).toEqual([
      {
        ioThreadId: 'external-io-thread',
        role: 'agent',
        text: 'external'
      }
    ])
  })

  it('stores non-web channel messages in an io thread web view', () => {
    const manager = new WebThreadManager(createIoThreadIdManager())
    manager.appendMessage({
      ioThreadId: 'external-io-thread',
      role: 'user',
      text: 'hello'
    })
    manager.appendMessage({
      ioThreadId: 'external-io-thread',
      role: 'agent',
      text: 'world'
    })
    expect(manager.snapshot()).toMatchObject({
      threads: [
        {
          id: 'io:external-io-thread',
          ioThreadId: 'external-io-thread',
          title: 'hello'
        }
      ],
      messages: [
        {
          role: 'user',
          webThreadId: 'io:external-io-thread',
          text: 'hello'
        },
        {
          role: 'agent',
          webThreadId: 'io:external-io-thread',
          text: 'world'
        }
      ]
    })
  })

  it('resolves tilde workspace paths to the user home directory', async () => {
    const parsed = await parseCodexioConfig({
      workspace: {
        path: null
      }
    }, 'config.yaml')
    expect(parsed.workspace.path).toBe('~')
    expect(resolveUserPath('~')).toBe(homedir())
    expect(resolveUserPath('~/work')).toBe(join(homedir(), 'work'))
    expect(resolveUserPath('~\\work')).toBe(join(homedir(), 'work'))
    const values = new Map<string, unknown>([
      ['agents.codex.bundled', false],
      ['workspace.path', '~'],
      ['proxy.enabled', false],
      ['proxy.host', '127.0.0.1'],
      ['proxy.port', 7890],
      ['proxy.noProxy', ''],
      ['server.host', '127.0.0.1'],
      ['agents.codex.command', 'codex'],
      ['agents.instruction', ''],
      ['agents.codex.developerInstructions', ''],
      ['agents.codex.requestTimeoutSeconds', 120]
    ])
    const client = createTestCodexClient({
      get: async (path: string) => values.get(path)
    } as unknown as Configer)
    const runtimeConfig = await client['readRuntimeConfig']()
    expect(runtimeConfig.processCwd).toBe(homedir())
  })

  it('removes the final newline from rendered markdown html', () => {
    expect(renderMarkdownHtml('你好。')).toBe('<p>你好。</p>')
  })

  it('parses markdown attachment references', () => {
    expect(parseMarkdownAttachmentReferences('图片 ![图](https://example.com/a.png) 文件 [说明](./docs/readme.md)')).toEqual({
      text: '图片 `https://example.com/a.png` 文件 `./docs/readme.md`',
      files: [
        {
          label: '图',
          path: 'https://example.com/a.png',
          image: true
        },
        {
          label: '说明',
          path: './docs/readme.md',
          image: false
        }
      ]
    })
  })

  it('binds one channel thread identity to one io thread', () => {
    const manager = createIoThreadIdManager()
    const ioThreadId = 'io-thread'
    expect(manager.getLastActiveIoThreadId()).toBeUndefined()
    manager.bind(ioThreadId, {
      source: 'feishu',
      id: ' chat:thread:omt_1 '
    })
    expect(manager.getLastActiveIoThreadId()).toBe(ioThreadId)
    expect(manager.getIoThreadId({
      source: 'feishu',
      id: 'chat:thread:omt_1'
    })).toBe(ioThreadId)
    expect(manager.getLastActiveIoThreadId()).toBe(ioThreadId)
    expect(manager.getIoThreadId({
      source: 'email',
      id: 'chat:thread:omt_1'
    })).not.toBe(ioThreadId)
  })

  it('binds multiple channels to one io thread', () => {
    const manager = createIoThreadIdManager()
    const ioThreadId = 'io-thread'
    manager.bind(ioThreadId, {
      source: 'feishu',
      id: 'chat:thread:omt_1'
    })
    manager.bind(ioThreadId, {
      source: 'email',
      id: 'mailbox:root:message-1'
    })
    expect(manager.getIoThreadId({
      source: 'email',
      id: 'mailbox:root:message-1'
    })).toBe(ioThreadId)
    expect(manager.getChannelThreadIds(ioThreadId)).toEqual([
      {
        source: 'feishu',
        id: 'chat:thread:omt_1'
      },
      {
        source: 'email',
        id: 'mailbox:root:message-1'
      }
    ])
    expect(manager.getLastActiveIoThreadId()).toBe(ioThreadId)
  })

  it('uses the last active io thread for system messages', async () => {
    const sent: Message[] = []
    const ioThreadIdManager = createIoThreadIdManager()
    const manager = await createRecordingChannelOutputManager(sent, ioThreadIdManager)
    expect((await manager.sendSystem('empty')).isFailed).toBe(true)
    ioThreadIdManager.bind('io-thread-system', {
      source: 'web',
      id: 'io-thread-system'
    })
    const result = await manager.sendSystem('system message')
    expect(result.isFailed).toBe(false)
    expect(sent).toEqual([
      {
        ioThreadId: 'io-thread-system',
        role: 'system',
        text: 'system message'
      }
    ])
  })

  it('creates and binds an io thread when getting a new channel thread id', () => {
    const manager = createIoThreadIdManager()
    const ioThreadId = manager.getIoThreadId({
      source: 'feishu',
      id: 'chat:thread:omt_1'
    })
    expect(ioThreadId).toBeTruthy()
    expect(manager.getIoThreadId({
      source: 'feishu',
      id: 'chat:thread:omt_1'
    })).toBe(ioThreadId)
  })

  it('rejects binding one channel thread id to two io threads', () => {
    const manager = createIoThreadIdManager()
    manager.bind('io-thread-a', {
      source: 'feishu',
      id: 'chat:thread:omt_1'
    })
    expect(() => manager.bind('io-thread-b', {
      source: 'feishu',
      id: 'chat:thread:omt_1'
    })).toThrow('ioThread key already bound')
  })

  it('keeps channel thread ids source scoped', () => {
    const manager = createIoThreadIdManager()
    manager.bind('io-thread-feishu', {
      source: 'feishu',
      id: 'same-id'
    })
    manager.bind('io-thread-email', {
      source: 'email',
      id: 'same-id'
    })
    expect(manager.getIoThreadId({
      source: 'feishu',
      id: 'same-id'
    })).toBe('io-thread-feishu')
    expect(manager.getIoThreadId({
      source: 'email',
      id: 'same-id'
    })).toBe('io-thread-email')
  })

  it('rejects more than one id of the same channel on one io thread', () => {
    const manager = createIoThreadIdManager()
    manager.bind('io-thread', {
      source: 'feishu',
      id: 'chat:thread:omt_1'
    })
    expect(() => manager.bind('io-thread', {
      source: 'feishu',
      id: 'chat:thread:omt_2'
    })).toThrow('ioThread source already bound')
    expect(manager.getIoThreadId({
      source: 'feishu',
      id: 'chat:thread:omt_1'
    })).toBe('io-thread')
  })

  it('restores io thread identities from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-io-thread-'))
    const metadata = new CodexioMetadata({
      rootPath: testMetadata.rootPath,
      dataPath: dir
    })
    const manager = new IoThreadIdManager(metadata)
    const ioThreadId = manager.getIoThreadId({
      source: 'feishu',
      id: 'chat-1:thread:omt_1'
    })
    manager.bind(ioThreadId, {
      source: 'web',
      id: 'web-thread'
    })
    await manager.flush()
    const persisted = JSON.parse(await readFile(metadata.ioThreadStatePath, 'utf8')) as {
      lastActiveIoThreadId?: string
    }
    expect(persisted.lastActiveIoThreadId).toBe(ioThreadId)
    const restored = new IoThreadIdManager(metadata)
    await restored.init()
    expect(restored.getIoThreadId({
      source: 'feishu',
      id: 'chat-1:thread:omt_1'
    })).toBe(ioThreadId)
    expect(restored.getIoThreadId({
      source: 'web',
      id: 'web-thread'
    })).toBe(ioThreadId)
    expect(restored.getLastActiveIoThreadId()).toBe(ioThreadId)
  })

  it('rejects duplicated io thread ids in persisted state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-io-thread-duplicated-'))
    const metadata = new CodexioMetadata({
      rootPath: testMetadata.rootPath,
      dataPath: dir
    })
    await mkdir(join(dir, 'state'), {
      recursive: true
    })
    await writeFile(metadata.ioThreadStatePath, JSON.stringify({
      version: 2,
      threads: [
        {
          ioThreadId: 'io-thread',
          channelThreadIds: [
            {
              source: 'feishu',
              id: 'chat-1:thread:omt_1'
            }
          ],
          createdAt: 1,
          updatedAt: 1
        },
        {
          ioThreadId: 'io-thread',
          channelThreadIds: [
            {
              source: 'feishu',
              id: 'chat-1:thread:omt_2'
            }
          ],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    }), 'utf8')
    const manager = new IoThreadIdManager(metadata)
    await expect(manager.init()).rejects.toThrow('ioThreadId duplicated in state')
  })

  it('reports io thread persist failures through flush', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-io-thread-failed-'))
    const blockedDataPath = join(dir, 'data-file')
    await writeFile(blockedDataPath, 'not a directory')
    const metadata = new CodexioMetadata({
      rootPath: testMetadata.rootPath,
      dataPath: blockedDataPath
    })
    const manager = new IoThreadIdManager(metadata)
    manager.getIoThreadId({
      source: 'feishu',
      id: 'chat-1:thread:omt_1'
    })
    await expect(manager.flush()).rejects.toThrow()
  })

  it('broadcasts channel messages without storing conversation history', async () => {
    const sent: Message[] = []
    const manager = await createRecordingChannelOutputManager(sent)
    await manager.sendUser({
      ioThreadId: 'io-thread',
      role: 'user',
      text: 'hello'
    }, 'web')
    expect(sent).toEqual([
      {
        ioThreadId: 'io-thread',
        role: 'user',
        text: 'hello'
      }
    ])
  })

  it('routes channel output to every enabled channel', async () => {
    const sent: Array<{ type: string, message: Message }> = []
    const manager = await createRecordingChannelOutputManager(sent, createIoThreadIdManager(), [
      'web',
      'feishu',
      'feishuWebhook',
      'email'
    ])
    await manager.sendAgent({
      ioThreadId: 'io-thread',
      role: 'agent',
      text: 'hello'
    }, 'feishu')
    await manager.stop()
    expect(sent.map((item) => item.type)).toEqual([
      'web',
      'feishu',
      'feishuWebhook',
      'email'
    ])
  })

  it('replies to feishu source messages in the topic thread', async () => {
    const ioThreadIdManager = createIoThreadIdManager()
    const calls: unknown[] = []
    const output = new FeishuChannelOutput({
      get: async (path: string) => {
        if (path === 'channelo.feishu') {
          return {
            enabled: true,
            appId: 'app-id',
            appSecret: 'app-secret',
            chatId: 'chat-1'
          }
        }
        return undefined
      }
    } as unknown as Configer, ioThreadIdManager)
    await output.start()
    Reflect.set(output, 'client', {
      im: {
        v1: {
          message: {
            create: async (payload: unknown) => {
              calls.push(payload)
              return {
                data: {
                  message_id: 'om_created',
                  thread_id: 'omt_1'
                }
              }
            },
            reply: async (payload: unknown) => {
              calls.push(payload)
              return {
                data: {
                  message_id: 'om_reply',
                  thread_id: 'omt_1'
                }
              }
            }
          }
        }
      }
    })
    const first = await output.send({
      ioThreadId: 'io-thread',
      role: 'agent',
      text: 'hello'
    }, {
      source: 'feishu',
      sourceMessageId: 'om_user'
    })
    expect(first.isFailed).toBe(false)
    expect(ioThreadIdManager.getChannelThreadIds('io-thread')).toEqual([
      {
        source: 'feishu',
        id: 'chat-1:thread:omt_1'
      }
    ])
    const second = await output.send({
      ioThreadId: 'io-thread',
      role: 'agent',
      text: 'again'
    }, {
      source: 'feishu',
      sourceMessageId: 'om_user'
    })
    expect(second.isFailed).toBe(false)
    expect(calls).toMatchObject([
      {
        path: {
          message_id: 'om_user'
        },
        data: {
          reply_in_thread: true
        }
      },
      {
        path: {
          message_id: 'om_user'
        },
        data: {
          reply_in_thread: true
        }
      }
    ])
  })

  it('creates a feishu topic for non-feishu output and continues with reply', async () => {
    const ioThreadIdManager = createIoThreadIdManager()
    const calls: unknown[] = []
    const output = new FeishuChannelOutput({
      get: async (path: string) => {
        if (path === 'channelo.feishu') {
          return {
            enabled: true,
            appId: 'app-id',
            appSecret: 'app-secret',
            chatId: 'chat-1'
          }
        }
        return undefined
      }
    } as unknown as Configer, ioThreadIdManager)
    await output.start()
    Reflect.set(output, 'client', {
      im: {
        v1: {
          message: {
            create: async (payload: unknown) => {
              calls.push(payload)
              return {
                data: {
                  message_id: 'om_created',
                  thread_id: 'omt_1'
                }
              }
            },
            reply: async (payload: unknown) => {
              calls.push(payload)
              return {
                data: {
                  message_id: 'om_reply',
                  thread_id: 'omt_1'
                }
              }
            }
          }
        }
      }
    })
    const first = await output.send({
      ioThreadId: 'io-thread',
      role: 'agent',
      text: 'hello'
    }, {
      source: 'web'
    })
    expect(first.isFailed).toBe(false)
    expect(ioThreadIdManager.getChannelThreadIds('io-thread')).toEqual([
      {
        source: 'feishu',
        id: 'chat-1:thread:omt_1'
      }
    ])
    const second = await output.send({
      ioThreadId: 'io-thread',
      role: 'agent',
      text: 'again'
    }, {
      source: 'web'
    })
    expect(second.isFailed).toBe(false)
    expect(calls).toMatchObject([
      {
        params: {
          receive_id_type: 'chat_id'
        },
        data: {
          receive_id: 'chat-1'
        }
      },
      {
        path: {
          message_id: 'om_created'
        },
        data: {
          reply_in_thread: true
        }
      }
    ])
  })

  it('turns agent markdown file references into message files before output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-output-file-'))
    const imagePath = join(dir, 'agent.png')
    await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'))
    const sent: Message[] = []
    const manager = await createRecordingChannelOutputManager(sent, createIoThreadIdManager(), [
      'web'
    ])
    await manager.sendAgent({
      ioThreadId: 'io-thread',
      role: 'agent',
      text: `已生成：![agent](${imagePath.replaceAll('\\', '/')})`
    })
    await manager.stop()
    expect(sent).toHaveLength(1)
    expect(sent[0].files?.[0]).toMatchObject({
      name: 'agent.png',
      mime: 'image/png'
    })
    expect(sent[0].text).toContain('`')
  })

  it('resolves relative agent file references from the io thread workspace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-output-thread-file-'))
    const threadDir = join(dir, 'io-thread')
    await mkdir(threadDir, {
      recursive: true
    })
    await writeFile(join(threadDir, 'agent.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'))
    const sent: Message[] = []
    const manager = await createRecordingChannelOutputManager(sent, createIoThreadIdManager(), [
      'web'
    ], {
      subscribe: () => {},
      get: async (path: string) => {
        if (path === 'workspace.path') {
          return dir
        }
        if (path === 'workspace.perIoThread') {
          return true
        }
        return undefined
      }
    } as unknown as Configer)
    await manager.sendAgent({
      ioThreadId: 'io-thread',
      role: 'agent',
      text: '已生成：![agent](./agent.png)'
    })
    await manager.stop()
    expect(sent[0].files?.[0]).toMatchObject({
      name: 'agent.png',
      mime: 'image/png'
    })
  })

  it('routes channel messages to echo by default and codex when enabled', async () => {
    let codexEnabled = false
    const eventBus = new EventBus()
    const echo = createRecordingAgent('echo')
    const codex = createRecordingAgent('codex')
    const configer = {
      get: async (path: string) => {
        if (path === 'agents.codex.enabled') {
          return codexEnabled
        }
        if (path === 'agents.echo.enabled') {
          return true
        }
        return undefined
      },
      subscribe: () => {}
    } as unknown as Configer
    const manager = new AgentManager(configer, eventBus, codex, echo, new ThreadWorkspaceResolver(configer, testMetadata))
    await manager.start()
    await eventBus.emitAsync(AppEvent.ChannelMessageReceived, channelMessage('first'))
    expect(echo.messages.map((message) => message.text)).toEqual([
      'first'
    ])
    expect(codex.messages).toEqual([])
    codexEnabled = true
    await manager.applyConfig()
    await eventBus.emitAsync(AppEvent.ChannelMessageReceived, channelMessage('second'))
    expect(codex.messages.map((message) => message.text)).toEqual([
      'second'
    ])
    await manager.stop()
  })

  it('buffers codex deltas until completion', async () => {
    const sent: Message[] = []
    const eventBus = new EventBus()
    eventBus.on(AppEvent.ChannelMessageDisplayRequested, async (event) => {
      sent.push(event.message)
      return Result.successVoid()
    })
    const streamer = new CodexMessageStreamer(eventBus)
    const thread = {
      ioThreadId: 'io-thread',
      agentThreadId: 'codex-thread'
    }
    await streamer.append(thread, 'item', '你')
    await streamer.append(thread, 'item', '好')
    await streamer.append(thread, 'item', '。')
    expect(sent).toEqual([])
    await streamer.complete(thread, [
      {
        itemId: 'item',
        text: '你好。'
      }
    ])
    expect(sent).toEqual([
      {
        ioThreadId: 'io-thread',
        role: 'agent',
        text: '你好。'
      }
    ])
  })

  it('does not flush codex deltas at a double newline after a colon', async () => {
    const sent: Message[] = []
    const eventBus = new EventBus()
    eventBus.on(AppEvent.ChannelMessageDisplayRequested, async (event) => {
      sent.push(event.message)
      return Result.successVoid()
    })
    const streamer = new CodexMessageStreamer(eventBus)
    const thread = {
      ioThreadId: 'io-thread',
      agentThreadId: 'codex-thread'
    }
    await streamer.append(thread, 'item', '根因有两个:\n\n')
    expect(sent).toEqual([])
    await streamer.append(thread, 'item', '第一个原因。')
    expect(sent).toEqual([])
    await streamer.completeItem(thread, 'item')
    expect(sent).toEqual([
      {
        ioThreadId: 'io-thread',
        role: 'agent',
        text: '根因有两个:\n\n第一个原因。'
      }
    ])
  })

  it('flushes codex deltas at a double newline after a sentence end', async () => {
    const sent: Message[] = []
    const eventBus = new EventBus()
    eventBus.on(AppEvent.ChannelMessageDisplayRequested, async (event) => {
      sent.push(event.message)
      return Result.successVoid()
    })
    const streamer = new CodexMessageStreamer(eventBus)
    const thread = {
      ioThreadId: 'io-thread',
      agentThreadId: 'codex-thread'
    }
    await streamer.append(thread, 'item', '服务恢复了。\n\n继续验证。')
    expect(sent).toEqual([
      {
        ioThreadId: 'io-thread',
        role: 'agent',
        text: '服务恢复了。'
      }
    ])
    await streamer.completeItem(thread, 'item')
    expect(sent).toEqual([
      {
        ioThreadId: 'io-thread',
        role: 'agent',
        text: '服务恢复了。'
      },
      {
        ioThreadId: 'io-thread',
        role: 'agent',
        text: '继续验证。'
      }
    ])
  })

  it('flushes the remaining codex buffer on completion without sentence end punctuation', async () => {
    const sent: Message[] = []
    const eventBus = new EventBus()
    eventBus.on(AppEvent.ChannelMessageDisplayRequested, async (event) => {
      sent.push(event.message)
      return Result.successVoid()
    })
    const streamer = new CodexMessageStreamer(eventBus)
    const thread = {
      ioThreadId: 'io-thread',
      agentThreadId: 'codex-thread'
    }
    await streamer.append(thread, 'item', '我改了 ThreadComposer.svelte:\n\n新增 sendDisabled')
    expect(sent).toEqual([])
    await streamer.completeItem(thread, 'item')
    expect(sent).toEqual([
      {
        ioThreadId: 'io-thread',
        role: 'agent',
        text: '我改了 ThreadComposer.svelte:\n\n新增 sendDisabled'
      }
    ])
  })

  it('keeps the source channel and message id on codex stream output', async () => {
    const sent: Array<{ source: string | undefined, sourceMessageId?: string, message: Message }> = []
    const eventBus = new EventBus()
    eventBus.on(AppEvent.ChannelMessageDisplayRequested, async (event) => {
      sent.push({
        source: event.source,
        sourceMessageId: event.sourceMessageId,
        message: event.message
      })
      return Result.successVoid()
    })
    const streamer = new CodexMessageStreamer(eventBus)
    await streamer.complete({
      ioThreadId: 'io-thread',
      agentThreadId: 'codex-thread',
      source: 'feishu',
      sourceMessageId: 'om_1'
    }, [
      {
        itemId: 'item',
        text: '你好。'
      }
    ])
    expect(sent).toEqual([
      {
        source: 'feishu',
        sourceMessageId: 'om_1',
        message: {
          ioThreadId: 'io-thread',
          role: 'agent',
          text: '你好。'
        }
      }
    ])
  })

  it('does not resend codex item text when the turn completes', async () => {
    const sent: Message[] = []
    const eventBus = new EventBus()
    eventBus.on(AppEvent.ChannelMessageDisplayRequested, async (event) => {
      sent.push(event.message)
      return Result.successVoid()
    })
    const streamer = new CodexMessageStreamer(eventBus)
    const thread = {
      ioThreadId: 'io-thread',
      agentThreadId: 'codex-thread'
    }
    await streamer.append(thread, 'item', '你好')
    await streamer.completeItem(thread, 'item')
    await streamer.complete(thread, [
      {
        itemId: 'item',
        text: '你好'
      }
    ])
    expect(sent).toEqual([
      {
        ioThreadId: 'io-thread',
        role: 'agent',
        text: '你好'
      }
    ])
  })
})

async function createRecordingChannelOutputManager(
  sent: Message[] | Array<{ type: string, message: Message }>,
  ioThreadIdManager = createIoThreadIdManager(),
  enabledTypes = ['web'],
  configer = {
    subscribe: () => {},
    get: async (path: string) => path === 'workspace.path' ? '~' : undefined
  } as unknown as Configer
): Promise<ChannelOutputManager> {
  const fileStore = new FileStore(testMetadata)
  const output = (type: ChannelOutput['type']): ChannelOutput => ({
    type,
    start: async () => enabledTypes.includes(type),
    send: async (message: Message) => {
      if (enabledTypes.length === 1) {
        ;(sent as Message[]).push(message)
      } else {
        ;(sent as Array<{ type: string, message: Message }>).push({
          type,
          message
        })
      }
      return Result.successVoid()
    },
    stop: async () => Result.successVoid()
  })
  const manager = new ChannelOutputManager(
    configer,
    fileStore,
    new EventBus(),
    ioThreadIdManager,
    output('web'),
    output('feishu'),
    output('feishuWebhook'),
    output('email'),
    output('nfirco'),
    new ThreadWorkspaceResolver(configer, testMetadata)
  )
  await manager.start()
  return manager
}

function createIoThreadIdManager(): IoThreadIdManager {
  return new IoThreadIdManager(new CodexioMetadata({
    rootPath: testMetadata.rootPath,
    dataPath: join(tmpdir(), `codexio-io-thread-${randomUUID()}`)
  }))
}

function disabledInput(type: ChannelInput['type']): ChannelInput {
  return {
    type,
    start: async () => false,
    stop: async () => Result.successVoid()
  }
}

function createRecordingAgent(type: string): Agent & { messages: Message[] } {
  const messages: Message[] = []
  return {
    type,
    messages,
    start: async () => Result.successVoid(),
    receive: async (event) => {
      messages.push(event.message)
      return Result.successVoid()
    },
    stop: async () => Result.successVoid()
  }
}

function channelMessage(text: string): ChannelMessageReceivedEvent {
  return {
    source: 'web',
    message: {
      ioThreadId: 'io-thread',
      role: 'user',
      text
    }
  }
}
