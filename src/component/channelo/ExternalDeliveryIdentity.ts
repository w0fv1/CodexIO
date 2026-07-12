import { deriveMessageId, Message } from '../../value/Message.js'

export function deriveExternalDeliveryId(channel: string, message: Message, ...parts: string[]): string {
  return deriveMessageId('channel-output', channel, message.id, ...parts)
}
