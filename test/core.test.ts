import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createProcessEnv } from '../src/util/ProcessEnvironment.js'
import { AgentManager } from '../src/agent/AgentManager.js'
import { CodexAppServer, CodexAppServerRequestError } from '../src/agent/CodexAppServer.js'
import { AgentLoginInProgressError, CodexAgent, createCodexCommand } from '../src/agent/CodexAgent.js'
import { CodexMessageStreamer } from '../src/agent/CodexMessageStreamer.js'
import { CodexioMetadata } from '../src/component/CodexioMetadata.js'
import { CommandExecutor, parseCommandInput } from '../src/controller/CommandExecutor.js'
import { FeishuMessageSender } from '../src/channel/FeishuMessageSender.js'
import { parseFeishuMessageText } from '../src/channel/FeishuMessageContent.js'
import { ChannelOutputManager } from '../src/channel/ChannelOutputManager.js'
import { ThreadBinder } from '../src/value/ThreadBinder.js'
import { Logger } from '../src/component/Logger.js'
import { parseMarkdownFileReferences, renderMarkdownHtml } from '../src/util/Markdown.js'
import { FileStore } from '../src/component/FileStore.js'
import { Configer, diffConfigPaths } from '../src/component/Configer.js'
import { ConfigSchema, createDefaultConfig, normalizeWorkspacePath, validateCodexioConfig } from '../src/value/ConfigDefinition.js'
import { Result } from '../src/value/Result.js'
import { TestAgent } from './TestAgent.js'
import type { CodexioConfig } from '../src/value/ConfigDefinition.js'
import type { Message } from '../src/value/Message.js'
import type { Agent } from '../src/agent/Agent.js'

const testMetadata = new CodexioMetadata()
const codexioRootPath = testMetadata.rootPath
const testCodexHomePath = join(codexioRootPath, '.codexio', 'codex')
const testCodexConfigPath = join(testCodexHomePath, 'config.toml')

describe('core', () => {
  it('writes daily persistent log file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-log-'))
    Logger.configure({
      logDir: dir,
      consoleEnabled: false
    })
    try {
      Logger.info('server started', {
        port: 8787
      })
      Logger.error('server failed', new Error('boom'))
      await Logger.flush()
      const files = await readdir(dir)
      const file = files.find((name) => /^\d{4}-\d{2}-\d{2}\.log$/.test(name))
      expect(file).toBeDefined()
      const text = await readFile(join(dir, file ?? ''), 'utf8')
      const lines = text.trim().split('\n').map((line) => JSON.parse(line) as {
        level: string
        message: string
        data?: unknown
        error?: {
          message?: string
        }
      })
      expect(lines[0]).toMatchObject({
        level: 'info',
        message: 'server started',
        data: {
          port: 8787
        }
      })
      expect(lines[1]).toMatchObject({
        level: 'error',
        message: 'server failed',
        error: {
          message: 'boom'
        }
      })
    } finally {
      Logger.reset()
    }
  })

  it('cleans log files older than retention days', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-log-'))
    Logger.configure({
      logDir: dir,
      consoleEnabled: false
    })
    try {
      await writeFile(join(dir, '2000-01-01.log'), 'old\n', 'utf8')
      await writeFile(join(dir, '2999-01-01.log'), 'new\n', 'utf8')
      await writeFile(join(dir, 'keep.txt'), 'keep\n', 'utf8')
      const result = await Logger.cleanup(30)
      expect(result.deleted).toBe(1)
      const files = await readdir(dir)
      expect(files).not.toContain('2000-01-01.log')
      expect(files).toContain('2999-01-01.log')
      expect(files).toContain('keep.txt')
    } finally {
      Logger.reset()
    }
  })

  it('test agent sends received text', async () => {
    const outbound: string[] = []
    const agent = new TestAgent(async (message) => {
      outbound.push(message.text)
    })
    await agent.start()
    await agent.receive({
      ioThreadId: 'test-thread',
      text: 'hello'
    })
    expect(outbound).toEqual([
      'test: hello'
    ])
  })

  it('imports local images through file store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-file-store-'))
    const source = join(dir, 'source.png')
    await writeFile(source, pngBytes())
    const store = new FileStore(new CodexioMetadata({
      rootPath: dir
    }))

    const file = await store.importPath(source)
    const saved = await readFile(file.path)

    expect(file).toMatchObject({
      mime: 'image/png',
      name: 'source.png',
      size: pngBytes().length,
      url: expect.stringMatching(/^\/api\/files\//)
    })
    expect(file.sha256).toHaveLength(64)
    expect(saved.equals(pngBytes())).toBe(true)
  })

  it('imports generic files through file store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-file-store-generic-'))
    const store = new FileStore(new CodexioMetadata({
      rootPath: dir
    }))

    const file = await store.importBuffer({
      buffer: Buffer.from('hello file', 'utf8'),
      name: 'note.txt',
      mime: 'text/plain'
    })
    const saved = await readFile(file.path, 'utf8')

    expect(file).toMatchObject({
      mime: 'text/plain',
      name: 'note.txt',
      size: 'hello file'.length,
      url: expect.stringMatching(/^\/api\/files\//)
    })
    expect(file.path.endsWith('.txt')).toBe(true)
    expect(file.sha256).toHaveLength(64)
    expect(saved).toBe('hello file')
  })

  it('binds platform thread identities to one io thread', () => {
    const binder = new ThreadBinder()

    const ioThreadId = binder.resolveOrCreate([
      ' chat:thread:omt_1 ',
      'chat:message:om_1'
    ])
    const same = binder.resolveOrCreate([
      'chat:message:om_1',
      'chat:message:om_2'
    ])

    expect(same).toBe(ioThreadId)
    expect(binder.resolve(['chat:message:om_2'])).toBe(ioThreadId)
    expect(() => binder.resolveOrCreate([])).toThrow('thread binding key is required')
  })

  it('selected agent exposes login lifecycle', async () => {
    const manager = await createAgentManager(ConfigSchema.parse({
      agents: {
        codex: {
          enabled: false
        },
        claude: {
          enabled: true
        }
      }
    }), createOutputManager(), new TestAgent(async () => {}))
    expect(manager.status().status).toBe('idle')
    await expect(manager.login()).resolves.toBeUndefined()
  })

  it('agent manager acknowledges user message before agent work', async () => {
    const outbound: string[] = []
    const manager = await createAgentManager(ConfigSchema.parse({
      agents: {
        codex: {
          enabled: false
        },
        claude: {
          enabled: true
        }
      }
    }), createOutputManager({
      sendSystem: async (text) => {
        outbound.push(text)
        return Result.success(null)
      }
    }), new TestAgent(async (message) => {
      outbound.push(message.text)
    }))
    const result = await manager.receiveMessage({
      ioThreadId: 'test-thread',
      text: 'hello'
    })
    expect(result.isFailed).toBe(false)
    expect(outbound).toEqual([
      expect.any(String),
      'test: hello'
    ])
  })

  it('agent manager serializes concurrent user messages', async () => {
    const outbound: string[] = []
    const manager = await createAgentManager(ConfigSchema.parse({
      agents: {
        codex: {
          enabled: false
        },
        claude: {
          enabled: true
        }
      }
    }), createOutputManager({
      sendSystem: async (text) => {
        outbound.push(text)
        await new Promise((resolve) => {
          setTimeout(resolve, 10)
        })
        return Result.success(null)
      }
    }), new TestAgent(async (message) => {
      outbound.push(message.text)
    }))
    const [first, second] = await Promise.all([
      manager.receiveMessage({
        ioThreadId: 'test-thread',
        text: 'first'
      }),
      manager.receiveMessage({
        ioThreadId: 'test-thread',
        text: 'second'
      })
    ])
    expect(first.isFailed).toBe(false)
    expect(second.isFailed).toBe(false)
    expect(outbound).toEqual([
      expect.any(String),
      'test: first',
      expect.any(String),
      'test: second'
    ])
  })

  it('agent manager does not queue user messages behind an active login flow', async () => {
    const systemMessages: string[] = []
    const manager = await createAgentManager(ConfigSchema.parse({
      agents: {
        codex: {
          enabled: true
        },
        claude: {
          enabled: false
        }
      }
    }), createOutputManager({
      sendSystem: async (text) => {
        systemMessages.push(text)
        return Result.success(null)
      }
    }), {
      type: 'codex',
      async login(): Promise<void> {},
      async start(): Promise<void> {
        throw new AgentLoginInProgressError('请先完成 Codex 登录。')
      },
      async receive(): Promise<void> {},
      async clear(): Promise<void> {},
      async stop(): Promise<void> {}
    })

    const first = await manager.receiveMessage({
      ioThreadId: 'test-thread',
      text: 'first'
    })
    const second = await manager.receiveMessage({
      ioThreadId: 'test-thread',
      text: 'second'
    })

    expect(first.isFailed).toBe(true)
    expect(first.message).toBe('请先完成 Codex 登录。')
    expect(second.isFailed).toBe(true)
    expect(second.message).toBe('请先完成 Codex 登录。')
    expect(manager.status()).toMatchObject({
      status: 'loginRequired',
      message: '请先完成 Codex 登录。'
    })
    expect(systemMessages).toEqual([
      '请先完成 Codex 登录。',
      '请先完成 Codex 登录。'
    ])
  })

  it('agent manager reports startup failures to the current thread', async () => {
    const systemMessages: Array<{
      text: string
      ioThreadId?: string
    }> = []
    const manager = await createAgentManager(ConfigSchema.parse({
      agents: {
        codex: {
          enabled: true
        },
        claude: {
          enabled: false
        }
      }
    }), createOutputManager({
      sendSystem: async (text, _source, ioThreadId) => {
        systemMessages.push({
          text,
          ioThreadId
        })
        return Result.success(null)
      }
    }), {
      type: 'codex',
      async login(): Promise<void> {},
      async start(): Promise<void> {
        throw new Error('Codex 登录请求失败，可能是网络或代理配置无法访问 OpenAI 登录服务。')
      },
      async receive(): Promise<void> {},
      async clear(): Promise<void> {},
      async stop(): Promise<void> {}
    })

    const result = await manager.receiveMessage({
      ioThreadId: 'test-thread',
      text: 'hello'
    })

    expect(result.isFailed).toBe(true)
    expect(systemMessages).toEqual([
      {
        text: 'Codex 登录请求失败，可能是网络或代理配置无法访问 OpenAI 登录服务。',
        ioThreadId: 'test-thread'
      }
    ])
  })

  it('agents apply proxy env internally', async () => {
    const env = createProcessEnv(
      testCodexHomePath,
      testCodexConfigPath,
      'http://proxy.local:8080',
      [
        'localhost',
        '127.0.0.1',
        '::1'
      ],
      {
        CUSTOM_RUNTIME_URL: 'http://127.0.0.1:8787',
        CUSTOM_RUNTIME_TOKEN: 'runtime-token'
      }
    )
    expect(env.HTTP_PROXY).toBe('http://proxy.local:8080')
    expect(env.HTTPS_PROXY).toBe('http://proxy.local:8080')
    expect(env.ALL_PROXY).toBe('http://proxy.local:8080')
    expect(env.NO_PROXY).toContain('127.0.0.1')
    expect(env.NO_PROXY).toContain('localhost')
    expect(env.no_proxy).toBe(env.NO_PROXY)
    expect(env.CUSTOM_RUNTIME_URL).toBe('http://127.0.0.1:8787')
    expect(env.CUSTOM_RUNTIME_TOKEN).toBe('runtime-token')
    expect(env.CODEX_HOME).toContain('.codexio')
    expect(env.CODEX_HOME).toContain('codex')
    expect(existsSync(testCodexHomePath)).toBe(true)
    const codexConfig = readFileSync(testCodexConfigPath, 'utf8')
    expect(codexConfig).toContain('[shell_environment_policy]')
    expect(codexConfig).toContain('"HTTPS_PROXY" = "http://proxy.local:8080"')
    expect(codexConfig).toContain('"NO_PROXY" = "localhost,127.0.0.1,::1"')
    expect(codexConfig).toContain('"CUSTOM_RUNTIME_URL" = "http://127.0.0.1:8787"')
    expect(codexConfig).toContain('"CUSTOM_RUNTIME_TOKEN" = "runtime-token"')
  })

  it('resolves public codex command by default', () => {
    const command = createCodexCommand(undefined, [
      'app-server',
      '--stdio'
    ])

    expect(command).toEqual({
      command: 'codex',
      args: [
        'app-server',
        '--stdio'
      ]
    })
  })

  it('resolves bundled codex command when bundled is enabled', () => {
    const command = createCodexCommand(true, [
      'app-server',
      '--stdio'
    ])

    expect(command.command).toBe(process.execPath)
    expect(command.args.at(-2)).toBe('app-server')
    expect(command.args.at(-1)).toBe('--stdio')
    expect(command.args[0]).toContain('@openai')
  })

  it('preserves public codex home when bundled is disabled', () => {
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = 'C:\\Users\\test\\.codex'
    try {
      const command = createCodexCommand(false, [
        'app-server',
        '--stdio'
      ])
      const env = createProcessEnv()

      expect(command).toEqual({
        command: 'codex',
        args: [
          'app-server',
          '--stdio'
        ]
      })
      expect(env.CODEX_HOME).toBe('C:\\Users\\test\\.codex')
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME
      } else {
        process.env.CODEX_HOME = previousCodexHome
      }
    }
  })

  it('parses chat commands with dollar and yuan prefixes', () => {
    expect(parseCommandInput('$ clear')).toEqual({
      type: 'command',
      name: 'clear',
      args: []
    })
    expect(parseCommandInput('￥clear')).toEqual({
      type: 'command',
      name: 'clear',
      args: []
    })
    expect(parseCommandInput('$ update')).toEqual({
      type: 'command',
      name: 'update',
      args: []
    })
    expect(parseCommandInput('￥help')).toEqual({
      type: 'command',
      name: 'help',
      args: []
    })
    expect(parseCommandInput('￥?')).toEqual({
      type: 'command',
      name: '?',
      args: []
    })
    expect(parseCommandInput('hello')).toEqual({
      type: 'message',
      text: 'hello'
    })
  })

  it('command executor forwards ordinary text with channel thread id', async () => {
    const received: Array<{ ioThreadId: string, text: string }> = []
    const executor = new CommandExecutor(createOutputManager(), {
      receiveMessage: async (input: { ioThreadId: string, text: string }) => {
        received.push(input)
        return Result.success({})
      },
      clear: async () => Result.success({
        action: 'clear'
      })
    } as unknown as AgentManager, {
      update: async () => Result.success('updated')
    })

    const createdAt = Date.now()
    const result = await executor.receive({
      role: 'user',
      ioThreadId: 'io-thread',
      text: 'hello',
      createdAt,
      source: 'web'
    })

    expect(result.isFailed).toBe(false)
    expect(result.data?.ioThreadId).toBe('io-thread')
    expect(received[0]).toMatchObject({
      role: 'user',
      ioThreadId: 'io-thread',
      text: 'hello',
      createdAt,
      source: 'web'
    })
  })

  it('command executor sends system feedback around update command', async () => {
    const systemMessages: string[] = []
    const executor = new CommandExecutor(createOutputManager({
      sendSystem: async (text: string) => {
        systemMessages.push(text)
        return Result.success(null)
      }
    }), {
      receiveMessage: async () => Result.success({}),
      clear: async () => Result.success({
        action: 'clear'
      })
    } as unknown as AgentManager, {
      update: async () => Result.success('Codexio 0.4.2 更新包已准备完成，正在安装并重启。')
    })

    const result = await executor.receive({
      role: 'user',
      ioThreadId: 'io-thread',
      text: '$update',
      createdAt: Date.now(),
      source: 'web'
    })

    expect(result.isFailed).toBe(false)
    expect(result.data).toEqual({
      action: 'update'
    })
    expect(systemMessages).toEqual([
      '正在执行：$update\n正在检查更新；如果发现新版本会自动安装并重启，如果已是最新版本会直接提示。',
      '已执行：$update\nCodexio 0.4.2 更新包已准备完成，正在安装并重启。'
    ])
  })

  it('command executor reports when update finds no newer version', async () => {
    const systemMessages: string[] = []
    const executor = new CommandExecutor(createOutputManager({
      sendSystem: async (text: string) => {
        systemMessages.push(text)
        return Result.success(null)
      }
    }), {
      receiveMessage: async () => Result.success({}),
      clear: async () => Result.success({
        action: 'clear'
      })
    } as unknown as AgentManager, {
      update: async () => Result.success('Codexio 已是最新版本 0.4.2。')
    })

    const result = await executor.receive({
      role: 'user',
      ioThreadId: 'io-thread',
      text: '$update',
      createdAt: Date.now(),
      source: 'web'
    })

    expect(result.isFailed).toBe(false)
    expect(result.data).toEqual({
      action: 'update'
    })
    expect(systemMessages).toEqual([
      '正在执行：$update\n正在检查更新；如果发现新版本会自动安装并重启，如果已是最新版本会直接提示。',
      '已执行：$update\nCodexio 已是最新版本 0.4.2。'
    ])
  })

  it('codex agent injects codexio runtime instruction', async () => {
    const requests: Array<{
      method: string
      params: unknown
    }> = []
    const agent = createCodexAgent({
      config: ConfigSchema.parse({
        server: {
          token: 'test-token'
        }
      }),
      appServer: {
        async start(): Promise<void> {},
        async request(method: string, params: unknown): Promise<unknown> {
          requests.push({
            method,
            params
          })
          if (method === 'account/read') {
            return {
              account: {}
            }
          }
          if (method === 'turn/start') {
            return {
              turn: {
                id: 'turn-1'
              }
            }
          }
          return {
            thread: {
              id: 'thread-1'
            }
          }
        },
        async waitForNotification(): Promise<void> {},
        async stop(): Promise<void> {}
      }
    })
    await agent.start()
    await agent.receive({
      ioThreadId: 'io-thread',
      text: 'hello'
    })
    const threadStart = requests.find((request) => request.method === 'thread/start')
    expect(threadStart?.params).toMatchObject({
      ephemeral: false,
      developerInstructions: expect.stringContaining('Codexio Runtime')
    })
    const developerInstructions = (threadStart?.params as Record<string, unknown>).developerInstructions
    expect(developerInstructions).toContain('[日志](C:\\tmp\\result.txt)')
    expect(developerInstructions).toContain('[截图](C:\\tmp\\preview.png)')
    expect(developerInstructions).toContain('do not use Markdown image syntax')
    expect(developerInstructions).not.toContain('${ioThreadId}')
    expect(developerInstructions).not.toContain('Invoke-RestMethod')
  })

  it('codex agent does not create a thread during startup', async () => {
    const requests: Array<{
      method: string
      params: unknown
    }> = []
    const agent = createCodexAgent({
      appServer: createCodexAppServerMock(requests)
    })

    await agent.start()

    expect(requests.map((request) => request.method)).toEqual([
      'account/read'
    ])
  })

  it('codex agent creates a thread for the received codexio thread id', async () => {
    const requests: Array<{
      method: string
      params: unknown
    }> = []
    const agent = createCodexAgent({
      appServer: createCodexAppServerMock(requests)
    })

    await agent.start()
    await agent.receive({
      ioThreadId: 'io-thread',
      text: 'hello'
    })

    expect(requests.map((request) => request.method)).toEqual([
      'account/read',
      'thread/start',
      'turn/start'
    ])
    expect(requests[1].params).toMatchObject({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      ephemeral: false
    })
    expect(requests[2].params).toMatchObject({
      threadId: 'thread-1'
    })
  })

  it('codex agent creates independent agent threads for different codexio thread ids', async () => {
    const requests: Array<{
      method: string
      params: unknown
    }> = []
    const agent = createCodexAgent({
      appServer: createCodexAppServerMock(requests)
    })

    await agent.start()
    await agent.receive({
      ioThreadId: 'thread-a',
      text: 'first'
    })
    await agent.receive({
      ioThreadId: 'thread-b',
      text: 'second'
    })

    expect(requests.map((request) => request.method)).toEqual([
      'account/read',
      'thread/start',
      'turn/start',
      'thread/start',
      'turn/start'
    ])
    expect(requests[2].params).toMatchObject({
      threadId: 'thread-1'
    })
    expect(requests[4].params).toMatchObject({
      threadId: 'thread-2'
    })
  })

  it('codex agent clear recreates the selected codexio thread', async () => {
    const requests: Array<{
      method: string
      params: unknown
    }> = []
    const agent = createCodexAgent({
      appServer: createCodexAppServerMock(requests)
    })

    await agent.start()
    await agent.receive({
      ioThreadId: 'io-thread',
      text: 'first'
    })
    await agent.clear('io-thread')

    expect(requests.map((request) => request.method)).toEqual([
      'account/read',
      'thread/start',
      'turn/start',
      'turn/interrupt',
      'thread/start'
    ])
  })

  it('codex agent steers the active app-server turn', async () => {
    const requests: Array<{
      method: string
      params: unknown
    }> = []
    let threadCount = 0
    const appServer = {
      async start(): Promise<void> {},
      async request(method: string, params: unknown): Promise<unknown> {
        requests.push({
          method,
          params
        })
        if (method === 'account/read') {
          return {
            account: {}
          }
        }
        if (method === 'thread/start') {
          threadCount += 1
          return {
            thread: {
              id: `thread-${threadCount}`
            }
          }
        }
        if (method === 'turn/start') {
          return {
            turn: {
              id: 'turn-1'
            }
          }
        }
        if (method === 'turn/steer') {
          return {
            turnId: 'turn-1'
          }
        }
        return {}
      },
      async waitForNotification(): Promise<void> {},
      async stop(): Promise<void> {}
    }
    const agent = createCodexAgent({
      appServer
    })
    await agent.start()
    await agent.receive({
      ioThreadId: 'io-thread',
      text: 'first'
    })
    await agent.receive({
      ioThreadId: 'io-thread',
      text: 'second'
    })
    await agent.clear('io-thread')
    expect(requests.map((request) => request.method)).toEqual([
      'account/read',
      'thread/start',
      'turn/start',
      'turn/steer',
      'turn/interrupt',
      'thread/start'
    ])
    expect(requests[1].params).toMatchObject({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      ephemeral: false
    })
    expect(requests[3].params).toMatchObject({
      threadId: 'thread-1',
      expectedTurnId: 'turn-1'
    })
  })

  it('codex agent sends local image inputs to app-server', async () => {
    const requests: Array<{
      method: string
      params: unknown
    }> = []
    const agent = createCodexAgent({
      appServer: createCodexAppServerMock(requests)
    })
    await agent.start()
    await agent.receive({
      ioThreadId: 'io-thread',
      text: 'look',
      files: [
        {
          id: 'file-1',
          mime: 'image/png',
          name: 'a.png',
          size: 1,
          sha256: '0'.repeat(64),
          path: 'C:\\tmp\\a.png',
          url: '/api/files/file-1'
        }
      ]
    })

    expect(requests.find((request) => request.method === 'turn/start')?.params).toMatchObject({
      input: [
        {
          type: 'text',
          text: 'look',
          text_elements: []
        },
        {
          type: 'localImage',
          path: 'C:\\tmp\\a.png',
          detail: 'auto'
        }
      ]
    })
  })

  it('codex agent sends generic file inputs as local paths', async () => {
    const requests: Array<{
      method: string
      params: unknown
    }> = []
    const agent = createCodexAgent({
      appServer: createCodexAppServerMock(requests)
    })
    await agent.start()
    await agent.receive({
      ioThreadId: 'io-thread',
      text: 'read this',
      files: [
        {
          id: 'file-1',
          mime: 'text/plain',
          name: 'note.txt',
          size: 10,
          sha256: '0'.repeat(64),
          path: 'C:\\tmp\\note.txt',
          url: '/api/files/file-1'
        }
      ]
    })

    expect(requests.find((request) => request.method === 'turn/start')?.params).toMatchObject({
      input: [
        {
          type: 'text',
          text: 'read this\n\nFiles:\nC:\\tmp\\note.txt',
          text_elements: []
        }
      ]
    })
  })

  it('codex agent starts device-code login without waiting for completion when account is missing', async () => {
    const outbound: string[] = []
    const requests: Array<{
      method: string
      params: unknown
    }> = []
    const appServer = {
      async start(): Promise<void> {},
      async request(method: string, params: unknown): Promise<unknown> {
        requests.push({
          method,
          params
        })
        if (method === 'account/read') {
          return {
            account: null,
            requiresOpenaiAuth: true
          }
        }
        if (method === 'account/login/start') {
          return {
            type: 'chatgptDeviceCode',
            verificationUrl: 'https://login.example.test/device',
            userCode: 'ABCD-EFGH'
          }
        }
        if (method === 'thread/start') {
          return {
            thread: {
              id: 'thread-1'
            }
          }
        }
        return {}
      },
      async waitForNotification(method: string): Promise<void> {
        expect(method).toBe('account/login/completed')
        await new Promise(() => {})
      },
      async stop(): Promise<void> {}
    }
    const agent = createCodexAgent({
      send: async (message) => {
        outbound.push(message.text)
      },
      appServer
    })
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await expect(agent.start('login-thread')).rejects.toThrow(AgentLoginInProgressError)
    } finally {
      stdout.mockRestore()
    }
    expect(requests.map((request) => request.method)).toEqual([
      'account/read',
      'account/login/start'
    ])
    expect(requests[0].params).toEqual({
      refreshToken: true
    })
    expect(requests[1].params).toEqual({
      type: 'chatgptDeviceCode'
    })
    expect(outbound[0]).toContain('https://login.example.test/device')
    expect(outbound[0]).toContain('ABCD-EFGH')
  })

  it('codex agent starts device-code login when account refresh is invalidated', async () => {
    const outbound: string[] = []
    const requests: Array<{
      method: string
      params: unknown
    }> = []
    const appServer = {
      async start(): Promise<void> {},
      async request(method: string, params: unknown): Promise<unknown> {
        requests.push({
          method,
          params
        })
        if (method === 'account/read') {
          throw new Error('401 Unauthorized: refresh_token_invalidated')
        }
        if (method === 'account/login/start') {
          return {
            type: 'chatgptDeviceCode',
            verificationUrl: 'https://login.example.test/device',
            userCode: 'WXYZ-1234'
          }
        }
        return {}
      },
      async waitForNotification(): Promise<void> {
        await new Promise(() => {})
      },
      async stop(): Promise<void> {}
    }
    const agent = createCodexAgent({
      send: async (message) => {
        outbound.push(message.text)
      },
      appServer
    })
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await expect(agent.start('login-thread')).rejects.toThrow(AgentLoginInProgressError)
    } finally {
      stdout.mockRestore()
    }

    expect(requests.map((request) => request.method)).toEqual([
      'account/read',
      'account/login/start'
    ])
    expect(requests[0].params).toEqual({
      refreshToken: true
    })
    expect(outbound[0]).toContain('Codex 登录已失效，请重新登录。')
    expect(outbound[0]).toContain('https://login.example.test/device')
    expect(outbound[0]).toContain('WXYZ-1234')
  })

  it('codex agent explains device-code network failures', async () => {
    const appServer = {
      async start(): Promise<void> {},
      async request(method: string): Promise<unknown> {
        if (method === 'account/read') {
          return {}
        }
        if (method === 'account/login/start') {
          throw new CodexAppServerRequestError(403, 'failed to request device code: device code request failed with status 403 Forbidden')
        }
        return {}
      },
      async waitForNotification(): Promise<void> {},
      async stop(): Promise<void> {}
    }
    const agent = createCodexAgent({
      appServer
    })

    await expect(agent.start('login-thread')).rejects.toThrow([
      'Codex 登录请求失败，可能是网络或代理配置无法访问 OpenAI 登录服务。',
      '请在 config.yaml 开启或修正 proxy 配置后重试。',
      '原始错误：failed to request device code: device code request failed with status 403 Forbidden'
    ].join('\n'))
  })

  it('codex agent turns runtime token invalidation into one login flow', async () => {
    const outbound: string[] = []
    const requests: Array<{
      method: string
      params: unknown
    }> = []
    const appServer = {
      async start(): Promise<void> {},
      async request(method: string, params: unknown): Promise<unknown> {
        requests.push({
          method,
          params
        })
        if (method === 'account/read') {
          return {
            account: {}
          }
        }
        if (method === 'account/login/start') {
          return {
            type: 'chatgptDeviceCode',
            verificationUrl: 'https://login.example.test/device',
            userCode: 'RUNTIME-1'
          }
        }
        if (method === 'thread/start') {
          return {
            thread: {
              id: 'thread-1'
            }
          }
        }
        return {}
      },
      async waitForNotification(): Promise<void> {
        await new Promise(() => {})
      },
      async stop(): Promise<void> {}
    }
    const agent = createCodexAgent({
      send: async (message) => {
        outbound.push(message.text)
      },
      appServer
    })
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await agent.start()
      const handleNotification = (agent as unknown as {
        handleNotification: (method: string, params: unknown) => Promise<void>
      }).handleNotification.bind(agent)
      await handleNotification('error', {
        error: {
          message: 'Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.',
          code: 'refresh_token_invalidated'
        }
      })
      await handleNotification('error', {
        error: {
          message: 'Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.',
          code: 'refresh_token_invalidated'
        }
      })
    } finally {
      stdout.mockRestore()
    }

    expect(requests.map((request) => request.method)).toEqual([
      'account/read',
      'account/login/start'
    ])
    expect(outbound).toHaveLength(1)
    expect(outbound[0]).toContain('RUNTIME-1')
    expect(outbound[0]).not.toContain('Your access token could not be refreshed')
  })

  it('codex agent restarts after device-code login completes', async () => {
    const outbound: string[] = []
    const requests: Array<{
      method: string
      params: unknown
    }> = []
    let starts = 0
    let stops = 0
    let completeLogin: (() => void) | undefined
    const appServer = {
      async start(): Promise<void> {
        starts += 1
      },
      async request(method: string, params: unknown): Promise<unknown> {
        requests.push({
          method,
          params
        })
        if (method === 'account/read') {
          return {
            account: {}
          }
        }
        if (method === 'account/login/start') {
          return {
            type: 'chatgptDeviceCode',
            verificationUrl: 'https://login.example.test/device',
            userCode: 'DONE-1'
          }
        }
        if (method === 'thread/start') {
          const count = requests.filter((request) => request.method === 'thread/start').length
          return {
            thread: {
              id: `thread-${count}`
            }
          }
        }
        return {}
      },
      async waitForNotification(): Promise<void> {
        await new Promise<void>((resolve) => {
          completeLogin = resolve
        })
      },
      async stop(): Promise<void> {
        stops += 1
      }
    }
    const agent = createCodexAgent({
      send: async (message) => {
        outbound.push(message.text)
      },
      appServer
    })
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await agent.start()
      const handleNotification = (agent as unknown as {
        handleNotification: (method: string, params: unknown) => Promise<void>
      }).handleNotification.bind(agent)
      await handleNotification('error', {
        error: {
          message: 'Your session has ended. Please log in again.',
          code: 'refresh_token_invalidated'
        }
      })
      completeLogin?.()
      await waitFor(() => requests.filter((request) => request.method === 'account/read').length === 2)
    } finally {
      stdout.mockRestore()
    }

    expect(starts).toBe(2)
    expect(stops).toBe(1)
    expect(requests.map((request) => request.method)).toEqual([
      'account/read',
      'account/login/start',
      'account/read'
    ])
    expect(outbound).toContain('Codex 登录已完成。')
  })

  it('codex app-server ignores malformed JSON lines and times out pending requests', async () => {
    const stderr: string[] = []
    const script = [
      'const readline = require("node:readline");',
      'const rl = readline.createInterface({ input: process.stdin });',
      'process.stdout.write("not-json\\n");',
      'rl.on("line", (line) => {',
      '  const message = JSON.parse(line);',
      '  if (message.method === "initialize") {',
      '    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");',
      '  }',
      '});'
    ].join('\n')
    const server = new CodexAppServer({
      command: process.execPath,
      args: [
        '-e',
        script
      ],
      cwd: '.',
      env: process.env,
      metadata: testMetadata,
      requestTimeoutMs: 500,
      onNotification: () => {},
      onStderr: (data) => {
        stderr.push(data.toString('utf8'))
      }
    })
    await server.start()
    await expect(server.request('never/replies', {})).rejects.toThrow('codex app-server request timed out: never/replies')
    expect(stderr.join('')).toContain('codex app-server sent invalid JSON')
    await server.stop()
  })

  it('codex app-server preserves JSON-RPC error codes', async () => {
    const script = [
      'const readline = require("node:readline");',
      'const rl = readline.createInterface({ input: process.stdin });',
      'rl.on("line", (line) => {',
      '  const message = JSON.parse(line);',
      '  if (message.method === "initialize") {',
      '    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");',
      '    return;',
      '  }',
      '  process.stdout.write(JSON.stringify({ id: message.id, error: { code: 401, message: "unauthorized" } }) + "\\n");',
      '});'
    ].join('\n')
    const server = new CodexAppServer({
      command: process.execPath,
      args: [
        '-e',
        script
      ],
      cwd: '.',
      env: process.env,
      metadata: testMetadata,
      requestTimeoutMs: 500,
      onNotification: () => {},
      onStderr: () => {}
    })
    await server.start()
    const error = await server.request('account/read', {}).catch((caught) => caught)
    expect(error).toBeInstanceOf(CodexAppServerRequestError)
    expect(error).toMatchObject({
      code: 401,
      message: 'unauthorized'
    })
    await server.stop()
  })

  it('codex app-server releases notification waiters when stopped', async () => {
    const script = [
      'const readline = require("node:readline");',
      'const rl = readline.createInterface({ input: process.stdin });',
      'rl.on("line", (line) => {',
      '  const message = JSON.parse(line);',
      '  if (message.method === "initialize") {',
      '    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");',
      '  }',
      '});'
    ].join('\n')
    const server = new CodexAppServer({
      command: process.execPath,
      args: [
        '-e',
        script
      ],
      cwd: '.',
      env: process.env,
      metadata: testMetadata,
      requestTimeoutMs: 500,
      onNotification: () => {},
      onStderr: () => {}
    })
    await server.start()
    const waiter = server.waitForNotification('account/login/completed')
    const waiterExpectation = expect(waiter).rejects.toThrow('codex app-server stopped')
    await server.stop()
    await waiterExpectation
  })

  it('defaults workspace to codexio local workspace directory', () => {
    const config = createDefaultConfig(join(codexioRootPath, '.codexio', 'workspace'))
    expect(config.workspace.path).toContain(join('.codexio', 'workspace'))
  })

  it('leaves workspace creation to agent runtime when initializing new config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-'))
    const path = join(dir, 'config.yaml')
    const config = await createTestConfiger(path).init()
    expect(existsSync(config.workspace.path)).toBe(false)
  })

  it('agent manager creates workspace before starting agent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-agent-workspace-'))
    const workspace = join(dir, 'workspace')
    const config = ConfigSchema.parse({
      workspace: {
        path: workspace
      }
    })
    const agent = new TestAgent(async () => {})
    const manager = await createAgentManager(config, createOutputManager(), agent)

    const started = await manager.start()

    expect(started.isFailed).toBe(false)
    expect(existsSync(workspace)).toBe(true)
    await manager.stop()
  })

  it('configer patches config file and notifies after successful write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-configer-'))
    const workspace = join(dir, 'workspace')
    await mkdir(workspace)
    const path = join(dir, 'config.yaml')
    await writeFile(path, [
      'server:',
      '  host: 127.0.0.1',
      '  port: 8787',
      '  token: test-token',
      'agents:',
      '  codex:',
      '    enabled: true',
      '  claude:',
      '    enabled: false',
      'channels:',
      '  web:',
      '    enabled: true',
      'workspace:',
      `  path: ${workspace}`
    ].join('\n'), 'utf8')
    const configer = createTestConfiger(path)
    const changes: Array<{
      previousPort: number
      currentPort: number
      paths: string[]
    }> = []
    configer.subscribe('proxy.port', (change) => {
      changes.push({
        previousPort: change.previousValue,
        currentPort: change.currentValue,
        paths: change.paths
      })
    })

    const change = await configer.patch({
      proxy: {
        enabled: true,
        host: '127.0.0.1',
        port: 7891
      }
    } as Partial<CodexioConfig>)
    const text = await readFile(path, 'utf8')

    expect(change.paths).toEqual([
      'proxy.enabled',
      'proxy.port'
    ])
    expect(text).toContain('port: 7891')
    expect(changes).toEqual([
      {
        previousPort: 7890,
        currentPort: 7891,
        paths: [
          'proxy.enabled',
          'proxy.port'
        ]
      }
    ])

    await configer.patch({
      proxy: {
        enabled: true,
        host: '127.0.0.1',
        port: 7891
      }
    } as Partial<CodexioConfig>)
    expect(changes).toHaveLength(1)
  })

  it('configer selected subscription only receives selected config changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-configer-'))
    const workspace = join(dir, 'workspace')
    await mkdir(workspace)
    const path = join(dir, 'config.yaml')
    await writeFile(path, [
      'server:',
      '  host: 127.0.0.1',
      '  port: 8787',
      '  token: test-token',
      'agents:',
      '  codex:',
      '    enabled: true',
      '  claude:',
      '    enabled: false',
      'channels:',
      '  web:',
      '    enabled: true',
      '  feishu:',
      '    enabled: false',
      '    appId: app-1',
      '    appSecret: secret-1',
      '    chatId: chat-1',
      '    ws: wss://old.example.test',
      'workspace:',
      `  path: ${workspace}`
    ].join('\n'), 'utf8')
    const configer = createTestConfiger(path)
    const feishuChanges: Array<{
      previousSecret: string | undefined
      currentSecret: string | undefined
    }> = []
    configer.subscribe('channels.feishu', (change) => {
      feishuChanges.push({
        previousSecret: change.previousValue?.appSecret,
        currentSecret: change.currentValue?.appSecret
      })
    })

    await configer.patch({
      proxy: {
        enabled: true,
        host: '127.0.0.1',
        port: 7891
      }
    } as Partial<CodexioConfig>)
    expect(feishuChanges).toEqual([])

    await configer.patch({
      channels: {
        feishu: {
          enabled: false,
          appId: 'app-1',
          appSecret: 'secret-2',
          chatId: 'chat-1',
          ws: 'wss://old.example.test'
        }
      }
    } as Partial<CodexioConfig>)
    expect(feishuChanges).toEqual([
      {
        previousSecret: 'secret-1',
        currentSecret: 'secret-2'
      }
    ])
  })

  it('diffs config paths by leaf value', () => {
    expect(diffConfigPaths({
      proxy: {
        enabled: false,
        port: 7890
      }
    }, {
      proxy: {
        enabled: true,
        port: 7890
      }
    })).toEqual([
      'proxy.enabled'
    ])
  })

  it('resolves packaged managed workspace without creating it when loading default release config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-package-'))
    const path = join(dir, '.codexio', 'config.yaml')
    await mkdir(join(dir, '.codexio'))
    await writeFile(path, [
      'workspace:',
      '  path: workspace'
    ].join('\n'), 'utf8')

    const configer = createTestConfiger(path)

    expect(await configer.get('workspace.path')).toBe(join(dir, '.codexio', 'workspace'))
    expect(existsSync(await configer.get('workspace.path'))).toBe(false)
  })

  it('expands home workspace paths', () => {
    expect(normalizeWorkspacePath('~/Desktop')).toBe(join(homedir(), 'Desktop'))
  })

  it('allows missing workspace and validates enabled channel config before startup', () => {
    const missingWorkspace = join(tmpdir(), 'codexio-missing-workspace')
    const config = ConfigSchema.parse({
      server: {
        token: 'test-token'
      },
      agents: {
        codex: {
          enabled: false
        },
        claude: {
          enabled: true
        }
      },
      channels: {
        feishu: {
          enabled: true,
          appId: '',
          appSecret: '',
          chatId: ''
        }
      },
      workspace: {
        path: missingWorkspace
      }
    })
    try {
      validateCodexioConfig(config)
      throw new Error('validation should fail')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain('channels.feishu.appId is required')
      expect(message).toContain('channels.feishu.appSecret is required')
      expect(message).toContain('channels.feishu.chatId is required')
    }
  })

  it('resolves config references before final schema validation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-'))
    const path = join(dir, 'config.yaml')
    const previousToken = process.env.CODEXIO_TEST_TOKEN
    process.env.CODEXIO_TEST_TOKEN = 'env-token'
    await writeFile(path, [
      'server:',
      '  token: ${CODEXIO_TEST_TOKEN}',
      'proxy:',
      '  enabled: true',
      '  host: proxy.local',
      '  port: 8080',
      'workspace:',
      '  path: ${proxy.host}'
    ].join('\n'), 'utf8')
    try {
      const configer = createTestConfiger(path)
      expect(await configer.get('server.token')).toBe('env-token')
      expect(await configer.get('workspace.path')).toBe(join(dir, 'proxy.local'))
    } finally {
      if (previousToken === undefined) {
        delete process.env.CODEXIO_TEST_TOKEN
      } else {
        process.env.CODEXIO_TEST_TOKEN = previousToken
      }
    }
  })

  it('creates default config without proxy enabled', () => {
    const config = createDefaultConfig('C:\\repo')
    expect(config.proxy.enabled).toBe(false)
    expect(config.proxy.host).toBe('127.0.0.1')
    expect(config.proxy.port).toBe(7890)
  })

  it('ships package config with automatic port fallback enabled', async () => {
    const text = await readFile(join(testMetadata.rootPath, 'config.example.yaml'), 'utf8')
    expect(text).toContain('autoPort: true')
  })

  it('loads update base url from config', () => {
    const config = ConfigSchema.parse({
      update: {
        enabled: true,
        baseUrl: 'https://update.example.test'
      }
    })
    expect(config.update.baseUrl).toBe('https://update.example.test')
  })

  it('stores runtime server state under codexio runtime data directory', () => {
    expect(new CodexioMetadata({
      rootPath: 'C:\\app',
      configPath: join('C:\\app', '.codexio', 'config.yaml')
    }).serverStatePath).toBe(join('C:\\app', '.codexio', 'state', 'server.json'))
  })

  it('separates packaged resources from writable runtime data', () => {
    const metadata = new CodexioMetadata({
      rootPath: 'C:\\app\\resources\\app.asar',
      configPath: join('C:\\Users\\test\\AppData\\Roaming\\codexio', 'config.yaml')
    })

    expect(metadata.rootPath).toBe('C:\\app\\resources\\app.asar')
    expect(metadata.dataPath).toBe(join('C:\\Users\\test\\AppData\\Roaming\\codexio'))
    expect(metadata.codexHomePath).toBe(join('C:\\Users\\test\\AppData\\Roaming\\codexio', 'codex'))
    expect(metadata.logPath).toBe(join('C:\\Users\\test\\AppData\\Roaming\\codexio', 'log'))
    expect(metadata.filePath).toBe(join('C:\\Users\\test\\AppData\\Roaming\\codexio', 'file'))
    expect(metadata.serverStatePath).toBe(join('C:\\Users\\test\\AppData\\Roaming\\codexio', 'state', 'server.json'))
  })

  it('packages Codexio as an Electron tray application', () => {
    const packageJson = JSON.parse(readFileSync(join(testMetadata.rootPath, 'package.json'), 'utf8')) as {
      main?: unknown
      scripts?: Record<string, unknown>
      build?: {
        win?: unknown
        nsis?: unknown
      }
      devDependencies?: Record<string, unknown>
    }

    expect(packageJson.main).toBe('dist/CodexioDesktop.js')
    expect(packageJson.scripts?.['package:windows']).toBe('pnpm build && electron-builder --win nsis --x64')
    expect(packageJson.devDependencies?.electron).toBeTruthy()
    expect(packageJson.devDependencies?.['electron-builder']).toBeTruthy()
    expect(packageJson.dependencies?.['electron-updater']).toBeTruthy()
    expect(packageJson.build?.win).toBeTruthy()
    expect(packageJson.build?.nsis).toBeTruthy()
  })

  it('loads channel credentials from config', () => {
    const config = ConfigSchema.parse({
      channels: {
        feishu: {
          enabled: true,
          appId: 'cli_test',
          appSecret: 'secret_test',
          chatId: 'oc_test',
          ws: 'wss://next.firco.cn/ws/proxy/test'
        },
        feishuWebhook: {
          enabled: true,
          url: 'https://open.feishu.cn/webhook/test'
        },
        email: {
          enabled: true,
          user: 'target@example.test',
          agent: {
            imap: {
              host: 'imap.example.test',
              port: 993,
              secure: true,
              user: 'agent@example.test',
              password: 'imap-password',
              mailbox: 'INBOX'
            },
            smtp: {
              host: 'smtp.example.test',
              port: 465,
              secure: true,
              user: 'agent@example.test',
              password: 'smtp-password',
              from: 'agent@example.test'
            }
          }
        }
      }
    })
    expect(config.channels.feishu?.enabled).toBe(true)
    expect(config.channels.feishu?.appId).toBe('cli_test')
    expect(config.channels.feishu?.appSecret).toBe('secret_test')
    expect(config.channels.feishu?.chatId).toBe('oc_test')
    expect(config.channels.feishu?.ws).toBe('wss://next.firco.cn/ws/proxy/test')
    expect(config.channels.feishuWebhook?.url).toBe('https://open.feishu.cn/webhook/test')
    expect(config.channels.email?.user).toBe('target@example.test')
    expect(config.channels.email?.agent.imap.host).toBe('imap.example.test')
    expect(config.channels.email?.agent.smtp.host).toBe('smtp.example.test')
  })

  it('uses empty feishu ws by default', () => {
    const config = createDefaultConfig('C:\\repo')
    expect(config.channels.feishu?.ws).toBe('')
  })

  it('parses feishu text message content without bot mention keys', () => {
    const parsed = parseFeishuMessageText('text', JSON.stringify({
      text: '@_user_1 开始做'
    }), [
      {
        key: '@_user_1'
      }
    ])
    expect(parsed).toEqual({
      success: true,
      text: '开始做'
    })
  })

  it('parses feishu post message content without bot mention keys', () => {
    const parsed = parseFeishuMessageText('post', JSON.stringify({
      zh_cn: {
        content: [
          [
            {
              tag: 'at',
              user_id: 'ou_bot',
              user_name: 'Codexio'
            },
            {
              tag: 'text',
              text: ' 用Vue + Express'
            },
            {
              tag: 'text',
              text: '，用SQLite'
            }
          ],
          [
            {
              tag: 'text',
              text: '开始做'
            }
          ]
        ]
      }
    }), [
      {
        key: '@_user_1'
      }
    ])
    expect(parsed).toEqual({
      success: true,
      text: '用Vue + Express，用SQLite\n开始做'
    })
  })

  it('rejects unsupported feishu message content types', () => {
    const parsed = parseFeishuMessageText('image', JSON.stringify({
      image_key: 'img-test'
    }))
    expect(parsed).toEqual({
      success: false,
      reason: 'unsupported'
    })
  })

  it('appends feishu thread messages through message reply', async () => {
    const createdMessages: unknown[] = []
    const repliedMessages: Array<{
      messageId: string
      msgType: string
      content: string
      replyInThread?: boolean
    }> = []
    const sender = new FeishuMessageSender({
      enabled: true,
      appId: 'app-id',
      appSecret: 'app-secret',
      chatId: 'chat-id'
    }, {
      im: {
        v1: {
          image: {
            create: async () => {
              throw new Error('image upload should not run')
            }
          },
          message: {
            create: async (payload) => {
              createdMessages.push(payload)
            },
            reply: async (payload) => {
              repliedMessages.push({
                messageId: payload.path.message_id,
                msgType: payload.data.msg_type,
                content: payload.data.content,
                replyInThread: payload.data.reply_in_thread
              })
            }
          }
        }
      }
    } as unknown as ConstructorParameters<typeof FeishuMessageSender>[1])
    sender.rememberThread('io-thread', 'om-root')

    const result = await sender.send({
      role: 'agent',
      ioThreadId: 'io-thread',
      source: 'agent',
      text: '继续在同一个话题回复',
      createdAt: Date.now()
    })

    expect(result.isFailed).toBe(false)
    expect(createdMessages).toEqual([])
    expect(repliedMessages).toHaveLength(1)
    expect(repliedMessages[0]).toMatchObject({
      messageId: 'om-root',
      msgType: 'post',
      replyInThread: true
    })
    expect(JSON.parse(repliedMessages[0].content)).toEqual({
      zh_cn: {
        content: [
          [
            {
              tag: 'md',
              text: '继续在同一个话题回复'
            }
          ]
        ]
      }
    })
  })

  it('creates the first feishu root message for an unknown codexio thread then replies in that thread', async () => {
    const createdMessages: Array<{
      receiveId: string
      msgType: string
      content: string
    }> = []
    const repliedMessages: Array<{
      messageId: string
      msgType: string
      content: string
      replyInThread?: boolean
    }> = []
    const sender = new FeishuMessageSender({
      enabled: true,
      appId: 'app-id',
      appSecret: 'app-secret',
      chatId: 'chat-id'
    }, {
      im: {
        v1: {
          image: {
            create: async () => {
              throw new Error('image upload should not run')
            }
          },
          message: {
            create: async (payload) => {
              createdMessages.push({
                receiveId: payload.data.receive_id,
                msgType: payload.data.msg_type,
                content: payload.data.content
              })
              return {
                data: {
                  message_id: 'om-root'
                }
              }
            },
            reply: async (payload) => {
              repliedMessages.push({
                messageId: payload.path.message_id,
                msgType: payload.data.msg_type,
                content: payload.data.content,
                replyInThread: payload.data.reply_in_thread
              })
            }
          }
        }
      }
    } as unknown as ConstructorParameters<typeof FeishuMessageSender>[1])

    const first = await sender.send({
      role: 'user',
      ioThreadId: 'io-thread',
      source: 'web',
      text: '你好啊',
      createdAt: Date.now()
    })
    const second = await sender.send({
      role: 'agent',
      ioThreadId: 'io-thread',
      source: 'agent',
      text: '收到，我在这里。',
      createdAt: Date.now()
    })

    expect(first.isFailed).toBe(false)
    expect(second.isFailed).toBe(false)
    expect(createdMessages).toHaveLength(1)
    expect(createdMessages[0]).toMatchObject({
      receiveId: 'chat-id',
      msgType: 'post'
    })
    expect(JSON.parse(createdMessages[0].content)).toEqual({
      zh_cn: {
        content: [
          [
            {
              tag: 'md',
              text: '你好啊'
            }
          ]
        ]
      }
    })
    expect(repliedMessages).toHaveLength(1)
    expect(repliedMessages[0]).toMatchObject({
      messageId: 'om-root',
      msgType: 'post',
      replyInThread: true
    })
    expect(JSON.parse(repliedMessages[0].content)).toEqual({
      zh_cn: {
        content: [
          [
            {
              tag: 'md',
              text: '收到，我在这里。'
            }
          ]
        ]
      }
    })
  })

  it('sends feishu image files inside one post message', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-feishu-image-'))
    const path = join(dir, 'image.png')
    await writeFile(path, pngBytes())
    const createdMessages: Array<{
      msgType: string
      content: string
    }> = []
    const uploaded: Buffer[] = []
    const sender = new FeishuMessageSender({
      enabled: true,
      appId: 'app-id',
      appSecret: 'app-secret',
      chatId: 'chat-id'
    }, {
      im: {
        v1: {
          image: {
            create: async (payload) => {
              uploaded.push(payload.data.image)
              return {
                image_key: 'img-key'
              }
            }
          },
          message: {
            create: async (payload) => {
              createdMessages.push({
                msgType: payload.data.msg_type,
                content: payload.data.content
              })
              return {
                data: {
                  message_id: 'om-root'
                }
              }
            },
            reply: async (payload) => {
              createdMessages.push({
                msgType: payload.data.msg_type,
                content: payload.data.content
              })
            }
          }
        }
      }
    } as unknown as ConstructorParameters<typeof FeishuMessageSender>[1])

    const result = await sender.send({
      role: 'user',
      ioThreadId: 'io-thread',
      source: 'web',
      text: '这图里是什么内容',
      createdAt: Date.now(),
      files: [
        {
          id: 'file-1',
          mime: 'image/png',
          name: 'image.png',
          size: pngBytes().length,
          sha256: '0'.repeat(64),
          path,
          url: '/api/files/file-1'
        }
      ]
    })

    expect(result.isFailed).toBe(false)
    expect(uploaded[0].equals(pngBytes())).toBe(true)
    expect(createdMessages).toHaveLength(1)
    expect(createdMessages[0].msgType).toBe('post')
    expect(createdMessages[0].content).not.toContain('/api/files/file-1')
    expect(JSON.parse(createdMessages[0].content)).toEqual({
      zh_cn: {
        content: [
          [
            {
              tag: 'md',
              text: '这图里是什么内容'
            }
          ],
          [
            {
              tag: 'img',
              image_key: 'img-key'
            }
          ]
        ]
      }
    })
  })

  it('sends feishu generic files as file messages', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-feishu-file-'))
    const path = join(dir, 'note.txt')
    await writeFile(path, 'hello file')
    const createdMessages: Array<{
      msgType: string
      content: string
    }> = []
    const uploadedFiles: Array<{
      fileType: string
      fileName: string
      file: Buffer
    }> = []
    const sender = new FeishuMessageSender({
      enabled: true,
      appId: 'app-id',
      appSecret: 'app-secret',
      chatId: 'chat-id'
    }, {
      im: {
        v1: {
          image: {
            create: async () => {
              throw new Error('image upload should not run')
            }
          },
          file: {
            create: async (payload) => {
              uploadedFiles.push({
                fileType: payload.data.file_type,
                fileName: payload.data.file_name,
                file: payload.data.file
              })
              return {
                file_key: 'file-key'
              }
            }
          },
          message: {
            create: async (payload) => {
              createdMessages.push({
                msgType: payload.data.msg_type,
                content: payload.data.content
              })
              return {
                data: {
                  message_id: 'om-root'
                }
              }
            },
            reply: async (payload) => {
              createdMessages.push({
                msgType: payload.data.msg_type,
                content: payload.data.content
              })
            }
          }
        }
      }
    } as unknown as ConstructorParameters<typeof FeishuMessageSender>[1])

    const result = await sender.send({
      role: 'user',
      ioThreadId: 'io-thread',
      source: 'web',
      text: '你能看到文件吗？',
      createdAt: Date.now(),
      files: [
        {
          id: 'file-1',
          mime: 'text/plain',
          name: 'note.txt',
          size: 'hello file'.length,
          sha256: '0'.repeat(64),
          path,
          url: '/api/files/file-1'
        }
      ]
    })

    expect(result.isFailed).toBe(false)
    expect(uploadedFiles).toHaveLength(1)
    expect(uploadedFiles[0].fileType).toBe('stream')
    expect(uploadedFiles[0].fileName).toBe('note.txt')
    expect(uploadedFiles[0].file.equals(Buffer.from('hello file'))).toBe(true)
    expect(createdMessages).toHaveLength(2)
    expect(createdMessages[0].msgType).toBe('post')
    expect(createdMessages[0].content).toContain('你能看到文件吗？')
    expect(createdMessages[0].content).not.toContain('/api/files/file-1')
    expect(createdMessages[1]).toEqual({
      msgType: 'file',
      content: JSON.stringify({
        file_key: 'file-key'
      })
    })
  })

  it('sends feishu file-only messages without empty post content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-feishu-file-only-'))
    const path = join(dir, 'note.txt')
    await writeFile(path, 'hello file')
    const createdMessages: Array<{
      msgType: string
      content: string
    }> = []
    const sender = new FeishuMessageSender({
      enabled: true,
      appId: 'app-id',
      appSecret: 'app-secret',
      chatId: 'chat-id'
    }, {
      im: {
        v1: {
          file: {
            create: async () => ({
              file_key: 'file-key'
            })
          },
          image: {
            create: async () => {
              throw new Error('image upload should not run')
            }
          },
          message: {
            create: async (payload) => {
              createdMessages.push({
                msgType: payload.data.msg_type,
                content: payload.data.content
              })
              return {
                data: {
                  message_id: 'om-root'
                }
              }
            }
          }
        }
      }
    } as unknown as ConstructorParameters<typeof FeishuMessageSender>[1])

    const result = await sender.send({
      role: 'user',
      ioThreadId: 'io-thread',
      source: 'web',
      text: '',
      createdAt: Date.now(),
      files: [
        {
          id: 'file-1',
          mime: 'text/plain',
          name: 'note.txt',
          size: 'hello file'.length,
          sha256: '0'.repeat(64),
          path,
          url: '/api/files/file-1'
        }
      ]
    })

    expect(result.isFailed).toBe(false)
    expect(createdMessages).toEqual([
      {
        msgType: 'file',
        content: JSON.stringify({
          file_key: 'file-key'
        })
      }
    ])
  })

  it('renders safe markdown for web channel display', () => {
    const html = renderMarkdownHtml([
      '**bold**',
      '',
      '```ts',
      'const value = 1',
      '```',
      '',
      '<script>alert(1)</script>'
    ].join('\n'))
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('const value = 1')
    expect(html).not.toContain('<script>')
  })

  it('parses markdown file links and leaves remote links in text', () => {
    const parsed = parseMarkdownFileReferences([
      '结果如下：',
      '',
      '[日志](C:\\tmp\\result.txt)',
      '[远程](https://example.test/result.txt)',
      '![旧图片](C:\\tmp\\image.png)'
    ].join('\n'))
    expect(parsed).toEqual({
      text: [
        '结果如下：',
        '',
        '`C:\\tmp\\result.txt`',
        '[远程](https://example.test/result.txt)',
        '![旧图片](C:\\tmp\\image.png)'
      ].join('\n'),
      files: [
        {
          label: '日志',
          path: 'C:\\tmp\\result.txt'
        }
      ]
    })
  })

  it('parses markdown file links with parentheses in path', () => {
    const parsed = parseMarkdownFileReferences('查看：[日志](C:\\tmp\\run (1)\\result.txt)。')
    expect(parsed).toEqual({
      text: '查看：`C:\\tmp\\run (1)\\result.txt`。',
      files: [
        {
          label: '日志',
          path: 'C:\\tmp\\run (1)\\result.txt'
        }
      ]
    })
  })

  it('streams codex markdown file links as files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-stream-file-'))
    const path = join(dir, 'result.txt')
    await writeFile(path, 'ok', 'utf8')
    const sent: Message[] = []
    const outputManager = await createRecordingChannelOutputManager(sent)
    const result = await outputManager.sendAgent({
      ioThreadId: 'io-thread',
      role: 'agent',
      text: `日志已生成：[日志](${path})`,
      createdAt: Date.now()
    })

    expect(result.isFailed).toBe(false)
    expect(sent).toHaveLength(1)
    expect(sent[0].text).toBe(`日志已生成：\`${path}\``)
    expect(sent[0].files?.[0]).toMatchObject({
      name: 'result.txt',
      mime: 'text/plain'
    })
  })

  it('keeps unresolved codex markdown file links in text', async () => {
    const sent: Message[] = []
    const outputManager = await createRecordingChannelOutputManager(sent)
    const result = await outputManager.sendAgent({
      ioThreadId: 'io-thread',
      role: 'agent',
      text: '[缺失](C:\\missing\\result.txt)',
      createdAt: Date.now()
    })

    expect(result.isFailed).toBe(false)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      text: '`C:\\missing\\result.txt`'
    })
    expect(sent[0].files).toBeUndefined()
  })

  it('does not let slow output channels block fast channel streaming', async () => {
    const fast: string[] = []
    const slowStarted: string[] = []
    let releaseSlow: () => void = () => {}
    const slowReleased = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })
    const outputManager = await createRecordingChannelOutputManager([], {
      web: async (message) => {
        fast.push(message.text)
        return Result.success(null)
      },
      email: async (message) => {
        slowStarted.push(message.text)
        await slowReleased
        return Result.success(null)
      }
    })

    await outputManager.sendAgent({
      ioThreadId: 'io-thread',
      role: 'agent',
      text: '第一段',
      createdAt: Date.now()
    })
    await outputManager.sendAgent({
      ioThreadId: 'io-thread',
      role: 'agent',
      text: '第二段',
      createdAt: Date.now()
    })

    await waitUntil(() => fast.length === 2)
    expect(fast).toEqual([
      '第一段',
      '第二段'
    ])
    expect(slowStarted).toEqual([
      '第一段'
    ])
    releaseSlow()
    await waitUntil(() => slowStarted.length === 2)
  })

  it('does not duplicate streamed text when completed item id is missing', async () => {
    const sent: Message[] = []
    const outputManager = createOutputManager({
      sendAgent: async (message) => {
        sent.push(message)
        return Result.success(null)
      }
    })
    const streamer = new CodexMessageStreamer(outputManager)
    const thread = {
      ioThreadId: 'io-thread',
      agentThreadId: 'agent-thread'
    }
    await streamer.append(thread, 'delta-item', '第一段。')
    await streamer.complete(thread, [
      {
        itemId: 'completed-turn-0',
        text: '第一段。'
      }
    ])

    expect(sent.map((message) => message.text)).toEqual([
      '第一段。'
    ])
  })

  it('serializes concurrent codex stream flushes without resending prefixes', async () => {
    let releaseFirst: () => void = () => {}
    const firstSendReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const sent: Message[] = []
    const outputManager = createOutputManager({
      sendAgent: async (message) => {
        sent.push(message)
        if (sent.length === 1) {
          await firstSendReleased
        }
        return Result.success(null)
      }
    })
    const streamer = new CodexMessageStreamer(outputManager)
    const thread = {
      ioThreadId: 'io-thread',
      agentThreadId: 'agent-thread'
    }
    const first = streamer.append(thread, 'item-1', '这是一段中间消息，用来触发第一次发送，并且让发送过程暂时卡住，模拟飞书发送较慢。\n\n')
    await waitUntil(() => sent.length === 1)
    const second = streamer.append(thread, 'item-1', '后续新增内容。\n\n')
    releaseFirst()
    await Promise.all([
      first,
      second
    ])

    expect(sent.map((message) => message.text)).toEqual([
      '这是一段中间消息，用来触发第一次发送，并且让发送过程暂时卡住，模拟飞书发送较慢。',
      '后续新增内容。'
    ])
  })

  it('waits for double newline before streaming codex text', async () => {
    const sent: Message[] = []
    const outputManager = createOutputManager({
      sendAgent: async (message) => {
        sent.push(message)
        return Result.success(null)
      }
    })
    const streamer = new CodexMessageStreamer(outputManager)
    const thread = {
      ioThreadId: 'io-thread',
      agentThreadId: 'agent-thread'
    }
    await streamer.append(thread, 'item-1', '我只读不')
    expect(sent).toEqual([])
    await streamer.append(thread, 'item-1', '改。\n\n下一段未完成')
    expect(sent.map((message) => message.text)).toEqual([
      '我只读不改。'
    ])
    await streamer.complete(thread, [
      {
        itemId: 'item-1',
        text: '我只读不改。\n\n下一段未完成'
      }
    ])
    expect(sent.map((message) => message.text)).toEqual([
      '我只读不改。',
      '下一段未完成'
    ])
  })

  it('flushes unfinished codex text when the item completes', async () => {
    const sent: Message[] = []
    const outputManager = createOutputManager({
      sendAgent: async (message) => {
        sent.push(message)
        return Result.success(null)
      }
    })
    const streamer = new CodexMessageStreamer(outputManager)
    const thread = {
      ioThreadId: 'io-thread',
      agentThreadId: 'agent-thread'
    }
    await streamer.append(thread, 'item-1', '没有双换行，但 item 已经结束。')

    expect(sent).toEqual([])

    await streamer.completeItem(thread, 'item-1')

    expect(sent.map((message) => message.text)).toEqual([
      '没有双换行，但 item 已经结束。'
    ])
  })

  it('does not resend completed codex items at turn completion', async () => {
    const sent: Message[] = []
    const outputManager = createOutputManager({
      sendAgent: async (message) => {
        sent.push(message)
        return Result.success(null)
      }
    })
    const streamer = new CodexMessageStreamer(outputManager)
    const thread = {
      ioThreadId: 'io-thread',
      agentThreadId: 'agent-thread'
    }
    await streamer.append(thread, 'item-1', 'item 完成时已发送。')
    await streamer.completeItem(thread, 'item-1')
    await streamer.complete(thread, [
      {
        itemId: 'item-1',
        text: 'item 完成时已发送。'
      }
    ])

    expect(sent.map((message) => message.text)).toEqual([
      'item 完成时已发送。'
    ])
  })

  it('does not resend completed codex items when turn item ids are synthetic', async () => {
    const sent: Message[] = []
    const outputManager = createOutputManager({
      sendAgent: async (message) => {
        sent.push(message)
        return Result.success(null)
      }
    })
    const streamer = new CodexMessageStreamer(outputManager)
    const thread = {
      ioThreadId: 'io-thread',
      agentThreadId: 'agent-thread'
    }
    await streamer.append(thread, 'delta-item', 'item 完成时已发送。')
    await streamer.completeItem(thread, 'delta-item')
    await streamer.complete(thread, [
      {
        itemId: 'completed-turn-0',
        text: 'item 完成时已发送。'
      }
    ])

    expect(sent.map((message) => message.text)).toEqual([
      'item 完成时已发送。'
    ])
  })

  it('streams every completed double-newline segment immediately from buffer', async () => {
    const sent: Message[] = []
    const outputManager = createOutputManager({
      sendAgent: async (message) => {
        sent.push(message)
        return Result.success(null)
      }
    })
    const streamer = new CodexMessageStreamer(outputManager)
    const thread = {
      ioThreadId: 'io-thread',
      agentThreadId: 'agent-thread'
    }
    await streamer.append(thread, 'item-1', '第一段。\n\n第二段。\n\n第三段未完成')

    expect(sent.map((message) => message.text)).toEqual([
      '第一段。',
      '第二段。'
    ])

    await streamer.complete(thread, [
      {
        itemId: 'item-1',
        text: '第一段。\n\n第二段。\n\n第三段未完成'
      }
    ])

    expect(sent.map((message) => message.text)).toEqual([
      '第一段。',
      '第二段。',
      '第三段未完成'
    ])
  })
})

async function waitUntil(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > 4000) {
      throw new Error('condition timeout')
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10)
    })
  }
}

function createCodexAppServerMock(
  requests: Array<{
    method: string
    params: unknown
  }>
) {
  let threadCount = 0
  return {
    async start(): Promise<void> {},
    async request(method: string, params: unknown): Promise<unknown> {
      requests.push({
        method,
        params
      })
      if (method === 'account/read') {
        return {
          account: {}
        }
      }
      if (method === 'thread/start') {
        threadCount += 1
        return {
          thread: {
            id: `thread-${threadCount}`
          }
        }
      }
      if (method === 'turn/start') {
        return {
          turn: {
            id: 'turn-1'
          }
        }
      }
      return {}
    },
    async waitForNotification(): Promise<void> {},
    async stop(): Promise<void> {}
  }
}

type CodexAppServerTestHandle = {
  start: () => Promise<void>
  request: (method: string, params: unknown) => Promise<unknown>
  waitForNotification: (method: string) => Promise<void>
  stop: () => Promise<void>
}

function createCodexAgent(input: {
  appServer: CodexAppServerTestHandle
  config?: CodexioConfig
  send?: (message: Message) => Promise<void>
}): CodexAgent {
  const config = input.config ?? ConfigSchema.parse({})
  const configer = {
    get: async (path: string) => {
      const keys = path.split('.')
      let value: unknown = config
      for (const key of keys) {
        value = (value as Record<string, unknown>)[key]
      }
      return value
    }
  } as unknown as Configer
  class TestCodexAgent extends CodexAgent {
    protected override async createAppServer(): Promise<CodexAppServerTestHandle> {
      return input.appServer
    }
  }
  const outputManager = createOutputManager({
    sendAgent: async (message: Message) => {
      await input.send?.(message)
      return Result.success(null)
    }
  })
  return new TestCodexAgent(configer, testMetadata, outputManager, new CodexMessageStreamer(outputManager))
}

async function createAgentManager(
  config: CodexioConfig,
  outputManager: ChannelOutputManager,
  agent: Agent
): Promise<AgentManager> {
  const dir = await mkdtemp(join(tmpdir(), 'codexio-agent-manager-'))
  const configer = createTestConfiger(join(dir, 'config.yaml'))
  await configer.init(true)
  await configer.patch(config)
  return new AgentManager(configer, outputManager, agent, agent)
}

function createOutputManager(input: {
  sendSystem?: (text: string, source?: string, ioThreadId?: string) => Promise<Result<null>>
  sendUser?: (message: Message) => Promise<Result<null>>
  sendAgent?: (message: Message) => Promise<Result<null>>
  clear?: (ioThreadId: string, source?: string) => Promise<Result<null>>
} = {}): ChannelOutputManager {
  return {
    sendSystem: input.sendSystem ?? (async () => Result.success(null)),
    sendUser: input.sendUser ?? (async () => Result.success(null)),
    sendAgent: input.sendAgent ?? (async () => Result.success(null)),
    clear: input.clear ?? (async () => Result.success(null))
  } as ChannelOutputManager
}

async function createRecordingChannelOutputManager(sent: Message[], sends: Partial<Record<'web' | 'feishu' | 'feishuWebhook' | 'email', (message: Message) => Promise<Result<null>>>> = {}): Promise<ChannelOutputManager> {
  const configer = {
    subscribe: () => {}
  } as unknown as Configer
  const output = (type: string, enabled: boolean) => ({
    type,
    start: async () => enabled || Boolean(sends[type as keyof typeof sends]),
    send: sends[type as keyof typeof sends] ?? (async (message: Message) => {
      sent.push(message)
      return Result.success(null)
    }),
    stop: async () => Result.success(null)
  })
  const manager = new ChannelOutputManager(
    configer,
    new FileStore(testMetadata),
    output('web', true) as never,
    output('feishu', false) as never,
    output('feishuWebhook', false) as never,
    output('email', false) as never
  )
  await manager.start()
  return manager
}

function createTestConfiger(configPath: string): Configer {
  return new Configer(new CodexioMetadata({
    rootPath: testMetadata.rootPath,
    configPath
  }))
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > 4000) {
      throw new Error('wait timed out')
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 5)
    })
  }
}

function pngBytes(): Buffer {
  return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lS3KgwAAAABJRU5ErkJggg==', 'base64')
}


