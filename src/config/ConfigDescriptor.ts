export type ConfigEffect = 'hot' | 'channelReconnect' | 'agentRestart' | 'appRestart'

export type ConfigFieldDescriptor = {
  path: string
  group: string
  label: string
  type: 'boolean' | 'number' | 'string' | 'password'
  effect: ConfigEffect
}

export const configFieldDescriptors: ConfigFieldDescriptor[] = [
  {
    path: 'server.host',
    group: 'Server',
    label: 'Host',
    type: 'string',
    effect: 'appRestart'
  },
  {
    path: 'server.port',
    group: 'Server',
    label: 'Port',
    type: 'number',
    effect: 'appRestart'
  },
  {
    path: 'server.token',
    group: 'Server',
    label: 'Token',
    type: 'password',
    effect: 'appRestart'
  },
  {
    path: 'proxy.enabled',
    group: 'Proxy',
    label: 'Enabled',
    type: 'boolean',
    effect: 'agentRestart'
  },
  {
    path: 'proxy.host',
    group: 'Proxy',
    label: 'Host',
    type: 'string',
    effect: 'agentRestart'
  },
  {
    path: 'proxy.port',
    group: 'Proxy',
    label: 'Port',
    type: 'number',
    effect: 'agentRestart'
  },
  {
    path: 'agents.codex.enabled',
    group: 'Agents',
    label: 'Codex',
    type: 'boolean',
    effect: 'agentRestart'
  },
  {
    path: 'agents.claude.enabled',
    group: 'Agents',
    label: 'Claude',
    type: 'boolean',
    effect: 'agentRestart'
  },
  {
    path: 'workspace.path',
    group: 'Workspace',
    label: 'Path',
    type: 'string',
    effect: 'agentRestart'
  },
  {
    path: 'channels.web.enabled',
    group: 'Web',
    label: 'Enabled',
    type: 'boolean',
    effect: 'appRestart'
  },
  {
    path: 'channels.feishu.enabled',
    group: 'Feishu',
    label: 'Enabled',
    type: 'boolean',
    effect: 'channelReconnect'
  },
  {
    path: 'channels.feishu.appId',
    group: 'Feishu',
    label: 'App ID',
    type: 'string',
    effect: 'channelReconnect'
  },
  {
    path: 'channels.feishu.appSecret',
    group: 'Feishu',
    label: 'App Secret',
    type: 'password',
    effect: 'channelReconnect'
  },
  {
    path: 'channels.feishu.chatId',
    group: 'Feishu',
    label: 'Chat ID',
    type: 'string',
    effect: 'channelReconnect'
  },
  {
    path: 'channels.feishu.ws',
    group: 'Feishu',
    label: 'WebSocket',
    type: 'string',
    effect: 'channelReconnect'
  },
  {
    path: 'channels.feishuWebhook.enabled',
    group: 'Feishu Webhook',
    label: 'Enabled',
    type: 'boolean',
    effect: 'channelReconnect'
  },
  {
    path: 'channels.feishuWebhook.url',
    group: 'Feishu Webhook',
    label: 'URL',
    type: 'password',
    effect: 'channelReconnect'
  },
  {
    path: 'channels.email.enabled',
    group: 'Email',
    label: 'Enabled',
    type: 'boolean',
    effect: 'channelReconnect'
  },
  {
    path: 'channels.email.user',
    group: 'Email',
    label: 'User',
    type: 'string',
    effect: 'channelReconnect'
  },
  {
    path: 'channels.email.agent.imap.host',
    group: 'Email IMAP',
    label: 'Host',
    type: 'string',
    effect: 'channelReconnect'
  },
  {
    path: 'channels.email.agent.imap.port',
    group: 'Email IMAP',
    label: 'Port',
    type: 'number',
    effect: 'channelReconnect'
  },
  {
    path: 'channels.email.agent.imap.secure',
    group: 'Email IMAP',
    label: 'Secure',
    type: 'boolean',
    effect: 'channelReconnect'
  },
  {
    path: 'channels.email.agent.imap.user',
    group: 'Email IMAP',
    label: 'User',
    type: 'string',
    effect: 'channelReconnect'
  },
  {
    path: 'channels.email.agent.imap.password',
    group: 'Email IMAP',
    label: 'Password',
    type: 'password',
    effect: 'channelReconnect'
  },
  {
    path: 'channels.email.agent.imap.mailbox',
    group: 'Email IMAP',
    label: 'Mailbox',
    type: 'string',
    effect: 'channelReconnect'
  },
  {
    path: 'channels.email.agent.smtp.host',
    group: 'Email SMTP',
    label: 'Host',
    type: 'string',
    effect: 'channelReconnect'
  },
  {
    path: 'channels.email.agent.smtp.port',
    group: 'Email SMTP',
    label: 'Port',
    type: 'number',
    effect: 'channelReconnect'
  },
  {
    path: 'channels.email.agent.smtp.secure',
    group: 'Email SMTP',
    label: 'Secure',
    type: 'boolean',
    effect: 'channelReconnect'
  },
  {
    path: 'channels.email.agent.smtp.user',
    group: 'Email SMTP',
    label: 'User',
    type: 'string',
    effect: 'channelReconnect'
  },
  {
    path: 'channels.email.agent.smtp.password',
    group: 'Email SMTP',
    label: 'Password',
    type: 'password',
    effect: 'channelReconnect'
  },
  {
    path: 'channels.email.agent.smtp.from',
    group: 'Email SMTP',
    label: 'From',
    type: 'string',
    effect: 'channelReconnect'
  },
  {
    path: 'channels.email.idle',
    group: 'Email',
    label: 'Idle',
    type: 'boolean',
    effect: 'channelReconnect'
  },
  {
    path: 'channels.email.pollSeconds',
    group: 'Email',
    label: 'Poll Seconds',
    type: 'number',
    effect: 'channelReconnect'
  },
  {
    path: 'update.enabled',
    group: 'Update',
    label: 'Enabled',
    type: 'boolean',
    effect: 'hot'
  },
  {
    path: 'update.baseUrl',
    group: 'Update',
    label: 'Base URL',
    type: 'string',
    effect: 'hot'
  }
]

export function resolveConfigEffects(paths: string[]): ConfigEffect[] {
  const effects = new Set<ConfigEffect>()
  for (const path of paths) {
    const descriptor = configFieldDescriptors.find((item) => item.path === path)
    if (descriptor) {
      effects.add(descriptor.effect)
      continue
    }
    if (path.startsWith('server.') || path.startsWith('channels.web.')) {
      effects.add('appRestart')
    } else if (path.startsWith('channels.')) {
      effects.add('channelReconnect')
    } else if (path.startsWith('agents.') || path.startsWith('proxy.') || path.startsWith('workspace.')) {
      effects.add('agentRestart')
    } else {
      effects.add('hot')
    }
  }
  return [...effects]
}
