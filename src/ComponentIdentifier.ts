import type { ServiceIdentifier } from 'inversify'
import type { AgentManagerCallbacks } from './agent/AgentManager.js'
import type { Writable } from 'node:stream'
import type { ServeCommand } from './controller/CodexioCliController.js'
import type { Message } from './value/Message.js'
import type { Result } from './value/Result.js'
import type { ChannelReceiveResult } from './channel/Channel.js'

export type ChannelReceive = (message: Message) => Promise<Result<ChannelReceiveResult>>

export const OutputId: ServiceIdentifier<Writable> = Symbol.for('codexio.Output')
export const ServeCommandId: ServiceIdentifier<ServeCommand> = Symbol.for('codexio.ServeCommand')
export const AgentManagerCallbacksId: ServiceIdentifier<AgentManagerCallbacks> = Symbol.for('codexio.AgentManagerCallbacks')
export const ChannelReceiveId: ServiceIdentifier<ChannelReceive> = Symbol.for('codexio.ChannelReceive')
