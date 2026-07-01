import { CodexioConfig } from '../../value/ConfigDefinition.js'
import { ChannelInputReceiveResult } from '../../value/Event.js'
import { MessageFile } from '../../value/Message.js'
import { Result } from '../../value/Result.js'
import { PlatformThreadId } from '../../component/IoThreadIdManager.js'

export type ChannelType = keyof CodexioConfig['channeli']

export type ChannelInputMessage = {
  platformThreadIds: [PlatformThreadId, ...PlatformThreadId[]]
  text: string
  files?: MessageFile[]
  mentioned?: boolean
  sender?: {
    openId?: string
    userId?: string
    unionId?: string
  }
}

export interface ChannelInputReceiver {
  receive(inputType: ChannelType, message: ChannelInputMessage): Promise<Result<ChannelInputReceiveResult>>
}

export interface ChannelInput {
  type: ChannelType
  start(receiver: ChannelInputReceiver): Promise<boolean>
  stop(): Promise<Result<void>>
}
