import { createInterface } from 'node:readline'
import { execa } from 'execa'
import { readCodexioVersion } from '../AppMetadata.js'

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
  requestTimeoutMs?: number
}

export class CodexAppServer {
  private readonly requestTimeoutMs: number
  private child?: ReturnType<typeof execa>
  private nextId = 1
  private notificationWaiters = new Map<string, Array<() => void>>()
  private pending = new Map<number, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timeout: NodeJS.Timeout
  }>()

  constructor(private readonly options: CodexAppServerOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120000
  }

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
      let message: RpcMessage
      try {
        message = JSON.parse(line) as RpcMessage
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        this.options.onStderr(Buffer.from(`codex app-server sent invalid JSON: ${reason}\n`))
        return
      }
      if (typeof message.id === 'number') {
        const request = this.pending.get(message.id)
        if (!request) {
          return
        }
        this.pending.delete(message.id)
        clearTimeout(request.timeout)
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
        clearTimeout(request.timeout)
        request.reject(new Error(`codex app-server exited with code ${result.exitCode}`))
      }
      this.pending.clear()
    }).catch((error) => {
      if (this.child === child) {
        this.child = undefined
      }
      const message = error instanceof Error ? error : new Error(String(error))
      for (const request of this.pending.values()) {
        clearTimeout(request.timeout)
        request.reject(message)
      }
      this.pending.clear()
    })
    await this.request('initialize', {
      clientInfo: {
        name: 'codexio',
        title: 'Codexio',
        version: readCodexioVersion()
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
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`codex app-server request timed out: ${method}`))
      }, this.requestTimeoutMs)
      this.pending.set(id, {
        resolve,
        reject,
        timeout
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
