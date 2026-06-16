import { z } from 'zod'

export const ProxyConfigSchema = z.object({
  enabled: z.boolean().default(false),
  http: z.string().optional(),
  https: z.string().optional(),
  socks: z.string().optional(),
  noProxy: z.array(z.string()).default([])
})

export const AgentConfigSchema = z.object({
  enabled: z.boolean().default(true),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  autoLoadSkill: z.boolean().default(true),
  env: z.record(z.string(), z.string()).default({})
})

export const ChannelConfigSchema = z.object({
  enabled: z.boolean().default(true),
  appId: z.string().optional(),
  appSecret: z.string().optional(),
  verificationToken: z.string().optional(),
  encryptKey: z.string().optional(),
  mentionRequired: z.boolean().optional()
}).passthrough()

export const WorkspaceConfigSchema = z.object({
  path: z.string().min(1),
  defaultAgent: z.string().optional(),
  allowedChannels: z.array(z.string()).default([])
})

export const ConfigSchema = z.object({
  server: z.object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().positive().default(8787),
    publicUrl: z.string().optional()
  }).default({
    host: '127.0.0.1',
    port: 8787
  }),
  proxy: ProxyConfigSchema.default({
    enabled: false,
    noProxy: []
  }),
  defaultAgent: z.string().default('echo'),
  agents: z.record(z.string(), AgentConfigSchema).default({}),
  channels: z.record(z.string(), ChannelConfigSchema).default({}),
  workspaces: z.record(z.string(), WorkspaceConfigSchema).default({}),
  routing: z.object({
    defaultWorkspace: z.string().default('default'),
    repoCommand: z.string().default('/repo')
  }).default({
    defaultWorkspace: 'default',
    repoCommand: '/repo'
  }),
  messaging: z.object({
    maxOutboundChars: z.number().int().positive().default(1800),
    maxOutboundPerMinute: z.number().int().positive().default(3),
    allowMarkdown: z.boolean().default(true)
  }).default({
    maxOutboundChars: 1800,
    maxOutboundPerMinute: 3,
    allowMarkdown: true
  }),
  security: z.object({
    blockSecrets: z.boolean().default(true)
  }).default({
    blockSecrets: true
  })
})

export type CodexioConfig = z.infer<typeof ConfigSchema>
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>
export type AgentConfig = z.infer<typeof AgentConfigSchema>
export type ChannelConfig = z.infer<typeof ChannelConfigSchema>
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>
