export type CodexThread = {
  id: string
  title: string
  isWorking: boolean
  deleted?: boolean
}

export type CodexThreadChangedEvent = {
  threads: CodexThread[]
}

export type CodexThreadBoundEvent = {
  ioThreadId: string
  threadId: string
}
