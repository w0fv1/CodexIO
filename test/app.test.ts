import { describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { Server as HttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexioMetadata } from '../src/component/CodexioMetadata.js'
import { resolveAvailableServerPort } from '../src/util/Network.js'
import { webPageHtml } from '../src/channel/WebPage.js'
import { TestAgent } from './TestAgent.js'
import { Logger } from '../src/component/Logger.js'
import { Configer } from '../src/component/Configer.js'
import { Result } from '../src/value/Result.js'
import { ChannelInputManager } from '../src/channel/ChannelInputManager.js'
import { ChannelOutputManager } from '../src/channel/ChannelOutputManager.js'
import { AgentManager } from '../src/agent/AgentManager.js'
import { CodexioApiController } from '../src/controller/CodexioApiController.js'
import { Agent } from '../src/agent/Agent.js'
import { FileStore } from '../src/component/FileStore.js'
import { ThreadManager } from '../src/component/ThreadManager.js'
import { ThreadMessageStore } from '../src/component/ThreadMessageStore.js'
import { CommandExecutor } from '../src/controller/CommandExecutor.js'
import { Updater } from '../src/component/Updater.js'
import { WebChannelHub, WebChannelInput, WebChannelOutput } from '../src/channel/WebChannel.js'
import { FeishuChannelHub, FeishuChannelInput, FeishuChannelOutput } from '../src/channel/FeishuChannel.js'
import { FeishuWebhookChannelOutput } from '../src/channel/FeishuWebhookChannel.js'
import { EmailChannelHub, EmailChannelInput, EmailChannelOutput } from '../src/channel/EmailChannel.js'
import { EventBus } from '../src/component/EventBus.js'
import { AppEvent } from '../src/value/Event.js'

const testToken = 'test-message-token'
const testMetadata = new CodexioMetadata()
const codexioRootPath = testMetadata.rootPath
const testServerStops = new WeakMap<HttpServer, () => Promise<Result<null>>>()

describe('server', () => {
  it('serves a compact Codexio web chat page', () => {
    expect(webPageHtml).toContain('Codexio')
    expect(webPageHtml).toContain('id="messages"')
    expect(webPageHtml).toContain('id="form"')
    expect(webPageHtml).toContain('id="threads"')
    expect(webPageHtml).toContain('sidebarOpen')
    expect(webPageHtml).toContain('activeThreadTitle()')
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
    expect(webPageHtml).not.toContain('>Ready</div>')
    expect(webPageHtml).not.toContain('href="/config"')
    expect(webPageHtml).not.toContain('打开配置')
    expect(webPageHtml).not.toContain('rounded-2xl border p-2')
    expect(webPageHtml).not.toContain('border-b p-3')
    expect(webPageHtml).not.toContain('border-r transition-transform')
    expect(webPageHtml).toContain("if (message.role === 'system')")
    expect(webPageHtml).toContain('whitespace-pre-wrap break-words')
    expect(webPageHtml).toContain('@paste="handlePaste($event)"')
    expect(webPageHtml).toContain('@drop.prevent="handleDrop($event)"')
    expect(webPageHtml).toContain('multiple')
    expect(webPageHtml).toContain('uploadSelectedFiles')
    expect(webPageHtml).toContain('title="上传文件"')
    expect(webPageHtml).toContain('isImageFile(file)')
    expect(webPageHtml).toContain('formatFileSize')
    expect(webPageHtml).not.toContain('overflow-x-auto')
    expect(webPageHtml).toContain('m16 6-8.4 8.4')
    expect(webPageHtml).not.toContain('<circle cx="9" cy="9" r="2"/>')
    expect(webPageHtml).not.toContain('m21 15-3.1-3.1')
    const userTemplateIndex = webPageHtml.indexOf('<template x-if="message.type === \'user\'">')
    const userActionIndex = webPageHtml.indexOf('class="message-actions', userTemplateIndex)
    const userBubbleIndex = webPageHtml.indexOf('class="min-w-0 rounded-2xl rounded-br-md', userTemplateIndex)
    expect(userActionIndex).toBeGreaterThan(userTemplateIndex)
    expect(userActionIndex).toBeLessThan(userBubbleIndex)
    const agentTemplateIndex = webPageHtml.indexOf('<template x-if="message.type === \'agent\'">')
    const agentBubbleIndex = webPageHtml.indexOf('class="min-w-0 break-words rounded-2xl rounded-bl-md', agentTemplateIndex)
    const agentActionIndex = webPageHtml.indexOf('class="message-actions', agentTemplateIndex)
    expect(agentActionIndex).toBeGreaterThan(agentBubbleIndex)
  })

  it('logs the web page url when the web channel starts', async () => {
    const info = vi.spyOn(Logger, 'info').mockImplementation(() => {})
    const { listener } = await startTestServer()
    try {
      expect(info).toHaveBeenCalledWith('web channel ready', {
        host: '127.0.0.1',
        port: 8787,
        url: 'http://127.0.0.1:8787'
      })
    } finally {
      info.mockRestore()
      await closeTestServer(listener)
    }
  })

  it('starts the selected agent when the application starts', async () => {
    const started: string[] = []
    class StartupAgent extends TestAgent {
      override async start(): Promise<void> {
        started.push('started')
      }
    }
    const { listener } = await startTestServer(new StartupAgent())
    try {
      expect(started).toEqual([
        'started'
      ])
    } finally {
      await closeTestServer(listener)
    }
  })

  it('receives web text', async () => {
    const { baseUrl, listener } = await startTestServer()
    const socket = await openWebSocket(baseUrl)
    const messages = recordWebSocket(socket)
    socket.send(JSON.stringify({
      ioThreadId: 'io-thread',
      text: 'hello'
    }))
    await waitForWebSocketMessages(messages, 3)
    expect(messages[0]).toMatchObject({
      event: 'message',
      role: 'user',
      ioThreadId: 'io-thread',
      text: 'hello'
    })
    expect(messages[1]).toMatchObject({
      event: 'message',
      role: 'system',
      text: expect.any(String)
    })
    expect(messages[2]).toMatchObject({
      event: 'message',
      role: 'agent',
      ioThreadId: 'io-thread',
      text: 'test: hello'
    })
    await closeWebSocket(socket)
    await closeTestServer(listener)
  })

  it('routes web messages by explicit thread id', async () => {
    const { baseUrl, listener } = await startTestServer()
    const socket = await openWebSocket(baseUrl)
    const messages = recordWebSocket(socket)
    socket.send(JSON.stringify({
      ioThreadId: 'io-thread-a',
      text: 'first'
    }))
    socket.send(JSON.stringify({
      ioThreadId: 'io-thread-b',
      text: 'second'
    }))
    await waitForWebSocketMessages(messages, 6)
    expect(messages.find((message) => message.ioThreadId === 'io-thread-a' && message.role === 'user')).toMatchObject({
      event: 'message',
      role: 'user',
      ioThreadId: 'io-thread-a',
      text: 'first'
    })
    expect(messages.find((message) => message.ioThreadId === 'io-thread-a' && message.role === 'agent')).toMatchObject({
      event: 'message',
      role: 'agent',
      ioThreadId: 'io-thread-a',
      text: 'test: first'
    })
    expect(messages.find((message) => message.ioThreadId === 'io-thread-b' && message.role === 'user')).toMatchObject({
      event: 'message',
      role: 'user',
      ioThreadId: 'io-thread-b',
      text: 'second'
    })
    expect(messages.find((message) => message.ioThreadId === 'io-thread-b' && message.role === 'agent')).toMatchObject({
      event: 'message',
      role: 'agent',
      ioThreadId: 'io-thread-b',
      text: 'test: second'
    })
    await closeWebSocket(socket)
    await closeTestServer(listener)
  })

  it('streams thread metadata separately from messages', async () => {
    const { baseUrl, listener } = await startTestServer()
    const { socket, messages } = await openRecordedWebSocket(baseUrl)

    await waitFor(() => messages.some((message) => message.event === 'threads'))
    socket.send(JSON.stringify({
      ioThreadId: 'thread-metadata-test',
      text: 'hello'
    }))
    await waitFor(() => messages.some((message) => message.event === 'thread' && (message.thread as { id?: string })?.id === 'thread-metadata-test'))

    expect(messages.find((message) => message.event === 'threads')).toMatchObject({
      event: 'threads',
      threads: expect.any(Array)
    })
    expect(messages.find((message) => message.event === 'thread' && (message.thread as { id?: string })?.id === 'thread-metadata-test')).toMatchObject({
      event: 'thread',
      thread: {
        id: 'thread-metadata-test',
        title: '',
        isWorking: false
      }
    })

    await closeWebSocket(socket)
    await closeTestServer(listener)
  })

  it('receives web image files', async () => {
    const { baseUrl, listener } = await startTestServer()
    const socket = await openWebSocket(baseUrl)
    const messages = recordWebSocket(socket)
    const form = new FormData()
    form.append('file', new Blob([pngBytes()], {
      type: 'image/png'
    }), 'web.png')
    const uploadResponse = await fetch(`${baseUrl}/api/files`, {
      method: 'POST',
      body: form
    })
    const upload = await uploadResponse.json() as {
      isFailed: boolean
      data: {
        file: {
          id: string
          mime: string
          name: string
          size: number
          sha256: string
          path: string
          url: string
        }
      }
    }
    expect(upload.isFailed).toBe(false)
    expect(upload.data.file).toMatchObject({
      mime: 'image/png',
      name: 'web.png',
      size: pngBytes().length,
      url: `/api/files/${upload.data.file.id}`
    })
    socket.send(JSON.stringify({
      ioThreadId: 'io-thread-image',
      text: 'image input',
      files: [
        upload.data.file.id
      ]
    }))
    await waitForWebSocketMessages(messages, 3)
    expect(messages[0]).toMatchObject({
      event: 'message',
      role: 'user',
      ioThreadId: 'io-thread-image',
      text: 'image input',
      files: [
        {
          id: upload.data.file.id,
          mime: 'image/png',
          url: `/api/files/${upload.data.file.id}`
        }
      ]
    })
    expect(messages[2]).toMatchObject({
      event: 'message',
      role: 'agent',
      ioThreadId: 'io-thread-image',
      text: 'test: image input'
    })
    await closeWebSocket(socket)
    await closeTestServer(listener)
  })

  it('receives web generic files', async () => {
    const { baseUrl, listener } = await startTestServer()
    const socket = await openWebSocket(baseUrl)
    const messages = recordWebSocket(socket)
    const form = new FormData()
    form.append('file', new Blob(['hello file'], {
      type: 'text/plain'
    }), 'note.txt')
    const uploadResponse = await fetch(`${baseUrl}/api/files`, {
      method: 'POST',
      body: form
    })
    const upload = await uploadResponse.json() as {
      isFailed: boolean
      data: {
        file: {
          id: string
          mime: string
          name: string
          size: number
          sha256: string
          path: string
          url: string
        }
      }
    }
    expect(upload.isFailed).toBe(false)
    expect(upload.data.file).toMatchObject({
      mime: 'text/plain',
      name: 'note.txt',
      size: 'hello file'.length,
      url: `/api/files/${upload.data.file.id}`
    })
    socket.send(JSON.stringify({
      ioThreadId: 'io-thread-file',
      text: 'file input',
      files: [
        upload.data.file.id
      ]
    }))
    await waitForWebSocketMessages(messages, 3)
    expect(messages[0]).toMatchObject({
      event: 'message',
      role: 'user',
      ioThreadId: 'io-thread-file',
      text: 'file input',
      files: [
        {
          id: upload.data.file.id,
          mime: 'text/plain',
          url: `/api/files/${upload.data.file.id}`
        }
      ]
    })
    const fileResponse = await fetch(`${baseUrl}${upload.data.file.url}`)
    expect(fileResponse.headers.get('content-type')).toContain('text/plain')
    expect(await fileResponse.text()).toBe('hello file')
    await closeWebSocket(socket)
    await closeTestServer(listener)
  })

  it('clears the active agent conversation', async () => {
    const { baseUrl, listener } = await startTestServer()
    const socket = await openWebSocket(baseUrl)
    const messages = recordWebSocket(socket)
    socket.send(JSON.stringify({
      ioThreadId: 'io-thread-clear',
      text: 'first'
    }))
    await waitForWebSocketMessages(messages, 3)
    socket.send(JSON.stringify({
      ioThreadId: 'io-thread-clear',
      text: '$ clear'
    }))
    await waitForWebSocketMessages(messages, 5)
    const clear = messages[4]
    socket.send(JSON.stringify({
      ioThreadId: 'io-thread-clear',
      text: 'second'
    }))
    await waitForWebSocketMessages(messages, 8)
    const second = messages[7]
    expect(clear).toMatchObject({
      event: 'clear'
    })
    expect(second).toMatchObject({
      event: 'message',
      role: 'agent',
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
      ioThreadId: 'io-thread-yuan-clear',
      text: 'first'
    }))
    await waitForWebSocketMessages(messages, 3)
    socket.send(JSON.stringify({
      ioThreadId: 'io-thread-yuan-clear',
      text: '￥clear'
    }))
    await waitForWebSocketMessages(messages, 5)
    expect(messages[4]).toMatchObject({
      event: 'clear'
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
    await waitForWebSocketMessages(messages, 1)
    expect(messages[0]).toMatchObject({
      event: 'message',
      role: 'user',
      text: '￥help'
    })
    expect(messages[1]).toMatchObject({
      event: 'message',
      role: 'system',
      text: expect.stringContaining('$update / ￥update')
    })
    socket.send(JSON.stringify({
      text: '￥?'
    }))
    await waitForWebSocketMessages(messages, 4)
    expect(messages[2]).toMatchObject({
      event: 'message',
      role: 'user',
      text: '￥?'
    })
    expect(messages[3]).toMatchObject({
      event: 'message',
      role: 'system',
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
    const webPort = await resolveAvailableServerPort('127.0.0.1', 19788)
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
      '    host: 127.0.0.1',
      `    port: ${webPort}`,
      'workspace:',
      `  path: ${workspace}`
    ].join('\n'), 'utf8')
    const server = await createTestCodexioApp(createTestConfiger(configPath), new TestAgent(async () => {}))
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
    expect(pageText).not.toContain('返回会话')
    expect(pageText).not.toContain('/api/config/actions/')

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
        message: string
      }
    }
    expect(patchResult.isFailed).toBe(false)
    expect(patchResult.data.changedPaths).toContain('proxy.port')
    expect(patchResult.data.message).toContain('proxy.port')
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
        message: string
      }
    }
    expect(importResult.isFailed).toBe(false)
    expect(importResult.data.changedPaths).toContain('update.baseUrl')
    expect(importResult.data.message).toContain('update.baseUrl')
    expect(await readFile(configPath, 'utf8')).toContain('baseUrl: https://import.example.test')
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

  it('does not notify connected users when the host server stops', async () => {
    const { baseUrl, listener } = await startTestServer()
    const { messages } = await openRecordedWebSocket(baseUrl)
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
    await closed
    expect(messages.filter((message) => ![
      'threads',
      'messages'
    ].includes(String(message.event)))).toEqual([])
  })

  it('broadcasts user input to every web connection', async () => {
    const { baseUrl, listener } = await startTestServer()
    const first = await openWebSocket(baseUrl)
    const second = await openWebSocket(baseUrl)
    const firstMessages = recordWebSocket(first)
    const secondMessages = recordWebSocket(second)
    first.send(JSON.stringify({
      ioThreadId: 'io-thread-shared',
      text: 'shared input'
    }))
    await waitForWebSocketMessages(firstMessages, 3)
    await waitForWebSocketMessages(secondMessages, 3)
    expect(firstMessages[0]).toMatchObject({
      event: 'message',
      role: 'user',
      ioThreadId: 'io-thread-shared',
      text: 'shared input'
    })
    expect(secondMessages[0]).toMatchObject({
      event: 'message',
      role: 'user',
      ioThreadId: 'io-thread-shared',
      text: 'shared input'
    })
    expect(firstMessages[1]).toMatchObject({
      event: 'message',
      role: 'system',
      text: expect.any(String)
    })
    expect(secondMessages[1]).toMatchObject({
      event: 'message',
      role: 'system',
      text: expect.any(String)
    })
    expect(firstMessages[2]).toMatchObject({
      event: 'message',
      role: 'agent',
      ioThreadId: 'io-thread-shared',
      text: 'test: shared input'
    })
    expect(secondMessages[2]).toMatchObject({
      event: 'message',
      role: 'agent',
      ioThreadId: 'io-thread-shared',
      text: 'test: shared input'
    })
    await closeWebSocket(first)
    await closeWebSocket(second)
    await closeTestServer(listener)
  })

  it('restores channel manager messages in new web connections', async () => {
    const { baseUrl, listener } = await startTestServer()
    const socket = await openWebSocket(baseUrl)
    const messages = recordWebSocket(socket)
    for (let index = 1; index <= 12; index += 1) {
      socket.send(JSON.stringify({
        ioThreadId: 'io-thread-history',
        text: `message ${index}`
      }))
      await waitForWebSocketMessages(messages, index * 3)
    }
    const restored = await openRecordedWebSocket(baseUrl)
    await waitFor(() => restored.messages.some((message) => message.event === 'messages'))
    const snapshot = restored.messages.find((message) => message.event === 'messages') as {
      messages?: Array<Record<string, unknown>>
    }
    expect(snapshot.messages).toHaveLength(36)
    expect(snapshot.messages?.find((message) => message.event === 'message' && message.role === 'agent' && message.ioThreadId === 'io-thread-history')).toMatchObject({
      text: 'test: message 1'
    })
    await closeWebSocket(restored.socket)
    await closeWebSocket(socket)
    await closeTestServer(listener)
  })

  it('rejects invalid startup config before listening', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-invalid-config-'))
    const configPath = join(dir, 'config.yaml')
    await writeFile(configPath, [
      'server:',
      `  token: ${testToken}`,
      'agents:',
      '  codex:',
      '    enabled: true',
      '  claude:',
      '    enabled: true',
      'channels:',
      '  web:',
      '    enabled: true',
      'workspace:',
      '  path: .'
    ].join('\n'), 'utf8')
    await expect(createTestCodexioApp(createTestConfiger(configPath), new TestAgent(async () => {}))).rejects.toThrow('only one agent can be enabled')
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

})

async function startTestServer(agent = new TestAgent()): Promise<{
  baseUrl: string
  configPath: string
  listener: HttpServer
}> {
  const dir = await mkdtemp(join(tmpdir(), 'codexio-server-'))
  const workspace = join(dir, 'workspace')
  const configPath = join(dir, 'config.yaml')
  await writeFile(configPath, [
    'server:',
    `  token: ${testToken}`,
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
  const server = await createTestCodexioApp(createTestConfiger(configPath), agent)
  const listener = server.listen(0)
  await new Promise<void>((resolve) => listener.once('listening', resolve))
  const address = listener.address()
  if (!address || typeof address === 'string') {
    throw new Error('server address not found')
  }
  const baseUrl = `http://127.0.0.1:${address.port}`
  return {
    baseUrl,
    configPath,
    listener
  }
}

function createTestConfiger(configPath: string): Configer {
  return new Configer(new CodexioMetadata({
    rootPath: testMetadata.rootPath,
    configPath
  }))
}

async function createTestCodexioApp(configer: Configer, claudeAgent: Agent): Promise<{
  listen: (port?: number, host?: string) => HttpServer
  stop: () => Promise<Result<null>>
}> {
  await configer.validate()
  const metadata = new CodexioMetadata({
    rootPath: testMetadata.rootPath,
    configPath: configer.path
  })
  const eventBus = new EventBus()
  const fileStore = new FileStore(metadata)
  const threadManager = new ThreadManager()
  const webHub = new WebChannelHub(fileStore, threadManager, new ThreadMessageStore())
  const webInput = new WebChannelInput(configer, webHub)
  const webOutput = new WebChannelOutput(configer, webHub)
  const feishuHub = new FeishuChannelHub(configer)
  const feishuInput = new FeishuChannelInput(feishuHub)
  const feishuOutput = new FeishuChannelOutput(feishuHub)
  const emailHub = new EmailChannelHub(configer)
  const emailInput = new EmailChannelInput(emailHub)
  const emailOutput = new EmailChannelOutput(emailHub)
  const outputManager = new ChannelOutputManager(
    configer,
    fileStore,
    webOutput,
    feishuOutput,
    new FeishuWebhookChannelOutput(configer),
    emailOutput
  )
  if (claudeAgent instanceof TestAgent) {
    claudeAgent.setSend(async (message) => {
      const sent = await outputManager.sendAgent(message)
      if (sent.isFailed) {
        throw new Error(sent.message)
      }
    })
  }
  const agentManager = new AgentManager(configer, outputManager, claudeAgent, claudeAgent)
  const updater = new Updater(configer, metadata, outputManager)
  const commandExecutor = new CommandExecutor(outputManager, agentManager, updater)
  const inputManager = new ChannelInputManager(configer, outputManager, commandExecutor, webInput, feishuInput, emailInput)
  const apiController = new CodexioApiController(configer, outputManager, agentManager, fileStore, webHub, eventBus)
  await outputManager.start()
  await inputManager.start()
  await agentManager.start()
  const stop = async () => {
    await ignoreStopFailure(apiController.stop())
    await ignoreStopFailure(inputManager.stop())
    await ignoreStopFailure(agentManager.stop())
    await ignoreStopFailure(outputManager.stop())
    return Result.success(null)
  }
  eventBus.on(AppEvent.StopRequested, () => {
    void stop()
  })
  return {
    listen: (port?: number, host?: string) => {
      const listener = apiController.listen(port, host)
      testServerStops.set(listener, stop)
      return listener
    },
    stop
  }
}

async function ignoreStopFailure(action: Promise<Result<null>>): Promise<void> {
  await action.catch(() => Result.fail('stop failed'))
}

async function openWebSocket(baseUrl: string): Promise<WebSocket> {
  const url = baseUrl.replace('http://', 'ws://').replace('https://', 'wss://')
  const socket = new WebSocket(`${url}/ws`)
  await new Promise<void>((resolve, reject) => {
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>
      if (message.event === 'ready') {
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
      if (message.event === 'ready') {
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
    if (![
      'ready',
      'threads',
      'messages',
      'thread',
      'threadDeleted'
    ].includes(String(message.event))) {
      messages.push(message)
    }
  })
  return messages
}

function recordRawWebSocket(socket: WebSocket): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = []
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString()) as Record<string, unknown>
    if (message.event !== 'ready') {
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
  const stop = testServerStops.get(listener)
  if (stop) {
    testServerStops.delete(listener)
    const result = await stop()
    if (result.isFailed) {
      throw new Error(result.message)
    }
    return
  }
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

function pngBytes(): Buffer {
  return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lS3KgwAAAABJRU5ErkJggg==', 'base64')
}

