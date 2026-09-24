import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';
import { TokenManager } from './token-manager.ts';

// Load .env if present
const envPath = path.resolve(import.meta.dirname, '../.env');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'default-anon-key';
const RELATIONFLOW_URL = (process.env.RELATIONFLOW_URL || 'http://localhost:4000').replace(/\/+$/, '');
const TOKENS_PATH = path.resolve(import.meta.dirname, '../tokens.json');

const tokenManager = new TokenManager({
  supabaseUrl: SUPABASE_URL,
  supabaseAnonKey: SUPABASE_ANON_KEY,
  storageFilePath: TOKENS_PATH,
  initialTokens: {
    access_token: process.env.INITIAL_ACCESS_TOKEN || '',
    refresh_token: process.env.INITIAL_REFRESH_TOKEN || '',
    expires_at: 0,
    session_cookie: process.env.INITIAL_SESSION_COOKIE || ''
  }
});

// JSON-RPC 2.0 stdio transport
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

function sendResponse(response: any) {
  process.stdout.write(JSON.stringify(response) + '\n');
}

async function handleToolsCall(name: string, args: any) {
  if (name === 'relationflow_chat') {
    const message = args.message || args.prompt;
    if (!message) {
      throw new Error('Argument "message" is required');
    }

    const messages = [];
    if (args.system_prompt) {
      messages.push({ role: 'system', content: args.system_prompt });
    }
    messages.push({ role: 'user', content: message });

    // 1. Get valid Supabase token
    const auth = await tokenManager.getValidToken();

    // 2. Query RelationFlow
    const upstreamUrl = `${RELATIONFLOW_URL}/api/chat`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${auth.access_token}`
    };
    if (auth.session_cookie) {
      headers['Cookie'] = auth.session_cookie;
    }

    const res = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: args.model || 'relationflow-default',
        messages,
        stream: false
      })
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`RelationFlow responded with HTTP ${res.status}: ${err}`);
    }

    const text = await res.text();
    return {
      content: [
        {
          type: 'text',
          text
        }
      ]
    };
  }

  if (name === 'relationflow_check_status') {
    const tokens = await tokenManager.loadTokens();
    const hasAccess = Boolean(tokens.access_token);
    const hasRefresh = Boolean(tokens.refresh_token);
    const isExpired = tokens.expires_at <= Date.now();
    const expiresDate = tokens.expires_at ? new Date(tokens.expires_at).toISOString() : 'never/unset';

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              status: 'ready',
              relationFlowUrl: RELATIONFLOW_URL,
              supabaseUrl: SUPABASE_URL,
              hasAccessToken: hasAccess,
              hasRefreshToken: hasRefresh,
              tokenExpiresAt: expiresDate,
              isExpiredNow: isExpired
            },
            null,
            2
          )
        }
      ]
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

rl.on('line', async (line) => {
  if (!line.trim()) return;

  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = msg;

  if (method === 'initialize') {
    sendResponse({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: 'relationflow-mcp',
          version: '1.0.0'
        }
      }
    });
    return;
  }

  if (method === 'notifications/initialized') {
    // Client notification, no reply needed
    return;
  }

  if (method === 'tools/list') {
    sendResponse({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'relationflow_chat',
            description:
              'Send a prompt to RelationFlow with automatic Supabase Auth session refresh and token rotation',
            inputSchema: {
              type: 'object',
              properties: {
                message: {
                  type: 'string',
                  description: 'The user message or question to send to RelationFlow'
                },
                system_prompt: {
                  type: 'string',
                  description: 'Optional system instructions for RelationFlow'
                },
                model: {
                  type: 'string',
                  description: 'Optional model identifier'
                }
              },
              required: ['message']
            }
          },
          {
            name: 'relationflow_check_status',
            description: 'Check the status of Supabase Auth tokens and RelationFlow connectivity',
            inputSchema: {
              type: 'object',
              properties: {}
            }
          }
        ]
      }
    });
    return;
  }

  if (method === 'tools/call') {
    try {
      const result = await handleToolsCall(params.name, params.arguments || {});
      sendResponse({
        jsonrpc: '2.0',
        id,
        result
      });
    } catch (err: any) {
      sendResponse({
        jsonrpc: '2.0',
        id,
        result: {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Error calling ${params.name}: ${err.message}`
            }
          ]
        }
      });
    }
    return;
  }

  if (id !== undefined) {
    sendResponse({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32601,
        message: `Method not found: ${method}`
      }
    });
  }
});
