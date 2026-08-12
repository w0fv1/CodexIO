export type CodexClientThread = {
  id: string
  title: string
  isWorking: boolean
  deleted?: boolean
}

export type CodexClientInput = {
  thread: import('../../../value/Message.js').MessageThread
  threadId?: string
  text: string
  files?: import('../../../value/Message.js').MessageFile[]
  threadResolved?: (threadId: string) => void | Promise<void>
}

export type CodexClientTurn = {
  threadId: string
  turnId: string
}

export type CodexClientCompletedMessage = {
  itemId: string
  role: 'assistant'
  text: string
  sequence: number
}

type CodexClientMessageBase = {
  thread: {
    id: string
    name: string
  }
  turnId: string
  role: 'assistant'
  occurredAt?: number
}

export type CodexClientMessage = CodexClientMessageBase & ({
  status: 'started'
  text: string
  messages: []
} | {
  status: 'delta'
  itemId: string
  text: string
  messages: []
} | {
  status: 'itemCompleted'
  itemId: string
  text: string
  messages: CodexClientCompletedMessage[]
} | {
  status: 'progressCompleted'
  itemId: string
  text: string
  messages: []
} | {
  status: 'turnCompleted'
  text: string
  messages: CodexClientCompletedMessage[]
} | {
  status: 'failed'
  text: string
  messages: []
})

export type CodexClientLoginRequired = {
  status: 'loginRequired'
  loginId: string
  verificationUrl: string
  userCode: string
}

export type CodexClientLoginState = {
  status: 'authenticated'
} | CodexClientLoginRequired

export type CodexClientLoginCompletion = {
  loginId: string
  success: boolean
  error?: string
}

export type CodexClientEventMap = {
  thread: (thread: CodexClientThread) => void
  message: (message: CodexClientMessage) => void
  login: (login: CodexClientLoginCompletion) => void
}

export function readString(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const item = (value as Record<string, unknown>)[key]
  return typeof item === 'string' ? item : null
}

export function readEpochSecondsAsMilliseconds(value: unknown, key: string): number | undefined {
  const item = readNumber(value, key)
  return item === undefined ? undefined : item * 1000
}

export function readNumber(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const item = (value as Record<string, unknown>)[key]
  return typeof item === 'number' ? item : undefined
}
