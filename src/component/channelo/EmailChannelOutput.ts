import nodemailer, { Transporter } from 'nodemailer'
import { inject, injectable } from 'inversify'
import { CodexioConfig } from '../../value/ConfigDefinition.js'
import { Message } from '../../value/Message.js'
import { Result } from '../../value/Result.js'
import { Logger } from '../Logger.js'
import { Configer } from '../Configer.js'
import { ChannelOutput, ChannelOutputContext } from './ChannelOutput.js'
import { deriveExternalDeliveryId } from './ExternalDeliveryIdentity.js'

type EmailChannelOutputConfig = CodexioConfig['channelo']['email']

@injectable()
export class EmailChannelOutput implements ChannelOutput {
  readonly type = 'email'
  private config?: EmailChannelOutputConfig
  private smtp?: Transporter

  constructor(@inject(Configer) private readonly configer: Configer) {}

  async start(): Promise<boolean> {
    this.config = await this.configer.get('channelo.email')
    if (!this.config?.enabled) {
      return false
    }
    if (!this.config?.user) {
      throw new Error('email user is required')
    }
    if (!this.config.account.smtp?.host || !this.config.account.smtp.user || !this.config.account.smtp.password) {
      throw new Error('email smtp config is required')
    }
    Logger.info('email smtp output starting', {
      user: this.config.user,
      smtpHost: this.config.account.smtp.host
    })
    this.smtp = nodemailer.createTransport({
      host: this.config.account.smtp.host,
      port: this.config.account.smtp.port,
      secure: this.config.account.smtp.secure,
      auth: {
        user: this.config.account.smtp.user,
        pass: this.config.account.smtp.password
      }
    })
    return true
  }

  async send(message: Message, context?: ChannelOutputContext): Promise<Result<void>> {
    if (message.role === 'user' && context?.source === 'email') {
      return Result.successVoid()
    }
    if (!this.smtp) {
      return Result.fail('email smtp not ready')
    }
    if (message.text.trim().length === 0 && (!message.files || message.files.length === 0)) {
      return Result.fail('text or file is required')
    }
    const recipient = this.config?.user?.trim() ?? ''
    if (recipient.length === 0) {
      return Result.fail('email user is required')
    }
    let text = message.text
    const fileText = (message.files ?? [])
      .map((file) => file.url ?? file.path)
      .filter((value) => value.trim().length > 0)
      .join('\n')
    if (text.trim().length > 0 && fileText.length > 0) {
      text = `${text}\n\n${fileText}`
    } else if (fileText.length > 0) {
      text = fileText
    }
    const subject = message.role === 'user' ? 'User' : 'System'
    const trimmedFrom = this.config?.account?.smtp?.from?.trim()
    const trimmedUser = this.config?.account?.smtp?.user?.trim()
    const from = trimmedFrom && trimmedFrom.includes('@')
      ? trimmedFrom
      : trimmedFrom && trimmedUser && trimmedUser.includes('@')
        ? {
            name: trimmedFrom,
            address: trimmedUser
          }
        : trimmedUser || trimmedFrom
    try {
      Logger.info('email smtp send started', {
        role: message.role,
        subject,
        length: text.length
      })
      await this.smtp.sendMail({
        messageId: `<${deriveExternalDeliveryId('email', message)}@codexio.local>`,
        from,
        to: recipient,
        subject,
        text,
        attachments: message.files?.map((file) => ({
          filename: file.name,
          path: file.path,
          contentType: file.mime
        }))
      })
      Logger.info('email smtp send completed', {
        role: message.role,
        subject
      })
      return Result.successVoid()
    } catch (error) {
      Logger.error('email smtp send failed', error)
      return Result.fromError(error)
    }
  }

  async stop(): Promise<Result<void>> {
    this.smtp = undefined
    return Result.successVoid()
  }
}
