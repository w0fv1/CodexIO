import { EventEmitter } from 'eventemitter3'
import { injectable } from 'inversify'
import { AppEvent, AppEventMap } from '../value/Event.js'

@injectable()
export class EventBus {
  private readonly emitter = new EventEmitter()

  on<E extends AppEvent>(event: E, listener: AppEventMap[E]): void {
    this.emitter.on(event, listener)
  }

  once<E extends AppEvent>(event: E, listener: AppEventMap[E]): void {
    this.emitter.once(event, listener)
  }

  off<E extends AppEvent>(event: E, listener: AppEventMap[E]): void {
    this.emitter.off(event, listener)
  }

  emit<E extends AppEvent>(event: E, ...args: Parameters<AppEventMap[E]>): boolean {
    return this.emitter.emit(event, ...args)
  }

  async emitAsync<E extends AppEvent>(event: E, ...args: Parameters<AppEventMap[E]>): Promise<Array<Awaited<ReturnType<AppEventMap[E]>>>> {
    const listeners = this.emitter.listeners(event) as AppEventMap[E][]
    const results: Array<Awaited<ReturnType<AppEventMap[E]>>> = []
    for (const listener of listeners) {
      const callable = listener as (...listenerArgs: unknown[]) => ReturnType<AppEventMap[E]>
      const result = await callable(...args as unknown[])
      results.push(result as Awaited<ReturnType<AppEventMap[E]>>)
    }
    return results
  }
}
