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

export type CodexThreadSnapshotMessage = CodexClientCompletedMessage & {
  turnId: string
  completedAt: number
  sequence: number
}

export type CodexThreadSnapshot = {
  thread: {
    id: string
    name: string
  }
  messages: CodexThreadSnapshotMessage[]
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
  status: 'turnCompleted'
  text: string
  messages: CodexClientCompletedMessage[]
} | {
  status: 'failed'
  text: string
  messages: []
})

export type CodexClientLoginEvent = {
  verificationUrl: string
  userCode: string
  loginCompleted: boolean
}

export type CodexClientEventMap = {
  thread: (thread: CodexClientThread) => void
  message: (message: CodexClientMessage) => void
  snapshot: (snapshot: CodexThreadSnapshot) => Promise<void>
  login: (login: CodexClientLoginEvent) => void
  error: (error: Error) => void
}

export type CodexRpcClient = {
  request: (method: string, params?: unknown) => Promise<unknown>
}
