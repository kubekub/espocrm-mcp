import { z } from "zod";
import { Config } from "../types.js";

const ConfigSchema = z.object({
  espocrm: z.object({
    baseUrl: z.string().url("ESPOCRM_URL must be a valid URL"),
    apiKey: z.string().min(1, "ESPOCRM_API_KEY is required"),
    authMethod: z.enum(['apikey', 'hmac']).default('apikey'),
    secretKey: z.string().optional(),
  }),
  server: z.object({
    transport: z.enum(['stdio', 'streamable-http']).default('stdio'),
    httpHost: z.string().min(1).default('0.0.0.0'),
    httpPort: z.number().int().min(1).max(65535).default(3000),
    httpPath: z.string().min(1).default('/mcp'),
    rateLimit: z.number().min(1).default(100),
    timeout: z.number().min(1000).default(30000),
    logLevel: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  }),
});

export function loadConfig(): Config {
  const config = {
    espocrm: {
      baseUrl: process.env.ESPOCRM_URL,
      apiKey: process.env.ESPOCRM_API_KEY,
      authMethod: process.env.ESPOCRM_AUTH_METHOD || 'apikey',
      secretKey: process.env.ESPOCRM_SECRET_KEY,
    },
    server: {
      transport: process.env.MCP_TRANSPORT || 'stdio',
      httpHost: process.env.MCP_HTTP_HOST || '0.0.0.0',
      httpPort: parseInt(process.env.MCP_HTTP_PORT || '3000'),
      httpPath: process.env.MCP_HTTP_PATH || '/mcp',
      rateLimit: parseInt(process.env.RATE_LIMIT || '100'),
      timeout: parseInt(process.env.REQUEST_TIMEOUT || '30000'),
      logLevel: process.env.LOG_LEVEL || 'info',
    },
  };

  try {
    return ConfigSchema.parse(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const messages = error.errors.map(err => `${err.path.join('.')}: ${err.message}`);
      throw new Error(`Configuration validation failed:\n${messages.join('\n')}`);
    }
    throw error;
  }
}

export function validateConfiguration(): string[] {
  const errors: string[] = [];
  
  if (!process.env.ESPOCRM_URL) {
    errors.push("ESPOCRM_URL environment variable is required");
  }
  
  if (!process.env.ESPOCRM_API_KEY) {
    errors.push("ESPOCRM_API_KEY environment variable is required");
  }
  
  if (process.env.ESPOCRM_URL) {
    try {
      new URL(process.env.ESPOCRM_URL);
    } catch {
      errors.push("ESPOCRM_URL must be a valid URL");
    }
  }
  
  if (process.env.ESPOCRM_AUTH_METHOD === 'hmac' && !process.env.ESPOCRM_SECRET_KEY) {
    errors.push("ESPOCRM_SECRET_KEY is required when using HMAC authentication");
  }

  if (process.env.MCP_TRANSPORT && !['stdio', 'streamable-http'].includes(process.env.MCP_TRANSPORT)) {
    errors.push("MCP_TRANSPORT must be either 'stdio' or 'streamable-http'");
  }

  if (process.env.MCP_HTTP_PORT) {
    const port = parseInt(process.env.MCP_HTTP_PORT, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push("MCP_HTTP_PORT must be a valid port between 1 and 65535");
    }
  }

  if (process.env.MCP_HTTP_PATH && !process.env.MCP_HTTP_PATH.startsWith('/')) {
    errors.push("MCP_HTTP_PATH must start with '/' (e.g. /mcp)");
  }
  
  return errors;
}