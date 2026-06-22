import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { codexConfigPath, codexHomePath, createAgentEnv } from '../src/agent/AgentEnvironment.js'
import { AgentManager } from '../src/agent/AgentManager.js'
import { CodexAppServer } from '../src/agent/CodexAppServer.js'
import { CodexAgent, createCodexCommand } from '../src/agent/CodexAgent.js'
import { CodexSessionStore } from '../src/agent/CodexSessionStore.js'
import { AgentLoginInProgressError } from '../src/agent/Agent.js'
import { codexioRootPath } from '../src/AppMetadata.js'
import { CommandExecutor, parseCommandInput } from '../src/controller/CommandExecutor.js'
import { FeishuChannel } from '../src/channel/FeishuChannel.js'
import { FeishuMessageSender } from '../src/channel/FeishuMessageSender.js'
import { createEmailMessagePayload, createEmailSender, createFeishuMessagePayload, createFeishuWebhookText, isAllowedEmailSender } from '../src/channel/ChannelUtil.js'
import { Logger } from '../src/component/Logger.js'
import { renderMarkdownHtml } from '../src/component/Markdown.js'
import { runtimeServerStatePath, supervisorStatePath } from '../src/component/ServerLifecycle.js'
import { createUpdaterScript } from '../src/component/UpdateInstaller.js'
import { FileStore } from '../src/component/FileStore.js'
import { Configer, diffConfigPaths } from '../src/config/Configer.js'
import { ConfigSchema, ConfigService, normalizeWorkspacePath, validateCodexioConfig } from '../src/ConfigService.js'
import { Result } from '../src/value/Result.js'
import { TestAgent } from './TestAgent.js'

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
    const agent = new TestAgent(async (text) => {
      outbound.push(text)
    })
    await agent.start(ConfigSchema.parse({}))
    await agent.receive({
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
    const store = new FileStore({
      rootPath: join(dir, 'store')
    })

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
    const store = new FileStore({
      rootPath: join(dir, 'store')
    })

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

  it('selected agent exposes login lifecycle', async () => {
    const manager = new AgentManager(ConfigSchema.parse({
      agents: {
        codex: {
          enabled: false
        },
        claude: {
          enabled: true
        }
      }
    }), 'http://127.0.0.1:8787', {
      send: async () => Result.success(null),
      status: async () => Result.success(null)
    }, {
      agentFactory: () => new TestAgent(async () => {})
    })
    expect(manager.status().status).toBe('idle')
    await expect(manager.login()).resolves.toBeUndefined()
  })

  it('agent manager acknowledges user message before agent work', async () => {
    const outbound: string[] = []
    const manager = new AgentManager(ConfigSchema.parse({
      agents: {
        codex: {
          enabled: false
        },
        claude: {
          enabled: true
        }
      }
    }), 'http://127.0.0.1:8787', {
      send: async (text) => {
        outbound.push(text)
        return Result.success(null)
      },
      status: async () => Result.success(null)
    }, {
      agentFactory: () => new TestAgent(async (text) => {
        outbound.push(text)
      })
    })
    const result = await manager.receiveMessage({
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
    const manager = new AgentManager(ConfigSchema.parse({
      agents: {
        codex: {
          enabled: false
        },
        claude: {
          enabled: true
        }
      }
    }), 'http://127.0.0.1:8787', {
      send: async (text) => {
        outbound.push(text)
        if (!text.startsWith('test:')) {
          await new Promise((resolve) => {
            setTimeout(resolve, 10)
          })
        }
        return Result.success(null)
      },
      status: async () => Result.success(null)
    }, {
      agentFactory: () => new TestAgent(async (text) => {
        outbound.push(text)
      })
    })
    const [first, second] = await Promise.all([
      manager.receiveMessage({
        text: 'first'
      }),
      manager.receiveMessage({
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
    const manager = new AgentManager(ConfigSchema.parse({
      agents: {
        codex: {
          enabled: true
        },
        claude: {
          enabled: false
        }
      }
    }), 'http://127.0.0.1:8787', {
      send: async () => Result.success(null),
      status: async () => Result.success(null)
    }, {
      agentFactory: () => ({
        type: 'codex',
        async login(): Promise<void> {},
        async start(): Promise<void> {
          throw new AgentLoginInProgressError('请先完成 Codex 登录。')
        },
        async receive(): Promise<void> {},
        async clear(): Promise<void> {},
        async stop(): Promise<void> {}
      })
    })

    const first = await manager.receiveMessage({
      text: 'first'
    })
    const second = await manager.receiveMessage({
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
  })

  it('agents apply proxy env internally', async () => {
    const env = createAgentEnv(ConfigSchema.parse({
      proxy: {
        enabled: true,
        host: 'proxy.local',
        port: 8080
      },
      server: {
        host: '127.0.0.1',
        port: 8787
      }
    }), {
      codexio: {
        apiUrl: 'http://127.0.0.1:8787',
        token: 'runtime-token'
      }
    })
    expect(env.HTTP_PROXY).toBe('http://proxy.local:8080')
    expect(env.HTTPS_PROXY).toBe('http://proxy.local:8080')
    expect(env.ALL_PROXY).toBe('http://proxy.local:8080')
    expect(env.NO_PROXY).toContain('127.0.0.1')
    expect(env.NO_PROXY).toContain('localhost')
    expect(env.no_proxy).toBe(env.NO_PROXY)
    expect(env.CODEXIO_API_URL).toBe('http://127.0.0.1:8787')
    expect(env.CODEXIO_TOKEN).toBe('runtime-token')
    expect(env.CODEX_HOME).toContain('.codexio')
    expect(env.CODEX_HOME).toContain('codex')
    expect(existsSync(codexHomePath)).toBe(true)
    const codexConfig = readFileSync(codexConfigPath, 'utf8')
    expect(codexConfig).toContain('[shell_environment_policy]')
    expect(codexConfig).toContain('"HTTPS_PROXY" = "http://proxy.local:8080"')
    expect(codexConfig).toContain('"NO_PROXY" = "localhost,127.0.0.1,::1"')
    expect(codexConfig).toContain('"CODEXIO_API_URL" = "http://127.0.0.1:8787"')
    expect(codexConfig).toContain('"CODEXIO_TOKEN" = "runtime-token"')
  })

  it('resolves bundled codex command by default', () => {
    const command = createCodexCommand(ConfigSchema.parse({}), [
      'app-server',
      '--stdio'
    ])

    expect(command.command).toBe(process.execPath)
    expect(command.args.at(-2)).toBe('app-server')
    expect(command.args.at(-1)).toBe('--stdio')
    expect(command.args[0]).toContain('@openai')
  })

  it('resolves public codex command when bundled is disabled', () => {
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = 'C:\\Users\\test\\.codex'
    try {
      const config = ConfigSchema.parse({
        agents: {
          codex: {
            enabled: true,
            bundled: false
          }
        }
      })
      const command = createCodexCommand(config, [
        'app-server',
        '--stdio'
      ])
      const env = createAgentEnv(config)

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
    expect(parseCommandInput('$ restart')).toEqual({
      type: 'command',
      name: 'restart',
      args: []
    })
    expect(parseCommandInput('￥restart')).toEqual({
      type: 'command',
      name: 'restart',
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

  it('command executor sends system feedback around update command', async () => {
    const systemMessages: string[] = []
    const executor = new CommandExecutor({
      sendSystem: async (text: string) => {
        systemMessages.push(text)
        return Result.success(null)
      },
      displayUser: async () => Result.success(null),
      clear: async () => Result.success(null)
    } as unknown as import('../src/channel/ChannelManager.js').ChannelManager, {
      receiveMessage: async () => Result.success({}),
      clear: async () => Result.success({
        action: 'clear'
      })
    } as unknown as AgentManager, {
      update: async () => Result.success('Codexio 0.4.2 更新包已准备完成，正在安装并重启。')
    })

    const result = await executor.receive({
      text: '$update',
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
    const executor = new CommandExecutor({
      sendSystem: async (text: string) => {
        systemMessages.push(text)
        return Result.success(null)
      },
      displayUser: async () => Result.success(null),
      clear: async () => Result.success(null)
    } as unknown as import('../src/channel/ChannelManager.js').ChannelManager, {
      receiveMessage: async () => Result.success({}),
      clear: async () => Result.success({
        action: 'clear'
      })
    } as unknown as AgentManager, {
      update: async () => Result.success('Codexio 已是最新版本 0.4.2。')
    })

    const result = await executor.receive({
      text: '$update',
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
    const agent = new CodexAgent({
      workspacePath: '.',
      config: ConfigSchema.parse({
        server: {
          token: 'test-token'
        }
      }),
      toolBaseUrl: 'http://127.0.0.1:8787',
      send: async () => {},
      sessionStore: await createTempSessionStore(),
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
    await agent.start(ConfigSchema.parse({}))
    const threadStart = requests.find((request) => request.method === 'thread/start')
    expect(threadStart?.params).toMatchObject({
      ephemeral: false,
      developerInstructions: expect.stringContaining('$apiUrl/api/message')
    })
    const developerInstructions = (threadStart?.params as Record<string, unknown>).developerInstructions
    expect(developerInstructions).toContain('Bearer $token')
    expect(developerInstructions).toContain('"test-token"')
    expect(developerInstructions).toContain('CODEXIO_API_URL')
    expect(developerInstructions).toContain('http://127.0.0.1:8787')
    expect(developerInstructions).toContain('[System.Text.Encoding]::UTF8.GetBytes')
    expect(developerInstructions).toContain('application/json; charset=utf-8')
    expect(developerInstructions).toContain('Never send local images as Markdown image links')
    expect(developerInstructions).not.toContain('${toolBaseUrl}')
    expect(developerInstructions).not.toContain('${token}')
  })

  it('codex agent saves a new persistent thread when no session exists', async () => {
    const { store, path } = await createTempSessionStoreWithPath()
    const requests: Array<{
      method: string
      params: unknown
    }> = []
    const agent = new CodexAgent({
      workspacePath: '.',
      config: ConfigSchema.parse({}),
      toolBaseUrl: 'http://127.0.0.1:8787',
      send: async () => {},
      sessionStore: store,
      appServer: createCodexAppServerMock(requests)
    })

    await agent.start(ConfigSchema.parse({}))

    expect(requests.map((request) => request.method)).toEqual([
      'account/read',
      'thread/start'
    ])
    expect(requests[1].params).toMatchObject({
      ephemeral: false
    })
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      agent: 'codex',
      threadId: 'thread-1',
      updatedAt: expect.any(String)
    })
  })

  it('codex agent resumes an existing persistent thread', async () => {
    const { store } = await createTempSessionStoreWithPath()
    await store.write('thread-existing')
    const requests: Array<{
      method: string
      params: unknown
    }> = []
    const agent = new CodexAgent({
      workspacePath: '.',
      config: ConfigSchema.parse({}),
      toolBaseUrl: 'http://127.0.0.1:8787',
      send: async () => {},
      sessionStore: store,
      appServer: createCodexAppServerMock(requests)
    })

    await agent.start(ConfigSchema.parse({}))

    expect(requests.map((request) => request.method)).toEqual([
      'account/read',
      'thread/resume'
    ])
    expect(requests[1].params).toMatchObject({
      threadId: 'thread-existing',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access'
    })
  })

  it('codex agent clears an invalid session and creates a new thread', async () => {
    const { store } = await createTempSessionStoreWithPath()
    await store.write('thread-stale')
    const requests: Array<{
      method: string
      params: unknown
    }> = []
    const agent = new CodexAgent({
      workspacePath: '.',
      config: ConfigSchema.parse({}),
      toolBaseUrl: 'http://127.0.0.1:8787',
      send: async () => {},
      sessionStore: store,
      appServer: createCodexAppServerMock(requests, {
        failResume: true
      })
    })

    await agent.start(ConfigSchema.parse({}))

    expect(requests.map((request) => request.method)).toEqual([
      'account/read',
      'thread/resume',
      'thread/start'
    ])
    await expect(store.read()).resolves.toMatchObject({
      threadId: 'thread-1'
    })
  })

  it('codex agent clear overwrites the persisted thread with a new thread', async () => {
    const { store } = await createTempSessionStoreWithPath()
    const requests: Array<{
      method: string
      params: unknown
    }> = []
    const agent = new CodexAgent({
      workspacePath: '.',
      config: ConfigSchema.parse({}),
      toolBaseUrl: 'http://127.0.0.1:8787',
      send: async () => {},
      sessionStore: store,
      appServer: createCodexAppServerMock(requests)
    })

    await agent.start(ConfigSchema.parse({}))
    await agent.clear()

    expect(requests.map((request) => request.method)).toEqual([
      'account/read',
      'thread/start',
      'thread/start'
    ])
    await expect(store.read()).resolves.toMatchObject({
      threadId: 'thread-2'
    })
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
    const agent = new CodexAgent({
      workspacePath: '.',
      config: ConfigSchema.parse({}),
      toolBaseUrl: 'http://127.0.0.1:8787',
      send: async () => {},
      sessionStore: await createTempSessionStore(),
      appServer
    })
    await agent.start(ConfigSchema.parse({}))
    await agent.receive({
      text: 'first'
    })
    await agent.receive({
      text: 'second'
    })
    await agent.clear()
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
    const agent = new CodexAgent({
      workspacePath: '.',
      config: ConfigSchema.parse({}),
      toolBaseUrl: 'http://127.0.0.1:8787',
      send: async () => {},
      sessionStore: await createTempSessionStore(),
      appServer: createCodexAppServerMock(requests)
    })
    await agent.start(ConfigSchema.parse({}))
    await agent.receive({
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
    const agent = new CodexAgent({
      workspacePath: '.',
      config: ConfigSchema.parse({}),
      toolBaseUrl: 'http://127.0.0.1:8787',
      send: async () => {},
      sessionStore: await createTempSessionStore(),
      appServer: createCodexAppServerMock(requests)
    })
    await agent.start(ConfigSchema.parse({}))
    await agent.receive({
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
    const agent = new CodexAgent({
      workspacePath: '.',
      config: ConfigSchema.parse({}),
      toolBaseUrl: 'http://127.0.0.1:8787',
      send: async (text) => {
        outbound.push(text)
      },
      sessionStore: await createTempSessionStore(),
      appServer
    })
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await expect(agent.start(ConfigSchema.parse({}))).rejects.toThrow(AgentLoginInProgressError)
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
    const states: string[] = []
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
    const agent = new CodexAgent({
      workspacePath: '.',
      config: ConfigSchema.parse({}),
      toolBaseUrl: 'http://127.0.0.1:8787',
      send: async (text) => {
        outbound.push(text)
      },
      onLoginRequired: async (message) => {
        states.push(message)
      },
      sessionStore: await createTempSessionStore(),
      appServer
    })
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await expect(agent.start(ConfigSchema.parse({}))).rejects.toThrow(AgentLoginInProgressError)
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
    expect(states).toEqual([
      '请先完成 Codex 登录。'
    ])
  })

  it('codex agent turns runtime token invalidation into one login flow', async () => {
    const outbound: string[] = []
    const states: string[] = []
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
    const agent = new CodexAgent({
      workspacePath: '.',
      config: ConfigSchema.parse({}),
      toolBaseUrl: 'http://127.0.0.1:8787',
      send: async (text) => {
        outbound.push(text)
      },
      onLoginRequired: async (message) => {
        states.push(message)
      },
      sessionStore: await createTempSessionStore(),
      appServer
    })
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await agent.start(ConfigSchema.parse({}))
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
      'thread/start',
      'account/login/start'
    ])
    expect(outbound).toHaveLength(1)
    expect(outbound[0]).toContain('RUNTIME-1')
    expect(outbound[0]).not.toContain('Your access token could not be refreshed')
    expect(states).toEqual([
      '请先完成 Codex 登录。'
    ])
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
        if (method === 'thread/resume') {
          return {
            thread: {
              id: (params as Record<string, string>).threadId
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
    const agent = new CodexAgent({
      workspacePath: '.',
      config: ConfigSchema.parse({}),
      toolBaseUrl: 'http://127.0.0.1:8787',
      send: async (text) => {
        outbound.push(text)
      },
      sessionStore: await createTempSessionStore(),
      appServer
    })
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await agent.start(ConfigSchema.parse({}))
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
      await waitFor(() => requests.some((request) => request.method === 'thread/resume'))
    } finally {
      stdout.mockRestore()
    }

    expect(starts).toBe(2)
    expect(stops).toBe(1)
    expect(requests.map((request) => request.method)).toEqual([
      'account/read',
      'thread/start',
      'account/login/start',
      'account/read',
      'thread/resume'
    ])
    expect(outbound).toContain('Codex login completed.')
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

  it('migrates old config to one enabled agent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-'))
    const path = join(dir, 'config.yaml')
    await writeFile(path, [
      'server:',
      '  host: 127.0.0.1',
      '  port: 8787',
      '  publicUrl: http://127.0.0.1:8787',
      'proxy:',
      '  enabled: true',
      '  http: http://127.0.0.1:7890',
      'defaultAgent: codex',
      'agents:',
      '  codex:',
      '    enabled: true',
      '  claude:',
      '    enabled: true',
      'workspaces:',
      '  default:',
      '    path: C:\\\\repo',
      'routing:',
      '  defaultWorkspace: default'
    ].join('\n'), 'utf8')
    const config = await new ConfigService(path).load()
    expect(config.agents.codex?.enabled).toBe(true)
    expect(config.agents.claude?.enabled).toBe(false)
    expect(config.workspace.path).toBe('C:\\\\repo')
    expect(config.proxy).toEqual({
      enabled: true,
      host: '127.0.0.1',
      port: 7890
    })
  })

  it('migrates old config selected workspace through typed legacy shape', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-'))
    const path = join(dir, 'config.yaml')
    await writeFile(path, [
      'proxy:',
      '  enabled: true',
      '  http: http://proxy.local:8080',
      'defaultAgent: claude',
      'workspaces:',
      '  default:',
      '    path: C:\\\\default',
      '  product:',
      '    path: C:\\\\product',
      'routing:',
      '  defaultWorkspace: product'
    ].join('\n'), 'utf8')
    const config = await new ConfigService(path).load()
    expect(config.agents.codex?.enabled).toBe(false)
    expect(config.agents.claude?.enabled).toBe(true)
    expect(config.workspace.path).toBe('C:\\\\product')
    expect(config.proxy).toEqual({
      enabled: true,
      host: 'proxy.local',
      port: 8080
    })
  })

  it('defaults workspace to codexio local workspace directory', () => {
    const config = new ConfigService().createDefaultConfig()
    expect(config.workspace.path).toContain(join('.codexio', 'workspace'))
  })

  it('creates default workspace when initializing new config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-'))
    const path = join(dir, 'config.yaml')
    const service = new ConfigService(path)
    const config = await service.init()
    expect(existsSync(config.workspace.path)).toBe(true)
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
    const configer = new Configer(path)
    const changes: Array<{
      previousPort: number
      currentPort: number
      paths: string[]
    }> = []
    configer.subscribe((change) => {
      changes.push({
        previousPort: change.previous.proxy.port,
        currentPort: change.current.proxy.port,
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
    const configer = new Configer(path)
    const feishuChanges: Array<{
      previousSecret: string | undefined
      currentSecret: string | undefined
    }> = []
    configer.subscribe((config) => config.channels.feishu, (change) => {
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

  it('creates packaged managed workspace when loading default release config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-package-'))
    const path = join(dir, 'config.yaml')
    await writeFile(path, [
      'workspace:',
      '  path: codexio/.codexio/workspace'
    ].join('\n'), 'utf8')

    const config = await new ConfigService(path).load()

    expect(config.workspace.path).toBe(join(dir, 'codexio', '.codexio', 'workspace'))
    expect(existsSync(config.workspace.path)).toBe(true)
  })

  it('expands home workspace paths', () => {
    expect(normalizeWorkspacePath('~/Desktop')).toBe(join(homedir(), 'Desktop'))
  })

  it('validates workspace and enabled channel config before startup', () => {
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
      expect(message).toContain('workspace.path does not exist')
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
      const config = await new ConfigService(path).load()
      expect(config.server.token).toBe('env-token')
      expect(config.workspace.path).toBe(join(dir, 'proxy.local'))
    } finally {
      if (previousToken === undefined) {
        delete process.env.CODEXIO_TEST_TOKEN
      } else {
        process.env.CODEXIO_TEST_TOKEN = previousToken
      }
    }
  })

  it('creates default config without proxy enabled', () => {
    const config = new ConfigService().createDefaultConfig('C:\\repo')
    expect(config.proxy.enabled).toBe(false)
    expect(config.proxy.host).toBe('127.0.0.1')
    expect(config.proxy.port).toBe(7890)
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
    expect(runtimeServerStatePath(join('C:\\app', 'config.yaml'))).toBe(join(codexioRootPath, '.codexio', 'state', 'server.json'))
    expect(supervisorStatePath(join('C:\\app', 'config.yaml'))).toBe(join(codexioRootPath, '.codexio', 'state', 'supervisor.json'))
  })

  it('updater waits for restarted server pid', () => {
    const script = createUpdaterScript()
    expect(script).toContain('$serverState = Get-Content -Raw -LiteralPath $manifestData.serverStatePath | ConvertFrom-Json')
    expect(script).toContain('$serverResponse.data.pid -eq $serverState.pid')
    expect(script).not.toContain('$response.data.pid -eq $state.pid')
  })

  it('updater preserves runtime data in place while updating release metadata', () => {
    const script = createUpdaterScript()
    expect(script).toContain('function Copy-CodexioAppContent')
    expect(script).toContain('if ($item.Name -eq ".codexio")')
    expect(script).toContain('Copy-UpdateItem -Source (Join-Path $item.FullName "release.json") -Destination (Join-Path $targetData "release.json")')
    expect(script).not.toContain('preserved-codexio-data')
  })

  it('updater removes only transient application data directories', () => {
    const script = createUpdaterScript()
    expect(script).toContain('function Remove-TransientAppData')
    expect(script).toContain('foreach ($item in @("download", "update"))')
    expect(script).toContain('Join-Path $manifestData.installRoot "codexio\\.codexio"')
  })

  it('updater terminates install-root processes and retries directory removal', () => {
    const script = createUpdaterScript()
    expect(script).toContain('Set-Location -LiteralPath $manifestData.updateRoot')
    expect(script).toContain('function Stop-InstallRootProcess')
    expect(script).toContain('function Copy-UpdateDirectoryContent')
    expect(script).toContain('$_.ExecutablePath.StartsWith($installRoot')
    expect(script).toContain('$_.CommandLine.Contains($installRoot)')
    expect(script).toContain('for ($attempt = 1; $attempt -le 10; $attempt++)')
    expect(script).toContain('Stop-InstallRootProcess')
  })

  it('updater removes legacy root runtime state files after replacement', () => {
    const script = createUpdaterScript()
    expect(script).toContain('function Remove-LegacyRootState')
    expect(script).toContain('function Remove-LegacyInstallDataRoot')
    expect(script).toContain('Join-Path $manifestData.installRoot "server.json"')
    expect(script).toContain('Join-Path $manifestData.installRoot "supervisor.json"')
    expect(script).toContain('Join-Path $manifestData.installRoot ".codexio"')
    expect(script).toContain('Remove-LegacyRootState')
    expect(script).toContain('Remove-LegacyInstallDataRoot')
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
    const config = new ConfigService().createDefaultConfig('C:\\repo')
    expect(config.channels.feishu?.ws).toBe('')
  })

  it('migrates legacy email config to user and agent mailbox', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-'))
    const path = join(dir, 'config.yaml')
    await writeFile(path, [
      'channels:',
      '  email:',
      '    enabled: true',
      '    imap:',
      '      host: imap.example.test',
      '      port: 993',
      '      secure: true',
      '      user: agent@example.test',
      '      password: imap-password',
      '      mailbox: INBOX',
      '    smtp:',
      '      host: smtp.example.test',
      '      port: 465',
      '      secure: true',
      '      user: agent@example.test',
      '      password: smtp-password',
      '      from: agent@example.test',
      '    to:',
      '      - target@example.test'
    ].join('\n'), 'utf8')
    const config = await new ConfigService(path).load()
    expect(config.channels.email?.user).toBe('target@example.test')
    expect(config.channels.email?.agent.imap.user).toBe('agent@example.test')
    expect(config.channels.email?.agent.smtp.user).toBe('agent@example.test')
  })

  it('uses smtp user as email address when sender is only a display name', () => {
    expect(createEmailSender('codexio-agent', 'agent@example.test')).toEqual({
      name: 'codexio-agent',
      address: 'agent@example.test'
    })
  })

  it('filters incoming email by configured user address', () => {
    expect(isAllowedEmailSender([
      'USER@EXAMPLE.TEST'
    ], 'user@example.test')).toBe(true)
    expect(isAllowedEmailSender([
      'other@example.test'
    ], 'user@example.test')).toBe(false)
  })

  it('formats feishu message without codexio title and labels non-agent roles at bottom', () => {
    const agentPayload = createFeishuMessagePayload({
      role: 'agent',
      text: 'agent output',
      createdAt: Date.now()
    })
    const agentContent = JSON.parse(agentPayload.content) as {
      zh_cn: {
        title?: string
        content: Array<Array<{ tag: string, text: string }>>
      }
    }
    expect(agentContent.zh_cn.title).toBeUndefined()
    expect(agentContent.zh_cn.content).toEqual([
      [
        {
          tag: 'md',
          text: 'agent output'
        }
      ]
    ])

    const userPayload = createFeishuMessagePayload({
      role: 'user',
      text: 'user input',
      createdAt: Date.now()
    })
    const userContent = JSON.parse(userPayload.content) as {
      zh_cn: {
        content: Array<Array<{ tag: string, text: string }>>
      }
    }
    expect(userContent.zh_cn.content.at(-1)).toEqual([
      {
        tag: 'text',
        text: 'User'
      }
    ])

    const systemPayload = createFeishuMessagePayload({
      role: 'system',
      text: 'system output',
      createdAt: Date.now()
    })
    const systemContent = JSON.parse(systemPayload.content) as {
      zh_cn: {
        content: Array<Array<{ tag: string, text: string }>>
      }
    }
    expect(systemContent.zh_cn.content).toEqual([
      [
        {
          tag: 'md',
          text: 'system output'
        }
      ],
      [
        {
          tag: 'text',
          text: 'System'
        }
      ]
    ])

    const imagePayload = createFeishuMessagePayload({
      role: 'user',
      text: 'with image',
      createdAt: Date.now(),
      files: [
        {
          id: 'file-1',
          mime: 'image/png',
          name: 'image.png',
          size: 1,
          sha256: '0'.repeat(64),
          path: 'C:\\tmp\\image.png',
          url: '/api/files/file-1'
        }
      ]
    }, [
      {
        imageKey: 'img-key'
      }
    ])
    const imageContent = JSON.parse(imagePayload.content) as {
      zh_cn: {
        content: Array<Array<Record<string, string>>>
      }
    }
    expect(imagePayload.content).not.toContain('/api/files/file-1')
    expect(imageContent.zh_cn.content).toContainEqual([
      {
        tag: 'img',
        image_key: 'img-key'
      }
    ])

    const filePayload = createFeishuMessagePayload({
      role: 'user',
      text: 'with file',
      createdAt: Date.now(),
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
    expect(filePayload.content).not.toContain('/api/files/file-1')

    const fileOnlyPayload = createFeishuMessagePayload({
      role: 'user',
      text: '',
      createdAt: Date.now(),
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
    expect(JSON.parse(fileOnlyPayload.content)).toEqual({
      zh_cn: {
        content: []
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
            }
          }
        }
      }
    } as unknown as ConstructorParameters<typeof FeishuMessageSender>[1])

    const result = await sender.send({
      role: 'user',
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
          ],
          [
            {
              tag: 'text',
              text: 'User'
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
            }
          }
        }
      }
    } as unknown as ConstructorParameters<typeof FeishuMessageSender>[1])

    const result = await sender.send({
      role: 'user',
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
            }
          }
        }
      }
    } as unknown as ConstructorParameters<typeof FeishuMessageSender>[1])

    const result = await sender.send({
      role: 'user',
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

  it('formats feishu webhook system message with system suffix', () => {
    expect(createFeishuWebhookText({
      role: 'system',
      text: 'system output',
      createdAt: Date.now()
    })).toBe('system output\n\nSystem')
    expect(createFeishuWebhookText({
      role: 'system',
      text: 'clear',
      createdAt: Date.now()
    })).toBe('已开始新对话\n\nSystem')
  })

  it('formats feishu webhook text without local file links', () => {
    expect(createFeishuWebhookText({
      role: 'user',
      text: '你能看到文件吗？',
      createdAt: Date.now(),
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
    })).toBe('你能看到文件吗？\n\nUser')

    expect(createFeishuWebhookText({
      role: 'user',
      text: '',
      createdAt: Date.now(),
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
    })).toBe('已收到文件：note.txt\n\nUser')
  })

  it('formats email message without codexio title and labels non-agent roles at bottom', () => {
    const agentPayload = createEmailMessagePayload({
      role: 'agent',
      text: 'agent output',
      createdAt: Date.now()
    })
    expect(agentPayload).toEqual({
      subject: 'Agent',
      text: 'agent output'
    })

    const userPayload = createEmailMessagePayload({
      role: 'user',
      text: 'user input',
      createdAt: Date.now()
    })
    expect(userPayload).toEqual({
      subject: 'User',
      text: 'user input\n\nUser'
    })

    const systemPayload = createEmailMessagePayload({
      role: 'system',
      text: 'system output',
      createdAt: Date.now()
    })
    expect(systemPayload).toEqual({
      subject: 'System',
      text: 'system output\n\nSystem'
    })
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
})

async function createTempSessionStore(): Promise<CodexSessionStore> {
  return (await createTempSessionStoreWithPath()).store
}

async function createTempSessionStoreWithPath(): Promise<{
  store: CodexSessionStore
  path: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'codexio-session-'))
  const path = join(dir, 'session.json')
  return {
    store: new CodexSessionStore(path),
    path
  }
}

function createCodexAppServerMock(
  requests: Array<{
    method: string
    params: unknown
  }>,
  options: {
    failResume?: boolean
  } = {}
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
      if (method === 'thread/resume') {
        if (options.failResume) {
          throw new Error('resume failed')
        }
        return {
          thread: {
            id: (params as Record<string, string>).threadId
          }
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
