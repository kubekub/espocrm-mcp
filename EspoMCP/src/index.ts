#!/usr/bin/env node

// Load environment variables from .env file
try {
  const { readFileSync } = await import('fs');
  const envContent = readFileSync('.env', 'utf8');
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      if (key && valueParts.length > 0) {
        process.env[key] = valueParts.join('=');
      }
    }
  });
  console.log('✓ Loaded .env file');
} catch (error) {
  console.log('ℹ No .env file found, using environment variables only');
}

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { loadConfig, validateConfiguration } from "./config/index.js";
import { setupEspoCRMTools } from "./tools/index.js";
import logger from "./utils/logger.js";

type SessionContext = {
  transport: StreamableHTTPServerTransport;
  server: Server;
};

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return undefined;
  }
  const rawBody = Buffer.concat(chunks).toString("utf-8").trim();
  if (!rawBody) {
    return undefined;
  }
  return JSON.parse(rawBody);
}

function createJsonRpcError(
  res: ServerResponse,
  statusCode: number,
  message: string,
  code: number = -32000,
): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    }),
  );
}

async function createMcpServerInstance(config: ReturnType<typeof loadConfig>): Promise<Server> {
  const server = new Server(
    {
      name: "EspoCRM Integration Server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  await setupEspoCRMTools(server, config);
  return server;
}

async function startHttpTransport(config: ReturnType<typeof loadConfig>): Promise<void> {
  const sessions: Record<string, SessionContext> = {};

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const method = req.method ?? "GET";
      const parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (parsedUrl.pathname !== config.server.httpPath) {
        res.statusCode = 404;
        res.end("Not Found");
        return;
      }

      const sessionIdHeader = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

      if (method === "POST") {
        const parsedBody = await readJsonBody(req);

        if (sessionId && sessions[sessionId]) {
          await sessions[sessionId].transport.handleRequest(req, res, parsedBody);
          return;
        }

        if (!sessionId && isInitializeRequest(parsedBody)) {
          let sessionTransport!: StreamableHTTPServerTransport;
          sessionTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: async (newSessionId: string) => {
              sessions[newSessionId] = {
                transport: sessionTransport,
                server: sessionServer,
              };
            },
            onsessionclosed: async (closedSessionId: string) => {
              const existing = sessions[closedSessionId];
              if (existing) {
                await existing.server.close();
                delete sessions[closedSessionId];
              }
            },
          });

          sessionTransport.onclose = () => {
            if (sessionTransport.sessionId && sessions[sessionTransport.sessionId]) {
              delete sessions[sessionTransport.sessionId];
            }
          };

          const sessionServer = await createMcpServerInstance(config);
          await sessionServer.connect(sessionTransport);
          await sessionTransport.handleRequest(req, res, parsedBody);
          return;
        }

        createJsonRpcError(res, 400, "Bad Request: No valid session ID provided");
        return;
      }

      if (method === "GET" || method === "DELETE") {
        if (!sessionId || !sessions[sessionId]) {
          res.statusCode = 400;
          res.end("Invalid or missing session ID");
          return;
        }

        await sessions[sessionId].transport.handleRequest(req, res);
        return;
      }

      createJsonRpcError(res, 405, "Method not allowed.");
    } catch (error: any) {
      logger.error("HTTP transport request error", {
        error: error?.message,
        stack: error?.stack,
      });
      if (!res.headersSent) {
        createJsonRpcError(res, 500, "Internal server error", -32603);
      }
    }
  });

  httpServer.listen(config.server.httpPort, config.server.httpHost, () => {
    logger.info("EspoCRM MCP Server started with streamable HTTP transport", {
      host: config.server.httpHost,
      port: config.server.httpPort,
      path: config.server.httpPath,
    });
  });
}

async function main() {
  try {
    // Validate environment configuration
    const configErrors = validateConfiguration();
    if (configErrors.length > 0) {
      logger.error('Configuration validation failed', { errors: configErrors });
      console.error('Configuration errors:');
      configErrors.forEach(error => console.error(`  - ${error}`));
      console.error('\nPlease check your environment variables and try again.');
      console.error('See .env.example for required configuration.');
      process.exit(1);
    }
    
    // Load configuration
    const config = loadConfig();
    logger.info('Configuration loaded successfully', { 
      espoUrl: config.espocrm.baseUrl,
      authMethod: config.espocrm.authMethod,
      rateLimit: config.server.rateLimit 
    });
    
    if (config.server.transport === 'streamable-http') {
      logger.info('Starting MCP server with streamable HTTP transport', {
        host: config.server.httpHost,
        port: config.server.httpPort,
        path: config.server.httpPath,
      });
      await startHttpTransport(config);
      return;
    }

    const server = await createMcpServerInstance(config);
    logger.info('MCP server created', { name: "EspoCRM Integration Server" });

    const transport = new StdioServerTransport();
    logger.info('Starting MCP server with stdio transport');
    await server.connect(transport);

    logger.info('EspoCRM MCP Server started successfully');
    
  } catch (error: any) {
    logger.error('Failed to start EspoCRM MCP Server', { 
      error: error.message,
      stack: error.stack 
    });
    console.error('Failed to start server:', error.message);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down gracefully');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down gracefully');
  process.exit(0);
});

process.on('uncaughtException', (error: any) => {
  logger.error('Uncaught exception', { error: error.message, stack: error.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason: any, promise) => {
  logger.error('Unhandled rejection', { reason, promise });
  process.exit(1);
});

// Start the server
main().catch((error: any) => {
  logger.error('Fatal error during startup', { error: error.message, stack: error.stack });
  console.error('Fatal error:', error.message);
  process.exit(1);
});