import { injectable } from 'inversify'
import { Thread } from '../value/Thread.js'

export type ThreadListener = (thread: Thread) => void | Promise<void>
export type ThreadDeleteListener = (id: string) => void | Promise<void>
export type ThreadSubscription = {
  dispose: () => void
}

@injectable()
export class ThreadManager {
  private readonly threads = new Map<string, Thread>()
  private readonly ioThreadIdByAgentThreadId = new Map<string, string>()
  private readonly listeners = new Set<ThreadListener>()
  private readonly deleteListeners = new Set<ThreadDeleteListener>()

  list(): Thread[] {
    return [...this.threads.values()].map((thread) => ({
      ...thread
    }))
  }

  get(id: string): Thread | undefined {
    const thread = this.threads.get(id)
    return thread ? {
      ...thread
    } : undefined
  }

  getByAgentThreadId(agentThreadId: string): Thread | undefined {
    const id = this.ioThreadIdByAgentThreadId.get(agentThreadId)
    return id ? this.get(id) : undefined
  }

  ensure(id: string): Thread {
    const existing = this.threads.get(id)
    if (existing) {
      return {
        ...existing
      }
    }
    const thread = {
      id,
      title: '',
      isWorking: false
    }
    this.threads.set(id, thread)
    this.notify(thread)
    return {
      ...thread
    }
  }

  bind(id: string, agentThreadId: string): Thread {
    const thread = this.threads.get(id) ?? {
      id,
      title: '',
      isWorking: false
    }
    if (thread.agentThreadId === agentThreadId) {
      this.threads.set(id, thread)
      return {
        ...thread
      }
    }
    if (thread.agentThreadId) {
      this.ioThreadIdByAgentThreadId.delete(thread.agentThreadId)
    }
    thread.agentThreadId = agentThreadId
    this.threads.set(id, thread)
    this.ioThreadIdByAgentThreadId.set(agentThreadId, id)
    this.notify(thread)
    return {
      ...thread
    }
  }

  setTitle(id: string, title: string): Thread {
    const thread = this.threads.get(id) ?? {
      id,
      title: '',
      isWorking: false
    }
    if (thread.title === title) {
      this.threads.set(id, thread)
      return {
        ...thread
      }
    }
    thread.title = title
    this.threads.set(id, thread)
    this.notify(thread)
    return {
      ...thread
    }
  }

  setWorking(id: string, isWorking: boolean): Thread {
    const thread = this.threads.get(id) ?? {
      id,
      title: '',
      isWorking: false
    }
    if (thread.isWorking === isWorking) {
      this.threads.set(id, thread)
      return {
        ...thread
      }
    }
    thread.isWorking = isWorking
    this.threads.set(id, thread)
    this.notify(thread)
    return {
      ...thread
    }
  }

  remove(id: string): void {
    const thread = this.threads.get(id)
    if (!thread) {
      return
    }
    if (thread.agentThreadId) {
      this.ioThreadIdByAgentThreadId.delete(thread.agentThreadId)
    }
    this.threads.delete(id)
    this.notifyDeleted(id)
  }

  clear(): void {
    for (const id of [...this.threads.keys()]) {
      this.remove(id)
    }
  }

  subscribe(listener: ThreadListener): ThreadSubscription {
    this.listeners.add(listener)
    return {
      dispose: () => {
        this.listeners.delete(listener)
      }
    }
  }

  subscribeDelete(listener: ThreadDeleteListener): ThreadSubscription {
    this.deleteListeners.add(listener)
    return {
      dispose: () => {
        this.deleteListeners.delete(listener)
      }
    }
  }

  private notify(thread: Thread): void {
    const copy = {
      ...thread
    }
    for (const listener of this.listeners) {
      void listener(copy)
    }
  }

  private notifyDeleted(id: string): void {
    for (const listener of this.deleteListeners) {
      void listener(id)
    }
  }
}
