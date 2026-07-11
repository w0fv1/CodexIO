import { Logger } from '../../Logger.js'

type CodexSessionSupervisorHooks = {
  generation: () => number
  canRecover: () => boolean
  recover: () => void
}

export class CodexSessionSupervisor {
  private desiredRunning = false
  private recoveryAttempt = 0
  private recoveryTimer?: NodeJS.Timeout
  private recoveryResetTimer?: NodeJS.Timeout

  constructor(private readonly hooks: CodexSessionSupervisorHooks) {}

  requestStart(): void {
    this.desiredRunning = true
    this.clearRecoveryTimer()
  }

  requestStop(): void {
    this.desiredRunning = false
    this.recoveryAttempt = 0
    this.clearRecoveryTimer()
    this.clearRecoveryResetTimer()
  }

  sessionReady(generation: number): void {
    this.clearRecoveryResetTimer()
    const timer = setTimeout(() => {
      if (this.recoveryResetTimer === timer) {
        this.recoveryResetTimer = undefined
      }
      if (this.desiredRunning && this.hooks.generation() === generation) {
        this.recoveryAttempt = 0
      }
    }, 30000)
    timer.unref()
    this.recoveryResetTimer = timer
  }

  sessionEnded(): void {
    this.clearRecoveryResetTimer()
  }

  scheduleRecovery(reason: string): void {
    if (!this.desiredRunning || !this.hooks.canRecover() || this.recoveryTimer) {
      return
    }
    const generation = this.hooks.generation()
    const delayMs = Math.min(5000, 250 * (2 ** Math.min(this.recoveryAttempt, 5)))
    this.recoveryAttempt += 1
    Logger.warn('codex client recovery scheduled', {
      reason,
      delayMs,
      generation,
      attempt: this.recoveryAttempt
    })
    const timer = setTimeout(() => {
      if (this.recoveryTimer === timer) {
        this.recoveryTimer = undefined
      }
      if (!this.desiredRunning || generation !== this.hooks.generation()) {
        return
      }
      this.hooks.recover()
    }, delayMs)
    this.recoveryTimer = timer
  }

  private clearRecoveryTimer(): void {
    if (!this.recoveryTimer) {
      return
    }
    clearTimeout(this.recoveryTimer)
    this.recoveryTimer = undefined
  }

  private clearRecoveryResetTimer(): void {
    if (!this.recoveryResetTimer) {
      return
    }
    clearTimeout(this.recoveryResetTimer)
    this.recoveryResetTimer = undefined
  }
}
