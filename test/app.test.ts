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
import { createServeProcessSpec, readRunningSupervisorState, readSupervisorState, restartServer, stopServer, writeRuntimeServerState, writeSupervisorState } from '../src/component/ServerLifecycle.js'
import { webPageHtml } from '../src/channel/WebPage.js'
import { TestAgent } from './TestAgent.js'
import { ConfigAction } from '../src/config/ConfigAction.js'

const testToken = 'test-message-token'
const webBaseUrls = new Map<string, string>()

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
    expect(webPageHtml).toContain('@paste="handlePaste($event)"')
    expect(webPageHtml).toContain('@drop.prevent="handleDrop($event)"')
    expect(webPageHtml).toContain('multiple')
    expect(webPageHtml).toContain('uploadSelectedFiles')
    expect(webPageHtml).toContain('title="上传文件"')
    expect(webPageHtml).toContain('isImageFile(file)')
    expect(webPageHtml).toContain('formatFileSize')
    expect(webPageHtml).toContain('m16 6-8.4 8.4')
    expect(webPageHtml).not.toContain('<circle cx="9" cy="9" r="2"/>')
    expect(webPageHtml).not.toContain('m21 15-3.1-3.1')
    const userTemplateIndex = webPageHtml.indexOf('<template x-if="message.type === \'user\'">')
    const userActionIndex = webPageHtml.indexOf('class="message-actions shrink-0 pt-1"', userTemplateIndex)
    const userBubbleIndex = webPageHtml.indexOf('class="user-bubble', userTemplateIndex)
    expect(userActionIndex).toBeGreaterThan(userTemplateIndex)
    expect(userActionIndex).toBeLessThan(userBubbleIndex)
    const agentTemplateIndex = webPageHtml.indexOf('<template x-if="message.type === \'agent\'">')
    const agentBubbleIndex = webPageHtml.indexOf('class="agent-bubble', agentTemplateIndex)
    const agentActionIndex = webPageHtml.indexOf('class="message-actions shrink-0 pt-1"', agentTemplateIndex)
    expect(agentActionIndex).toBeGreaterThan(agentBubbleIndex)
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
      text: 'image input',
      files: [
        upload.data.file.id
      ]
    }))
    await waitForWebSocketMessages(messages, 3)
    expect(messages[0]).toMatchObject({
      type: 'user',
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
      type: 'agent',
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
      text: 'file input',
      files: [
        upload.data.file.id
      ]
    }))
    await waitForWebSocketMessages(messages, 3)
    expect(messages[0]).toMatchObject({
      type: 'user',
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
          enabled: true,
          host: '127.0.0.1',
          port: webPort
        }
      },
      workspace: {
        path: workspace
      }
    })
    const server = createCodexioApp(config, {
      configPath,
      agentFactory: () => new TestAgent(async () => {}),
      configActions: [
        {
          descriptor: {
            id: 'test.action',
            group: 'Feishu',
            label: '测试消息和图片'
          },
          run: async () => ({
            code: '1',
            message: 'no error',
            data: {
              message: '测试完成'
            },
            isFailed: false
          })
        } satisfies ConfigAction
      ]
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
    expect(pageText).toContain('/api/config/actions/')

    const readResponse = await fetch(`${baseUrl}/api/config`)
    const readResult = await readResponse.json() as {
      isFailed: boolean
      data: {
        descriptor: Array<{ path: string }>
        actions: Array<{ id: string, group: string, label: string }>
      }
    }
    expect(readResult.isFailed).toBe(false)
    expect(readResult.data.descriptor.some((item) => item.path === 'proxy.port')).toBe(true)
    expect(readResult.data.actions).toContainEqual({
      id: 'test.action',
      group: 'Feishu',
      label: '测试消息和图片'
    })

    const actionResponse = await fetch(`${baseUrl}/api/config/actions/test.action`, {
      method: 'POST'
    })
    const actionResult = await actionResponse.json() as {
      isFailed: boolean
      data: {
        message: string
      }
    }
    expect(actionResult.isFailed).toBe(false)
    expect(actionResult.data.message).toBe('测试完成')

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

  it('accepts agent image output through local paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-agent-image-'))
    const imagePath = join(dir, 'agent.png')
    await writeFile(imagePath, pngBytes())
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
        text: 'agent image',
        files: [
          {
            path: imagePath
          }
        ]
      })
    })
    const result = await response.json() as {
      isFailed: boolean
      data: {
        sent: boolean
        files: Array<{
          id: string
          mime: string
          url: string
        }>
      }
    }
    await waitForWebSocketMessages(messages, 1)
    expect(result.isFailed).toBe(false)
    expect(result.data.sent).toBe(true)
    expect(result.data.files[0]).toMatchObject({
      mime: 'image/png',
      url: `/api/files/${result.data.files[0].id}`
    })
    expect(messages[0]).toMatchObject({
      type: 'agent',
      text: 'agent image',
      files: [
        {
          id: result.data.files[0].id,
          mime: 'image/png',
          url: `/api/files/${result.data.files[0].id}`
        }
      ]
    })
    const fileResponse = await fetch(`${baseUrl}${result.data.files[0].url}`)
    expect(fileResponse.headers.get('content-type')).toContain('image/png')
    expect(Buffer.from(await fileResponse.arrayBuffer()).equals(pngBytes())).toBe(true)
    await closeWebSocket(socket)
    await closeTestServer(listener)
  })

  it('promotes local file markdown images to channel files', async () => {
    const { baseUrl, listener } = await startTestServer()
    const socket = await openWebSocket(baseUrl)
    const messages = recordWebSocket(socket)
    const form = new FormData()
    form.append('file', new Blob([pngBytes()], {
      type: 'image/png'
    }), 'agent-markdown.png')
    const uploadResponse = await fetch(`${baseUrl}/api/files`, {
      method: 'POST',
      body: form
    })
    const upload = await uploadResponse.json() as {
      isFailed: boolean
      data: {
        file: {
          id: string
          url: string
        }
      }
    }
    expect(upload.isFailed).toBe(false)

    const response = await fetch(`${baseUrl}/api/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${testToken}`
      },
      body: JSON.stringify({
        text: `图片如下：\n\n![agent image](${upload.data.file.url})`
      })
    })
    const result = await response.json() as {
      isFailed: boolean
    }

    await waitForWebSocketMessages(messages, 1)
    expect(result.isFailed).toBe(false)
    expect(messages[0]).toMatchObject({
      type: 'agent',
      text: '图片如下：',
      files: [
        {
          id: upload.data.file.id,
          url: upload.data.file.url
        }
      ]
    })
    expect(JSON.stringify(messages[0])).not.toContain('![agent image]')
    await closeWebSocket(socket)
    await closeTestServer(listener)
  })

  it('promotes local image paths in agent text to channel files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-agent-path-image-'))
    const imagePath = join(dir, 'agent-output.png')
    await writeFile(imagePath, pngBytes())
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
        text: `截图预览：\n\n截图预览 ${imagePath.replaceAll('\\', '/')}`
      })
    })
    const result = await response.json() as {
      isFailed: boolean
    }

    await waitForWebSocketMessages(messages, 1)
    expect(result.isFailed).toBe(false)
    expect(messages[0]).toMatchObject({
      type: 'agent',
      text: '截图预览：\n\n截图预览',
      files: [
        {
          mime: 'image/png',
          name: 'agent-output.png',
          url: expect.stringMatching(/^\/api\/files\//)
        }
      ]
    })
    expect(JSON.stringify(messages[0])).not.toContain(imagePath.replaceAll('\\', '/'))
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

  it('notifies connected users when the host server stops', async () => {
    const { baseUrl, listener } = await startTestServer()
    const { socket, messages } = await openRecordedWebSocket(baseUrl)
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
    await waitForWebSocketMessages(messages, 1)
    expect(messages[0]).toMatchObject({
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

  it('does not restore channel manager messages in new web connections', async () => {
    const { baseUrl, listener } = await startTestServer()
    const socket = await openWebSocket(baseUrl)
    const messages = recordWebSocket(socket)
    for (let index = 1; index <= 12; index += 1) {
      socket.send(JSON.stringify({
        text: `message ${index}`
      }))
      await waitForWebSocketMessages(messages, index * 3)
    }
    const restoredSocket = await openWebSocket(baseUrl)
    const restored = recordWebSocket(restoredSocket)
    await new Promise((resolve) => {
      setTimeout(resolve, 50)
    })
    expect(restored).toHaveLength(0)
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

  it('waits for supervisor stop before returning', async () => {
    const token = 'supervisor-token'
    let stopped = false
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
        if (request.method === 'POST' && request.url === '/stop') {
          response.end(JSON.stringify({
            isFailed: false,
            data: {
              accepted: true,
              action: 'stop'
            }
          }))
          setTimeout(() => {
            server.close(() => {
              stopped = true
            })
          }, 80)
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
      const dir = await mkdtemp(join(tmpdir(), 'codexio-supervisor-stop-'))
      const configPath = join(dir, 'config.yaml')
      await writeSupervisorState(configPath, {
        pid: process.pid,
        host: '127.0.0.1',
        port: address.port,
        token,
        startedAt: new Date().toISOString()
      })

      const result = await stopServer(configPath)

      expect(result).toBe(true)
      expect(stopped).toBe(true)
      expect(await readSupervisorState(configPath)).toBeUndefined()
    } finally {
      if (http.listening) {
        await closeTestServer(http)
      }
    }
  })

  it('stops orphan runtime server when supervisor is unavailable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-orphan-runtime-'))
    const configPath = join(dir, 'config.yaml')
    await writeFile(configPath, [
      'server:',
      '  host: 127.0.0.1',
      '  port: 8787',
      `  token: ${testToken}`,
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
      `  path: ${dir}`
    ].join('\n'), 'utf8')
    let stopped = false
    const http = await new Promise<HttpServer>((resolve, reject) => {
      const server = new HttpServer((request, response) => {
        if (request.method === 'GET' && request.url === '/api/status') {
          response.end(JSON.stringify({
            isFailed: false,
            data: {
              pid: process.pid
            }
          }))
          return
        }
        if (request.method === 'POST' && request.url === '/api/server/stop') {
          if (request.headers.authorization !== `Bearer ${testToken}`) {
            response.statusCode = 401
            response.end(JSON.stringify({
              isFailed: true,
              message: 'unauthorized'
            }))
            return
          }
          response.end(JSON.stringify({
            isFailed: false,
            data: {
              stopping: true
            }
          }))
          setTimeout(() => {
            server.close(() => {
              stopped = true
            })
          }, 80)
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
        throw new Error('runtime address not found')
      }
      await writeRuntimeServerState(configPath, {
        pid: process.pid,
        host: '127.0.0.1',
        port: address.port,
        startedAt: new Date().toISOString()
      })

      const result = await stopServer(configPath)

      expect(result).toBe(true)
      expect(stopped).toBe(true)
      expect(await readSupervisorState(configPath)).toBeUndefined()
    } finally {
      if (http.listening) {
        await closeTestServer(http)
      }
    }
  })

  it('cleans stale supervisor state when supervisor process is gone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codexio-stale-supervisor-'))
    const configPath = join(dir, 'config.yaml')
    await writeSupervisorState(configPath, {
      pid: 999999,
      host: '127.0.0.1',
      port: 9,
      token: 'stale-token',
      startedAt: new Date().toISOString()
    })

    expect(await readRunningSupervisorState(configPath)).toBeUndefined()
    expect(await readSupervisorState(configPath)).toBeUndefined()
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

    const supervised = createServeProcessSpec(configPath, sourceEntryPath, {
      supervisorPid: 12345
    })
    expect(supervised.env?.CODEXIO_SUPERVISOR_PID).toBe('12345')
    expect(source.env).toBeUndefined()
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
  webBaseUrl: string
  listener: HttpServer
}> {
  const webPort = await resolveAvailableServerPort('127.0.0.1', 18788)
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
        enabled: true,
        host: '127.0.0.1',
        port: webPort
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
  const baseUrl = `http://127.0.0.1:${address.port}`
  const webBaseUrl = `http://127.0.0.1:${webPort}`
  webBaseUrls.set(baseUrl, webBaseUrl)
  await waitForHttpServer(webBaseUrl)
  return {
    baseUrl,
    webBaseUrl,
    listener
  }
}

async function openWebSocket(baseUrl: string): Promise<WebSocket> {
  const url = (webBaseUrls.get(baseUrl) ?? baseUrl).replace('http://', 'ws://').replace('https://', 'wss://')
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
  const url = (webBaseUrls.get(baseUrl) ?? baseUrl).replace('http://', 'ws://').replace('https://', 'wss://')
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

async function waitForHttpServer(baseUrl: string): Promise<void> {
  const startedAt = Date.now()
  for (;;) {
    try {
      const response = await fetch(baseUrl)
      await response.text()
      return
    } catch {
      if (Date.now() - startedAt > 4000) {
        throw new Error(`http server timeout: ${baseUrl}`)
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 5)
      })
    }
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

function pngBytes(): Buffer {
  return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lS3KgwAAAABJRU5ErkJggg==', 'base64')
}
