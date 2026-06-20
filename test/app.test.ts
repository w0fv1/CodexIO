import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { Server as HttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigSchema } from '../src/ConfigService.js'
import { codexioRootPath } from '../src/AppMetadata.js'
import { createCodexioApp, resolveAvailableServerPort } from '../src/index.js'
import { createServeProcessSpec, restartServer, writeSupervisorState } from '../src/component/ServerLifecycle.js'
import { webPageHtml } from '../src/channel/WebPage.js'
import { TestAgent } from './TestAgent.js'

const testToken = 'test-message-token'

describe('server', () => {
  it('serves a compact Codexio web chat page', () => {
    expect(webPageHtml).toContain('Codexio')
    expect(webPageHtml).toContain('id="messages"')
    expect(webPageHtml).toContain('id="form"')
    expect(webPageHtml).toContain('https://unpkg.com/@tailwindcss/browser@4')
    expect(webPageHtml).toContain('https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js')
    expect(webPageHtml).toContain('event.shiftKey')
    expect(webPageHtml).not.toContain('让 coding agent 通过统一通道工作')
    expect(webPageHtml).not.toContain('Codex CLI')
    expect(webPageHtml).not.toContain('statusText')
    expect(webPageHtml).not.toContain('Connected')
    expect(webPageHtml).not.toContain('Connecting')
    expect(webPageHtml).not.toContain('Disconnected')
    expect(webPageHtml).not.toContain('WebSocket 已断开')
    expect(webPageHtml).not.toContain('WebSocket 连接异常')
    expect(webPageHtml).not.toContain('>重连</button>')
    expect(webPageHtml).toContain('href="/config"')
    expect(webPageHtml).toContain("if (message.type === 'system')")
    expect(webPageHtml).toContain('whitespace-pre-wrap break-words')
  })

  it('receives web text', async () => {
    const { baseUrl, listener } = await startTestServer()
    const socket = await openWebSocket(baseUrl)
    const messages = recordWebSocket(socket)
    socket.send(JSON.stringify({
      text: 'hello'
    }))
    await waitForWebSocketMessages(messages, 3)
    expect(messages[0]).toMatchObject({
      type: 'user',
      text: 'hello'
    })
    expect(messages[1]).toMatchObject({
      type: 'system',
      text: expect.any(String)
    })
    expect(messages[2]).toMatchObject({
      type: 'agent',
      text: 'test: hello'
    })
    await closeWebSocket(socket)
    await closeTestServer(listener)
  })

  it('clears the active agent conversation', async () => {
    const { baseUrl, listener } = await startTestServer()
    const socket = await openWebSocket(baseUrl)
    const messages = recordWebSocket(socket)
    socket.send(JSON.stringify({
      text: 'first'
    }))
    await waitForWebSocketMessages(messages, 3)
    socket.send(JSON.stringify({
      text: '$ clear'
    }))
    await waitForWebSocketMessages(messages, 4)
    const clear = messages[3]
    socket.send(JSON.stringify({
      text: 'second'
    }))
    await waitForWebSocketMessages(messages, 7)
    const second = messages[6]
    expect(clear).toMatchObject({
      type: 'clear'
    })
    expect(second).toMatchObject({
      type: 'agent',
      text: 'test: second'
    })
    await closeWebSocket(socket)
    await closeTestServer(listener)
  })

  it('clears with yuan-prefixed command without a space', async () => {
    const { baseUrl, listener } = await startTestServer()
    const socket = await openWebSocket(baseUrl)
    const messages = recordWebSocket(socket)
    socket.send(JSON.stringify({
      text: 'first'
    }))
    await waitForWebSocketMessages(messages, 3)
    socket.send(JSON.stringify({
      text: '￥clear'
    }))
    await waitForWebSocketMessages(messages, 4)
    expect(messages[3]).toMatchObject({
      type: 'clear'
    })
    await closeWebSocket(socket)
    await closeTestServer(listener)
  })

  it('shows system feedback for restart command', async () => {
    const restarts: string[] = []
    const restarted = await startTestServer({
      restart: async () => {
        restarts.push('restart')
        return {
          code: '1',
          message: 'no error',
          data: 'Codexio restart requested through supervisor 127.0.0.1:10000',
          isFailed: false
        }
      }
    })
    const restartedSocket = await openWebSocket(restarted.baseUrl)
    const restartedMessages = recordWebSocket(restartedSocket)
    restartedSocket.send(JSON.stringify({
      text: '$restart'
    }))
    await waitForWebSocketMessages(restartedMessages, 2)
    expect(restartedMessages[0]).toMatchObject({
      type: 'user',
      text: '$restart'
    })
    expect(restartedMessages[1]).toMatchObject({
      type: 'system',
      text: '正在重启 Codexio，页面会自动重连。'
    })
    expect(restarts).toEqual([
      'restart'
    ])
    await closeWebSocket(restartedSocket)
    await closeTestServer(restarted.listener)
  })

  it('reports restart command failure when application lifecycle is unavailable', async () => {
    const { baseUrl, listener } = await startTestServer(null)
    const socket = await openWebSocket(baseUrl)
    const messages = recordWebSocket(socket)
    socket.send(JSON.stringify({
      text: '$restart'
    }))
    await waitForWebSocketMessages(messages, 3)
    expect(messages[0]).toMatchObject({
      type: 'user',
      text: '$restart'
    })
    expect(messages[1]).toMatchObject({
      type: 'system',
      text: '正在重启 Codexio，页面会自动重连。'
    })
    expect(messages[2]).toMatchObject({
      type: 'system',
      text: '执行失败：$restart\nCodexio supervisor 未运行，请用 start.cmd 启动后再重启。'
    })
    await closeWebSocket(socket)
    await closeTestServer(listener)
  })

  it('shows command help for yuan help and question aliases', async () => {
    const { baseUrl, listener } = await startTestServer()
    const socket = await openWebSocket(baseUrl)
    const messages = recordWebSocket(socket)
    socket.send(JSON.stringify({
      text: '￥help'
    }))
    await waitForWebSocketMessages(messages, 2)
    expect(messages[0]).toMatchObject({
      type: 'user',
      text: '￥help'
    })
    expect(messages[1]).toMatchObject({
      type: 'system',
      text: expect.stringContaining('$update / ￥update')
    })
    socket.send(JSON.stringify({
      text: '￥?'
    }))
    await waitForWebSocketMessages(messages, 4)
    expect(messages[2]).toMatchObject({
      type: 'user',
      text: '￥?'
    })
    expect(messages[3]).toMatchObject({
      type: 'system',
      text: expect.stringContaining('$help / ￥help / $? / ￥?')
    })
    await closeWebSocket(socket)
    await closeTestServer(listener)
  })

  it('does not expose web history as external API', async () => {
    const { baseUrl, listener } = await startTestServer()
    const messages = await fetch(`${baseUrl}/api/web/messages`)
    const events = await fetch(`${baseUrl}/api/web/events`)
    expect(messages.status).toBe(404)
    expect(events.status).toBe(404)
    await closeTestServer(listener)
  })

  it('serves config page and saves config patches', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-config-page-'))
    const workspace = join(dir, 'workspace')
    await mkdir(workspace)
    const configPath = join(dir, 'config.yaml')
    await writeFile(configPath, [
      'server:',
      '  host: 127.0.0.1',
      '  port: 8787',
      '  token: test-message-token',
      'proxy:',
      '  enabled: false',
      '  host: 127.0.0.1',
      '  port: 7890',
      'agents:',
      '  codex:',
      '    enabled: false',
      '  claude:',
      '    enabled: true',
      'channels:',
      '  web:',
      '    enabled: true',
      'workspace:',
      `  path: ${workspace}`
    ].join('\n'), 'utf8')
    const config = ConfigSchema.parse({
      server: {
        token: testToken
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
        web: {
          enabled: true
        }
      },
      workspace: {
        path: workspace
      }
    })
    const server = createCodexioApp(config, {
      configPath,
      agentFactory: () => new TestAgent(async () => {})
    })
    const listener = server.listen(0)
    await new Promise<void>((resolve) => listener.once('listening', resolve))
    const address = listener.address()
    if (!address || typeof address === 'string') {
      throw new Error('server address not found')
    }
    const baseUrl = `http://127.0.0.1:${address.port}`
    const page = await fetch(`${baseUrl}/config`)
    const pageText = await page.text()
    expect(pageText).toContain('Codexio Config')
    expect(pageText).toContain('导入配置')
    expect(pageText).toContain('导出配置')

    const readResponse = await fetch(`${baseUrl}/api/config`)
    const readResult = await readResponse.json() as {
      isFailed: boolean
      data: {
        descriptor: Array<{ path: string }>
      }
    }
    expect(readResult.isFailed).toBe(false)
    expect(readResult.data.descriptor.some((item) => item.path === 'proxy.port')).toBe(true)

    const patchResponse = await fetch(`${baseUrl}/api/config`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        patch: {
          proxy: {
            enabled: true,
            host: '127.0.0.1',
            port: 7891
          }
        }
      })
    })
    const patchResult = await patchResponse.json() as {
      isFailed: boolean
      data: {
        changedPaths: string[]
        effects: string[]
      }
    }
    expect(patchResult.isFailed).toBe(false)
    expect(patchResult.data.changedPaths).toContain('proxy.port')
    expect(patchResult.data.effects).toContain('agentRestart')
    expect(await readFile(configPath, 'utf8')).toContain('port: 7891')

    const exportResponse = await fetch(`${baseUrl}/api/config/export`)
    const exported = await exportResponse.text()
    expect(exported).toContain('baseUrl: https://next.firco.cn')

    const imported = exported.replace('baseUrl: https://next.firco.cn', 'baseUrl: https://import.example.test')
    const importResponse = await fetch(`${baseUrl}/api/config/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: imported
      })
    })
    const importResult = await importResponse.json() as {
      isFailed: boolean
      data: {
        changedPaths: string[]
        effects: string[]
      }
    }
    expect(importResult.isFailed).toBe(false)
    expect(importResult.data.changedPaths).toContain('update.baseUrl')
    expect(importResult.data.effects).toContain('hot')
    expect(await readFile(configPath, 'utf8')).toContain('baseUrl: https://import.example.test')
    await closeTestServer(listener)
  })

  it('accepts agent output through the configured default channel', async () => {
    const { baseUrl, listener } = await startTestServer()
    const socket = await openWebSocket(baseUrl)
    const messages = recordWebSocket(socket)
    const response = await fetch(`${baseUrl}/api/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${testToken}`
      },
      body: JSON.stringify({
        text: 'agent output'
      })
    })
    const result = await response.json() as {
      isFailed: boolean
    }
    await waitForWebSocketMessages(messages, 1)
    expect(result.isFailed).toBe(false)
    expect(messages[0]).toMatchObject({
      type: 'agent',
      text: 'agent output'
    })
    await closeWebSocket(socket)
    await closeTestServer(listener)
  })

  it('sends sanitized markdown html to web channel', async () => {
    const { baseUrl, listener } = await startTestServer()
    const socket = await openWebSocket(baseUrl)
    const messages = recordWebSocket(socket)
    const response = await fetch(`${baseUrl}/api/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${testToken}`
      },
      body: JSON.stringify({
        text: '**done**\n\n<script>alert(1)</script>'
      })
    })
    const result = await response.json() as {
      isFailed: boolean
    }
    await waitForWebSocketMessages(messages, 1)
    expect(result.isFailed).toBe(false)
    expect(messages[0]).toMatchObject({
      type: 'agent',
      text: '**done**\n\n<script>alert(1)</script>'
    })
    expect(messages[0].html).toContain('<strong>done</strong>')
    expect(messages[0].html).not.toContain('<script>')
    await closeWebSocket(socket)
    await closeTestServer(listener)
  })

  it('rejects unauthenticated agent output', async () => {
    const { baseUrl, listener } = await startTestServer()
    const response = await fetch(`${baseUrl}/api/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: 'agent output'
      })
    })
    const result = await response.json() as {
      isFailed: boolean
      message: string
    }
    expect(response.status).toBe(401)
    expect(result.isFailed).toBe(true)
    expect(result.message).toBe('unauthorized')
    await closeTestServer(listener)
  })

  it('restarts the application through the authenticated admin endpoint', async () => {
    const restarts: string[] = []
    const { baseUrl, listener } = await startTestServer({
      restart: async () => {
        restarts.push('restart')
        return {
          code: '1',
          message: 'no error',
          data: 'Codexio restart requested through supervisor 127.0.0.1:10000',
          isFailed: false
        }
      }
    })
    const unauthorized = await fetch(`${baseUrl}/api/server/restart`, {
      method: 'POST'
    })
    expect(unauthorized.status).toBe(401)

    const response = await fetch(`${baseUrl}/api/server/restart`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${testToken}`
      }
    })
    const result = await response.json() as {
      isFailed: boolean
      data: {
        action: string
      }
    }
    expect(result.isFailed).toBe(false)
    expect(result.data).toBe('Codexio restart requested through supervisor 127.0.0.1:10000')
    expect(restarts).toEqual([
      'restart'
    ])
    await closeTestServer(listener)
  })

  it('stops the host server through the authenticated admin endpoint', async () => {
    const { baseUrl, listener } = await startTestServer()
    const unauthorized = await fetch(`${baseUrl}/api/server/stop`, {
      method: 'POST'
    })
    expect(unauthorized.status).toBe(401)

    const closed = new Promise<void>((resolve) => {
      listener.once('close', resolve)
    })
    const response = await fetch(`${baseUrl}/api/server/stop`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${testToken}`
      }
    })
    const result = await response.json() as {
      isFailed: boolean
      data: {
        stopping: boolean
      }
    }
    expect(result.isFailed).toBe(false)
    expect(result.data.stopping).toBe(true)
    await closed
  })

  it('notifies users when the host server starts and stops', async () => {
    const { baseUrl, listener } = await startTestServer()
    const { socket, messages } = await openRecordedWebSocket(baseUrl)
    await waitForWebSocketMessages(messages, 1)
    expect(messages[0]).toMatchObject({
      type: 'system',
      text: 'Codexio server started.'
    })
    const closed = new Promise<void>((resolve) => {
      listener.once('close', resolve)
    })
    const response = await fetch(`${baseUrl}/api/server/stop`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${testToken}`
      }
    })
    const result = await response.json() as {
      isFailed: boolean
    }
    expect(result.isFailed).toBe(false)
    await waitForWebSocketMessages(messages, 2)
    expect(messages[1]).toMatchObject({
      type: 'system',
      text: 'Codexio server stopping.'
    })
    await closed
  })

  it('broadcasts agent output to every web connection', async () => {
    const { baseUrl, listener } = await startTestServer()
    const first = await openWebSocket(baseUrl)
    const second = await openWebSocket(baseUrl)
    const firstMessages = recordWebSocket(first)
    const secondMessages = recordWebSocket(second)
    const response = await fetch(`${baseUrl}/api/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${testToken}`
      },
      body: JSON.stringify({
        text: 'broadcast output'
      })
    })
    const result = await response.json() as {
      isFailed: boolean
    }
    await waitForWebSocketMessages(firstMessages, 1)
    await waitForWebSocketMessages(secondMessages, 1)
    const firstMessage = firstMessages[0]
    const secondMessage = secondMessages[0]
    expect(result.isFailed).toBe(false)
    expect(firstMessage).toMatchObject({
      type: 'agent',
      text: 'broadcast output'
    })
    expect(secondMessage).toMatchObject({
      type: 'agent',
      text: 'broadcast output'
    })
    await closeWebSocket(first)
    await closeWebSocket(second)
    await closeTestServer(listener)
  })

  it('broadcasts user input to every web connection', async () => {
    const { baseUrl, listener } = await startTestServer()
    const first = await openWebSocket(baseUrl)
    const second = await openWebSocket(baseUrl)
    const firstMessages = recordWebSocket(first)
    const secondMessages = recordWebSocket(second)
    first.send(JSON.stringify({
      text: 'shared input'
    }))
    await waitForWebSocketMessages(firstMessages, 3)
    await waitForWebSocketMessages(secondMessages, 3)
    expect(firstMessages[0]).toMatchObject({
      type: 'user',
      text: 'shared input'
    })
    expect(secondMessages[0]).toMatchObject({
      type: 'user',
      text: 'shared input'
    })
    expect(firstMessages[1]).toMatchObject({
      type: 'system',
      text: expect.any(String)
    })
    expect(secondMessages[1]).toMatchObject({
      type: 'system',
      text: expect.any(String)
    })
    expect(firstMessages[2]).toMatchObject({
      type: 'agent',
      text: 'test: shared input'
    })
    expect(secondMessages[2]).toMatchObject({
      type: 'agent',
      text: 'test: shared input'
    })
    await closeWebSocket(first)
    await closeWebSocket(second)
    await closeTestServer(listener)
  })

  it('restores latest channel manager messages in web channel', async () => {
    const { baseUrl, listener } = await startTestServer()
    const socket = await openWebSocket(baseUrl)
    const messages = recordWebSocket(socket)
    for (let index = 1; index <= 12; index += 1) {
      socket.send(JSON.stringify({
        text: `message ${index}`
      }))
      await waitForWebSocketMessages(messages, index * 3)
    }
    const restored: Array<Record<string, unknown>> = []
    const restoredUrl = baseUrl.replace('http://', 'ws://').replace('https://', 'wss://')
    const restoredSocket = new WebSocket(`${restoredUrl}/ws`)
    await new Promise<void>((resolve, reject) => {
      restoredSocket.on('message', (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>
        if (message.type !== 'ready') {
          restored.push(message)
        }
        if (restored.length === 20) {
          resolve()
        }
      })
      restoredSocket.once('error', reject)
    })
    await new Promise((resolve) => {
      setTimeout(resolve, 50)
    })
    expect(restored).toHaveLength(20)
    expect(restored[0]).toMatchObject({
      type: 'system',
      text: expect.any(String)
    })
    expect(restored[1]).toMatchObject({
      type: 'agent',
      text: 'test: message 6'
    })
    expect(restored[2]).toMatchObject({
      type: 'user',
      text: 'message 7'
    })
    expect(restored[19]).toMatchObject({
      type: 'agent',
      text: 'test: message 12'
    })
    await closeWebSocket(restoredSocket)
    await closeWebSocket(socket)
    await closeTestServer(listener)
  })

  it('does not expose legacy inbound API', async () => {
    const { baseUrl, listener } = await startTestServer()
    const response = await fetch(`${baseUrl}/api/messages/inbound`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        channel: 'cli',
        text: 'hello'
      })
    })
    expect(response.status).toBe(404)
    await closeTestServer(listener)
  })

  it('rejects invalid startup config before listening', () => {
    const config = ConfigSchema.parse({
      server: {
        token: testToken
      },
      agents: {
        codex: {
          enabled: true
        },
        claude: {
          enabled: true
        }
      },
      channels: {
        web: {
          enabled: true
        }
      },
      workspace: {
        path: '.'
      }
    })
    expect(() => createCodexioApp(config)).toThrow('only one agent can be enabled')
  })

  it('selects the next server port when the preferred port is occupied', async () => {
    const occupied = createNetServer()
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject)
      occupied.listen(0, '127.0.0.1', resolve)
    })
    try {
      const address = occupied.address()
      if (!address || typeof address === 'string') {
        throw new Error('occupied server address not found')
      }
      const port = await resolveAvailableServerPort('127.0.0.1', address.port)
      expect(port).toBeGreaterThan(address.port)
    } finally {
      await closeTestServer(occupied)
    }
  })

  it('requests application restart through the running supervisor', async () => {
    const token = 'supervisor-token'
    const requested: string[] = []
    const http = await new Promise<HttpServer>((resolve, reject) => {
      const server = new HttpServer((request, response) => {
        if (request.headers.authorization !== `Bearer ${token}`) {
          response.statusCode = 401
          response.end(JSON.stringify({
            isFailed: true,
            message: 'unauthorized'
          }))
          return
        }
        if (request.method === 'GET' && request.url === '/status') {
          response.end(JSON.stringify({
            isFailed: false,
            data: {
              pid: process.pid
            }
          }))
          return
        }
        if (request.method === 'POST' && request.url === '/restart') {
          requested.push('restart')
          response.end(JSON.stringify({
            isFailed: false,
            data: {
              accepted: true,
              action: 'restart'
            }
          }))
          return
        }
        response.statusCode = 404
        response.end(JSON.stringify({
          isFailed: true,
          message: 'not found'
        }))
      })
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        resolve(server)
      })
    })
    try {
      const address = http.address()
      if (!address || typeof address === 'string') {
        throw new Error('supervisor address not found')
      }
      const dir = await mkdtemp(join(tmpdir(), 'codexio-supervisor-'))
      const configPath = join(dir, 'config.yaml')
      await writeSupervisorState(configPath, {
        pid: process.pid,
        host: '127.0.0.1',
        port: address.port,
        token,
        startedAt: new Date().toISOString()
      })

      const state = await restartServer(configPath)

      expect(state.port).toBe(address.port)
      expect(requested).toEqual([
        'restart'
      ])
    } finally {
      await closeTestServer(http)
    }
  })

  it('resolves source and built serve process commands without npm restart branching', () => {
    const configPath = join(codexioRootPath, '.codexio', 'config.yaml')
    const sourceEntryPath = join(codexioRootPath, 'src', 'index.ts')
    const builtEntryPath = join(codexioRootPath, 'dist', 'index.js')
    const source = createServeProcessSpec(configPath, sourceEntryPath)
    expect(source.command).toBe(process.execPath)
    expect(source.args.slice(1)).toEqual([
      join('src', 'index.ts'),
      'serve',
      '--config',
      configPath
    ])
    expect(source.args[0]).toContain(join('tsx', 'dist', 'cli.mjs'))

    const built = createServeProcessSpec(configPath, builtEntryPath)
    expect(built.command).toBe(process.execPath)
    expect(built.args).toEqual([
      builtEntryPath,
      'serve',
      '--config',
      configPath
    ])

    const dev = createServeProcessSpec(configPath, sourceEntryPath, {
      autoPort: true
    })
    expect(dev.args).toContain('--auto-port')
  })
})

async function startTestServer(applicationLifecycle: {
  restart: () => Promise<{
    code: string
    message: string
    data: string | null
    isFailed: boolean
  }>
} | null = {
  restart: async () => ({
    code: '1',
    message: 'no error',
    data: 'Codexio restart requested through supervisor 127.0.0.1:10000',
    isFailed: false
  })
}): Promise<{
  baseUrl: string
  listener: HttpServer
}> {
  const config = ConfigSchema.parse({
    server: {
      token: testToken
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
      web: {
        enabled: true
      }
    },
    workspace: {
      path: '.'
    }
  })
  const server = createCodexioApp(config, {
    agentFactory: () => new TestAgent(async (text) => {
      await server.channelManager.send(text)
    }),
    applicationLifecycle: applicationLifecycle ?? undefined
  })
  const listener = server.listen(0)
  await new Promise<void>((resolve) => listener.once('listening', resolve))
  const address = listener.address()
  if (!address || typeof address === 'string') {
    throw new Error('server address not found')
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    listener
  }
}

async function openWebSocket(baseUrl: string): Promise<WebSocket> {
  const url = baseUrl.replace('http://', 'ws://').replace('https://', 'wss://')
  const socket = new WebSocket(`${url}/ws`)
  await new Promise<void>((resolve, reject) => {
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>
      if (message.type === 'ready') {
        resolve()
      }
    })
    socket.once('error', reject)
  })
  return socket
}

async function openRecordedWebSocket(baseUrl: string): Promise<{
  socket: WebSocket
  messages: Array<Record<string, unknown>>
}> {
  const url = baseUrl.replace('http://', 'ws://').replace('https://', 'wss://')
  const socket = new WebSocket(`${url}/ws`)
  const messages = recordRawWebSocket(socket)
  await new Promise<void>((resolve, reject) => {
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>
      if (message.type === 'ready') {
        resolve()
      }
    })
    socket.once('error', reject)
  })
  return {
    socket,
    messages
  }
}

function recordWebSocket(socket: WebSocket): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = []
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString()) as Record<string, unknown>
    if (message.type !== 'ready' && message.text !== 'Codexio server started.' && message.text !== 'Codexio server stopping.') {
      messages.push(message)
    }
  })
  return messages
}

function recordRawWebSocket(socket: WebSocket): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = []
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString()) as Record<string, unknown>
    if (message.type !== 'ready') {
      messages.push(message)
    }
  })
  return messages
}

async function waitForWebSocketMessages(messages: Array<Record<string, unknown>>, count: number): Promise<void> {
  const startedAt = Date.now()
  while (messages.length < count) {
    if (Date.now() - startedAt > 4000) {
      throw new Error(`websocket message timeout: ${messages.length}/${count}`)
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 5)
    })
  }
}

async function closeWebSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return
  }
  await new Promise<void>((resolve) => {
    socket.once('close', resolve)
    socket.close()
  })
}

async function closeTestServer(listener: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    listener.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}
