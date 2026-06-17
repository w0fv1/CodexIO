import { describe, expect, it } from 'vitest'
import { ConfigSchema } from './ConfigService.js'
import { createCodexioApp } from './index.js'
import { webPageHtml } from './channel/WebPage.js'

describe('server', () => {
  it('serves a Codexio introduction page with the web chat', () => {
    expect(webPageHtml).toContain('无数据库、配置驱动的 coding agent 文本中转器')
    expect(webPageHtml).toContain('HTTP API')
    expect(webPageHtml).toContain('id="messages"')
    expect(webPageHtml).toContain('id="form"')
  })

  it('receives web text', async () => {
    const { baseUrl, listener } = await startTestServer()
    const result = await postWebText(baseUrl, 'hello') as {
      isFailed: boolean
    }
    expect(result.isFailed).toBe(false)
    await closeTestServer(listener)
  })

  it('clears the active agent conversation', async () => {
    const { baseUrl, listener } = await startTestServer()
    await postWebText(baseUrl, 'first')
    const clear = await postWebText(baseUrl, '/$ clear') as {
      data: {
        action: string
      }
    }
    const second = await postWebText(baseUrl, 'second') as {
      isFailed: boolean
    }
    expect(clear.data.action).toBe('clear')
    expect(second.isFailed).toBe(false)
    await closeTestServer(listener)
  })

  it('does not expose web history as external API', async () => {
    const { baseUrl, listener } = await startTestServer()
    const response = await fetch(`${baseUrl}/api/web/messages`)
    expect(response.status).toBe(404)
    await closeTestServer(listener)
  })

  it('accepts agent output through the configured default channel', async () => {
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
    }
    expect(result.isFailed).toBe(false)
    await closeTestServer(listener)
  })

  it('starts only configured channels', async () => {
    const config = ConfigSchema.parse({
      agents: {
        codex: {
          enabled: false
        },
        claude: {
          enabled: false
        },
        echo: {
          enabled: true
        }
      },
      channels: {
        cli: {
          enabled: true
        }
      },
      workspace: {
        path: '.'
      }
    })
    const server = createCodexioApp(config)
    const ready = await server.ready
    expect(ready.isFailed).toBe(false)
    const listener = server.app.listen(0)
    await new Promise<void>((resolve) => {
      listener.once('listening', resolve)
    })
    const address = listener.address()
    if (!address || typeof address === 'string') {
      throw new Error('server address not found')
    }
    const response = await fetch(`http://127.0.0.1:${address.port}/api/web/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: 'hello'
      })
    })
    expect(response.status).toBe(404)
    await closeTestServer(listener)
  })

  it('rejects ambiguous enabled agents', async () => {
    const config = ConfigSchema.parse({
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
    const server = createCodexioApp(config)
    const ready = await server.ready
    expect(ready.isFailed).toBe(true)
    expect(ready.message).toBe('only one agent can be enabled')
  })
})

async function startTestServer(): Promise<{
  baseUrl: string
  listener: ReturnType<ReturnType<typeof createCodexioApp>['app']['listen']>
}> {
  const config = ConfigSchema.parse({
    agents: {
      codex: {
        enabled: false
      },
      claude: {
        enabled: false
      },
      echo: {
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
  const server = createCodexioApp(config)
  const ready = await server.ready
  if (ready.isFailed) {
    throw new Error(ready.message)
  }
  const listener = server.app.listen(0)
  await new Promise<void>((resolve) => {
    listener.once('listening', resolve)
  })
  const address = listener.address()
  if (!address || typeof address === 'string') {
    throw new Error('server address not found')
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    listener
  }
}

async function postWebText(baseUrl: string, text: string): Promise<unknown> {
  const response = await fetch(`${baseUrl}/api/web/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      text
    })
  })
  return response.json()
}

async function closeTestServer(listener: ReturnType<ReturnType<typeof createCodexioApp>['app']['listen']>): Promise<void> {
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
