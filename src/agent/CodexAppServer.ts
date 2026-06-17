import { createInterface } from 'node:readline'
import { execa } from 'execa'

type RpcError = {
  code: number
  message: string
}

type RpcMessage = {
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: RpcError
}

export type CodexAppServerOptions = {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  onNotification: (method: string, params: unknown) => void
  onStderr: (data: Buffer) => void
}

export class CodexAppServer {
  private child?: ReturnType<typeof execa>
  private nextId = 1
  private notificationWaiters = new Map<string, Array<() => void>>()
  private pending = new Map<number, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
  }>()

  constructor(private readonly options: CodexAppServerOptions) {}

  async start(): Promise<void> {
    if (this.child) {
      return
    }
    const child = execa(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      reject: false
    })
    this.child = child
    if (!child.stdout || !child.stdin) {
      throw new Error('codex app-server stdio not available')
    }
    createInterface({
      input: child.stdout
    }).on('line', (line) => {
      const message = JSON.parse(line) as RpcMessage
      if (typeof message.id === 'number') {
        const request = this.pending.get(message.id)
        if (!request) {
          return
        }
        this.pending.delete(message.id)
        if (message.error) {
          request.reject(new Error(message.error.message))
          return
        }
        request.resolve(message.result)
        return
      }
      if (message.method) {
        const waiters = this.notificationWaiters.get(message.method)
        if (waiters) {
          this.notificationWaiters.delete(message.method)
          for (const waiter of waiters) {
            waiter()
          }
        }
        this.options.onNotification(message.method, message.params)
      }
    })
    child.stderr?.on('data', this.options.onStderr)
    child.then((result) => {
      if (this.child === child) {
        this.child = undefined
      }
      for (const request of this.pending.values()) {
        request.reject(new Error(`codex app-server exited with code ${result.exitCode}`))
      }
      this.pending.clear()
    }).catch((error) => {
      if (this.child === child) {
        this.child = undefined
      }
      const message = error instanceof Error ? error : new Error(String(error))
      for (const request of this.pending.values()) {
        request.reject(message)
      }
      this.pending.clear()
    })
    await this.request('initialize', {
      clientInfo: {
        name: 'codexio',
        title: 'Codexio',
        version: '0.1.0'
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false
      }
    })
    this.notify('initialized', {})
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (!this.child?.stdin) {
      throw new Error('codex app-server not started')
    }
    const id = this.nextId
    this.nextId += 1
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject
      })
    })
    this.child.stdin.write(`${JSON.stringify({
      method,
      id,
      params
    })}\n`)
    return result
  }

  notify(method: string, params: unknown): void {
    if (!this.child?.stdin) {
      throw new Error('codex app-server not started')
    }
    this.child.stdin.write(`${JSON.stringify({
      method,
      params
    })}\n`)
  }

  async waitForNotification(method: string): Promise<void> {
    await new Promise<void>((resolve) => {
      const waiters = this.notificationWaiters.get(method) ?? []
      waiters.push(resolve)
      this.notificationWaiters.set(method, waiters)
    })
  }

  async stop(): Promise<void> {
    if (!this.child) {
      return
    }
    const child = this.child
    this.child = undefined
    child.kill()
    await child.catch(() => {})
  }
}
