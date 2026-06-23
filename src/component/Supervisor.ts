import { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { IncomingMessage, Server as HttpServer, ServerResponse, createServer } from 'node:http'
import { pid } from 'node:process'
import { inject, injectable } from 'inversify'
import { Result } from '../value/Result.js'
import { Logger } from './Logger.js'
import { CodexioMetadata } from './CodexioMetadata.js'
import { Configer } from './Configer.js'
import {
  readRunningSupervisorState,
  readRuntimeServerState,
  removeRuntimeServerState,
  removeSupervisorState,
  spawnServeProcess,
  SupervisorClient,
  waitForRuntimeServerStarted,
  waitForRuntimeServerStopped,
  writeSupervisorState
} from './ServerLifecycle.js'

export type SupervisorOptions = {
  configPath?: string
  initConfig?: boolean
  autoPort?: boolean
  replaceRunning?: boolean
}

type SupervisorAction = 'restart' | 'stop'

@injectable()
export class SupervisorService {
  constructor(@inject(CodexioMetadata) private readonly metadata: CodexioMetadata) {}

  async run(options: SupervisorOptions = {}): Promise<void> {
    const configer = new Configer(options.configPath ? new CodexioMetadata({
      rootPath: this.metadata.rootPath,
      configPath: options.configPath
    }) : this.metadata)
    if (options.initConfig) {
      await configer.init(false)
    } else {
      await configer.validate()
    }
    if (options.autoPort) {
      await configer.set('server.autoPort', true)
    }
    const running = await readRunningSupervisorState(configer.path)
    if (running) {
      if (!options.replaceRunning) {
        throw new Error(`codexio supervisor is already running on ${running.host}:${running.port}`)
      }
      Logger.info('codexio supervisor replacing running instance', {
        host: running.host,
        port: running.port,
        pid: running.pid
      })
      await new SupervisorClient(configer).stop()
    }
    const supervisor = new Supervisor(configer.path, this.metadata.rootPath, await configer.get('server.token'))
    await supervisor.run()
  }
}

class Supervisor {
  private readonly host = '127.0.0.1'
  private readonly token = randomBytes(32).toString('hex')
  private server?: HttpServer
  private child?: ChildProcess
  private childExit?: Promise<void>
  private stopping = false
  private actionQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly configPath: string,
    private readonly rootPath: string,
    private readonly serverToken: string
  ) {}

  async run(): Promise<void> {
    await this.startControlServer()
    await this.startChild()
    process.once('SIGINT', () => {
      void this.shutdown()
    })
    process.once('SIGTERM', () => {
      void this.shutdown()
    })
    await new Promise<void>((resolve) => {
      this.server?.once('close', resolve)
    })
  }

  private async startControlServer(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handleRequest(request, response)
    })
    await new Promise<void>((resolveListening, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(0, this.host, resolveListening)
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') {
      throw new Error('supervisor address not found')
    }
    await writeSupervisorState(this.configPath, {
      pid,
      host: this.host,
      port: address.port,
      token: this.token,
      startedAt: new Date().toISOString()
    })
    Logger.info('codexio supervisor listening', {
      host: this.host,
      port: address.port,
      pid
    })
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const authorization = request.headers.authorization
    if (authorization !== `Bearer ${this.token}`) {
      response.statusCode = 401
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(Result.fail('unauthorized', '401')))
      return
    }
    if (request.method === 'GET' && request.url === '/status') {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(Result.success({
        pid,
        childPid: this.child?.pid ?? null,
        stopping: this.stopping
      })))
      return
    }
    if (request.method === 'POST' && request.url === '/restart') {
      this.accept(response, 'restart')
      this.enqueue('restart')
      return
    }
    if (request.method === 'POST' && request.url === '/stop') {
      this.accept(response, 'stop')
      this.enqueue('stop')
      return
    }
    response.statusCode = 404
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(Result.fail('not found', '404')))
  }

  private accept(response: ServerResponse, action: SupervisorAction): void {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(Result.success({
      accepted: true,
      action
    })))
  }

  private enqueue(action: SupervisorAction): void {
    this.actionQueue = this.actionQueue
      .then(async () => {
        if (action === 'restart') {
          await this.restartChild()
          return
        }
        await this.shutdown()
      })
      .catch((error) => {
        Logger.error(`supervisor ${action} failed`, error)
      })
  }

  private async startChild(): Promise<void> {
    if (this.child) {
      return
    }
    const child = spawnServeProcess(this.configPath, this.rootPath, {
      supervisorPid: pid
    })
    this.child = child
    this.childExit = new Promise<void>((resolve) => {
      child.once('exit', (code, signal) => {
        Logger.warn('codexio server child exited', {
          pid: child.pid,
          code,
          signal
        })
        if (this.child === child) {
          this.child = undefined
          this.childExit = undefined
        }
        void removeRuntimeServerState(this.configPath)
        resolve()
      })
    })
    await waitForRuntimeServerStarted(this.configPath)
  }

  private async restartChild(): Promise<void> {
    Logger.info('codexio supervisor restarting child')
    await this.stopChild()
    await this.startChild()
  }

  private async stopChild(): Promise<void> {
    const child = this.child
    if (!child) {
      await removeRuntimeServerState(this.configPath)
      return
    }
    await this.requestServerStop()
    child.kill('SIGTERM')
    const childExit = this.childExit ?? Promise.resolve()
    await Promise.race([
      childExit,
      new Promise<void>((resolve) => {
        setTimeout(resolve, 5000)
      })
    ])
    if (this.child === child) {
      child.kill('SIGKILL')
      await childExit
    }
    await waitForRuntimeServerStopped(this.configPath)
    await removeRuntimeServerState(this.configPath)
  }

  private async requestServerStop(): Promise<void> {
    const state = await readRuntimeServerState(this.configPath)
    if (!state) {
      return
    }
    try {
      await fetch(`http://${state.host}:${state.port}/api/server/stop`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.serverToken}`
        }
      })
      await waitForRuntimeServerStopped(this.configPath)
    } catch (error) {
      Logger.warn('supervisor graceful server stop failed', error)
    }
  }

  private async shutdown(): Promise<void> {
    if (this.stopping) {
      return
    }
    this.stopping = true
    Logger.info('codexio supervisor stopping')
    await this.stopChild()
    await removeSupervisorState(this.configPath)
    this.server?.close()
  }
}
