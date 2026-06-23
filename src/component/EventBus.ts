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
}
