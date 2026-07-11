import { Logger } from '../../Logger.js'
import { CodexRpcClient, CodexThreadSnapshot } from './CodexProtocol.js'
import { CodexThreadObserver, CodexThreadObserverOptions } from './CodexThreadObserver.js'

type CodexObserverLifecycleHooks = CodexRpcClient & {
  emit: (snapshot: CodexThreadSnapshot) => Promise<void>
  fail: (error: Error) => void
  generation: () => number
}

export class CodexObserverLifecycle {
  private observer?: CodexThreadObserver

  constructor(private readonly hooks: CodexObserverLifecycleHooks) {}

  start(options?: CodexThreadObserverOptions): void {
    if (!options) {
      this.stop()
      return
    }
    if (!this.observer) {
      this.observer = new CodexThreadObserver({
        request: this.hooks.request
      }, options, this.hooks.emit, (error) => {
        Logger.warn('codex thread observer failed', {
          message: error.message
        })
      }, (diagnostic) => {
        const message = `codex thread observer ${diagnostic.event}`
        if ([
          'baselineEstablished',
          'snapshotEmitted',
          'stopped'
        ].includes(diagnostic.event) || (
          diagnostic.event === 'threadRead'
          && Number(diagnostic.data.snapshotMessageCount) > 0
        )) {
          Logger.info(message, diagnostic.data)
          return
        }
        Logger.debug(message, diagnostic.data)
      })
    }
    void this.observer.start().catch((error) => {
      const reason = error instanceof Error ? error : new Error(String(error))
      Logger.warn('codex thread observer start failed', {
        message: reason.message,
        generation: this.hooks.generation()
      })
      this.hooks.fail(reason)
    })
  }

  ignoreThread(threadId: string): void {
    this.observer?.ignoreThread(threadId)
  }

  stop(): void {
    this.observer?.stop()
    this.observer = undefined
  }
}
