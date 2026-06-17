import { describe, expect, it } from 'vitest'
import { ConfigSchema } from './config/ConfigSchema.js'
import { createCodexioApp } from './app.js'

describe('server', () => {
  it('receives web message and exposes outbound message', async () => {
    const { baseUrl, listener } = await startTestServer()
    const inboundResponse = await fetch(`${baseUrl}/api/web/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        conversationId: 'browser',
        text: 'hello'
      })
    })
    const inbound = await inboundResponse.json() as {
      data: {
        runtimeId: string
      }
      isFailed: boolean
    }
    expect(inbound.isFailed).toBe(false)
    expect(inbound.data.runtimeId).toMatch(/^rt_/)
    const messagesResponse = await fetch(`${baseUrl}/api/web/messages/browser`)
    const messages = await messagesResponse.json() as {
      data: Array<{
        text: string
      }>
    }
    expect(messages.data.map((item) => item.text)).toEqual([
      'echo: hello'
    ])
    await closeTestServer(listener)
  })

  it('handles web commands without sending them to runtime', async () => {
    const { baseUrl, listener } = await startTestServer()
    const commandResponse = await postWebMessage(baseUrl, 'command-browser', '/$ ?') as {
      isFailed: boolean
    }
    expect(commandResponse.isFailed).toBe(false)
    const messages = await readWebMessages(baseUrl, 'command-browser')
    expect(messages.map((item) => item.text)[0]).toContain('/$ clear')
    expect(messages.some((item) => item.text.includes('echo:'))).toBe(false)
    await closeTestServer(listener)
  })

  it('sends escaped command text to runtime', async () => {
    const { baseUrl, listener } = await startTestServer()
    await postWebMessage(baseUrl, 'escape-browser', '/$$ clear')
    const messages = await readWebMessages(baseUrl, 'escape-browser')
    expect(messages.map((item) => item.text)).toEqual([
      'echo: /$ clear'
    ])
    await closeTestServer(listener)
  })

  it('clears current runtime and creates a new one on next message', async () => {
    const { baseUrl, listener } = await startTestServer()
    const first = await postWebMessage(baseUrl, 'clear-browser', 'first') as {
      data: {
        runtimeId: string
      }
      isFailed: boolean
    }
    const clear = await postWebMessage(baseUrl, 'clear-browser', '/$ clear') as {
      data: {
        action: string
      }
      isFailed: boolean
    }
    const second = await postWebMessage(baseUrl, 'clear-browser', 'second') as {
      data: {
        runtimeId: string
      }
      isFailed: boolean
    }
    expect(first.data.runtimeId).not.toEqual(second.data.runtimeId)
    expect(clear.data.action).toBe('clear')
    await closeTestServer(listener)
  })
})

async function startTestServer(): Promise<{
  baseUrl: string
  listener: ReturnType<ReturnType<typeof createCodexioApp>['app']['listen']>
}> {
  const config = ConfigSchema.parse({
    defaultAgent: 'echo',
    agents: {
      echo: {
        enabled: true,
        command: 'echo'
      }
    },
    channels: {
      web: {
        enabled: true
      }
    },
    workspaces: {
      default: {
        path: '.',
        defaultAgent: 'echo',
        allowedChannels: [
          'web'
        ]
      }
    }
  })
  const server = createCodexioApp(config)
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

async function postWebMessage(baseUrl: string, conversationId: string, text: string): Promise<unknown> {
  const response = await fetch(`${baseUrl}/api/web/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      conversationId,
      text
    })
  })
  return response.json()
}

async function readWebMessages(baseUrl: string, conversationId: string): Promise<Array<{ text: string }>> {
  const response = await fetch(`${baseUrl}/api/web/messages/${conversationId}`)
  const result = await response.json() as {
    data: Array<{
      text: string
    }>
  }
  return result.data
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
