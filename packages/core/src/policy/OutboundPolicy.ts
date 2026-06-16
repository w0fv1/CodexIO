import { CodexioConfig } from '../config/ConfigSchema.js'
import { Result } from '../result/Result.js'

export class OutboundPolicy {
  private readonly sentAtByRuntime = new Map<string, number[]>()

  constructor(private readonly config: CodexioConfig) {}

  check(runtimeId: string, text: string): Result<null> {
    if (text.length > this.config.messaging.maxOutboundChars) {
      return Result.fail(`message too long: ${text.length}`)
    }
    if (this.config.security.blockSecrets && this.containsSecret(text)) {
      return Result.fail('message contains secret-like content')
    }
    const now = Date.now()
    const lowerBound = now - 60_000
    const sentAt = this.sentAtByRuntime.get(runtimeId) ?? []
    const recent = sentAt.filter((item) => item >= lowerBound)
    if (recent.length >= this.config.messaging.maxOutboundPerMinute) {
      return Result.fail('outbound rate limit exceeded')
    }
    recent.push(now)
    this.sentAtByRuntime.set(runtimeId, recent)
    return Result.successMessage('no error')
  }

  private containsSecret(text: string): boolean {
    const patterns = [
      /sk-[A-Za-z0-9_-]{20,}/,
      /ghp_[A-Za-z0-9_]{20,}/,
      /AKIA[0-9A-Z]{16}/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /DATABASE_URL\s*=/,
      /JWT\s*=/i
    ]
    return patterns.some((pattern) => pattern.test(text))
  }
}
