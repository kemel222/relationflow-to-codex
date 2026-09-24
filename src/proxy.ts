import express, { type Request, type Response } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TokenManager, type TokenState } from './token-manager.ts';
import { resolveUpstreamModel } from './model-resolver.ts';
import { uploadAttachment } from './attachment-manager.ts';

// Auto-load .env if present
function loadEnv() {
  const envPath = path.resolve('.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
    for (const line of lines) {
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
}
loadEnv();

const THREAD_FILE = path.resolve('thread_state.json');

export function getActiveThreadId(): string {
  try {
    if (fs.existsSync(THREAD_FILE)) {
      const data = JSON.parse(fs.readFileSync(THREAD_FILE, 'utf-8'));
      if (data.threadId) return data.threadId;
    }
  } catch {}
  return process.env.ACTIVE_THREAD_ID || 'a8d485fd-cd18-4abf-be15-288d6880670e';
}

export function saveActiveThreadId(threadId: string): void {
  try {
    fs.writeFileSync(THREAD_FILE, JSON.stringify({ threadId, updatedAt: new Date().toISOString() }, null, 2), 'utf-8');
  } catch (e) {
    console.warn('[Proxy] Failed to save thread ID:', e);
  }
}

export interface ProxyConfig {
  port?: number;
  relationFlowUrl: string;
  accountSlug?: string;
  tokenManager: TokenManager;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | string;
  content: string;
}

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  threadId?: string;
  [key: string]: any;
}

export function formatMessagesForRelationFlow(messages: ChatMessage[], maxChars = 9800): string {
  if (!messages || messages.length === 0) return '';

  const formatted = messages.map(m => {
    const role = (m.role || 'user').toLowerCase();
    if (role === 'system') return `[System]:\n${m.content}`;
    if (role === 'assistant') return `[Assistant]:\n${m.content}`;
    return `[User]:\n${m.content}`;
  });

  // Most recent message has top priority
  let lastMsg = formatted[formatted.length - 1];
  if (lastMsg.length > maxChars) {
    return lastMsg.slice(0, maxChars - 120) + '\n\n[... Truncated to fit RelationFlow message limit]';
  }

  // Work backwards from the second to last message to include recent context
  const selected: string[] = [lastMsg];
  let currentLen = lastMsg.length;

  for (let i = formatted.length - 2; i >= 0; i--) {
    const msg = formatted[i];
    if (currentLen + msg.length + 2 <= maxChars) {
      selected.unshift(msg);
      currentLen += msg.length + 2;
    } else {
      break;
    }
  }

  return selected.join('\n\n');
}

export function createProxyApp(config: ProxyConfig) {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      activeThreadId: getActiveThreadId(),
      timestamp: new Date().toISOString()
    });
  });

  // Endpoint to reset thread / start fresh conversation
  app.all(['/v1/thread/new', '/v1/thread/reset'], (_req: Request, res: Response) => {
    const newThreadId = crypto.randomUUID();
    saveActiveThreadId(newThreadId);
    console.log(`[Proxy] Active thread reset to new ID: ${newThreadId}`);
    res.json({ status: 'ok', message: 'Thread reset successfully', threadId: newThreadId });
  });

  app.get(['/v1', '/v1/models'], (_req: Request, res: Response) => {
    const defaultModel = resolveUpstreamModel();
    res.json({
      object: 'list',
      data: [
        {
          id: defaultModel,
          object: 'model',
          created: 1700000000,
          owned_by: 'relationflow'
        },
        {
          id: 'claude-opus-5.5',
          object: 'model',
          created: 1700000000,
          owned_by: 'relationflow'
        },
        {
          id: 'gpt-6-astra',
          object: 'model',
          created: 1700000000,
          owned_by: 'relationflow'
        },
        {
          id: 'relationflow-chat',
          object: 'model',
          created: 1700000000,
          owned_by: 'relationflow'
        },
        {
          id: 'claude-3-5-sonnet',
          object: 'model',
          created: 1700000000,
          owned_by: 'relationflow'
        },
        {
          id: 'gpt-4o',
          object: 'model',
          created: 1700000000,
          owned_by: 'relationflow'
        }
      ]
    });
  });

  app.post('/v1/chat/completions', async (req: Request, res: Response) => {
    const body = req.body as ChatCompletionRequest;

    if (!body || !Array.isArray(body.messages)) {
      return res.status(400).json({
        error: {
          message: 'Invalid request: "messages" array is required.',
          type: 'invalid_request_error'
        }
      });
    }

    const isStream = Boolean(body.stream);
    const chatId = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const clientModel = body.model || 'managed:claude-opus-5.5';

    try {
      // 1. Obtain valid access token (refreshes via Supabase Auth if needed)
      let tokenState = await config.tokenManager.getValidToken();

      // 2. Prepare request payload for RelationFlow /api/chat
      const upstreamModel = resolveUpstreamModel(body.model);
      const accountSlug = config.accountSlug || process.env.ACCOUNT_SLUG || 'mihjrus1xyp7';
      const activeThreadId = body.threadId || getActiveThreadId();

      // Join full content to check size
      const rawFullMessage = body.messages.map(m => m.content).join('\n\n');
      let attachments: any[] = [];
      let finalMessage = '';

      // If prompt/files exceed 7500 chars, auto-upload full context as encrypted attachment
      // so Claude receives up to 100k+ tokens without hitting 10,000 char message limit!
      if (rawFullMessage.length > 7500) {
        console.log(`[Proxy] Large prompt detected (${rawFullMessage.length} chars). Uploading as encrypted attachment...`);
        try {
          attachments = await uploadAttachment({
            content: rawFullMessage,
            fileName: 'context.txt',
            mimeType: 'text/plain',
            threadId: activeThreadId,
            accountSlug,
            relationFlowUrl: config.relationFlowUrl,
            tokenManager: config.tokenManager
          });
          console.log(`[Proxy] Attachment uploaded successfully. Attachment IDs:`, attachments.map(a => a.id));

          // Get last user prompt as the message text
          const lastUserMsg = body.messages.filter(m => m.role === 'user').pop();
          const instruction = lastUserMsg ? lastUserMsg.content.slice(0, 2000) : 'Обработай прикрепленный файл и контекст.';
          finalMessage = `[Полный контекст диалога и прикрепленные файлы загружены во вложение]\n\nЗапрос пользователя:\n${instruction}`;
        } catch (attErr) {
          console.warn('[Proxy] Auto-attachment upload failed, falling back to message budgeting:', attErr);
          finalMessage = formatMessagesForRelationFlow(body.messages, 9800);
        }
      } else {
        finalMessage = formatMessagesForRelationFlow(body.messages, 9800);
      }

      const upstreamBody: Record<string, any> = {
        threadId: activeThreadId,
        clientTurnId: crypto.randomUUID(),
        accountSlug,
        model: upstreamModel,
        useRag: false,
        knowledgeEnabled: false,
        connectorsEnabled: false,
        message: finalMessage,
        knowledgeMentionFileIds: []
      };

      if (attachments && attachments.length > 0) {
        upstreamBody.attachments = attachments;
      }

      const buildHeaders = (token: TokenState) => {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'Accept': '*/*',
          'Origin': config.relationFlowUrl,
          'Referer': `${config.relationFlowUrl}/dashboard/${accountSlug}/chat?thread=${activeThreadId}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        };
        if (token.session_cookie) {
          headers['Cookie'] = token.session_cookie;
        }
        if (token.access_token) {
          headers['Authorization'] = `Bearer ${token.access_token}`;
        }
        return headers;
      };

      const upstreamUrl = `${config.relationFlowUrl.replace(/\/+$/, '')}/api/chat`;
      let upstreamResponse = await fetch(upstreamUrl, {
        method: 'POST',
        headers: buildHeaders(tokenState),
        body: JSON.stringify(upstreamBody)
      });

      // Auto retry once on 401 with force token refresh
      if (upstreamResponse.status === 401) {
        console.log('[Proxy] Upstream 401: force refreshing Supabase session token...');
        tokenState = await config.tokenManager.forceRefresh();
        upstreamResponse = await fetch(upstreamUrl, {
          method: 'POST',
          headers: buildHeaders(tokenState),
          body: JSON.stringify(upstreamBody)
        });
      }

      // If thread not found (404), reset thread and retry once
      if (upstreamResponse.status === 404) {
        console.log('[Proxy] Upstream 404: thread not found, creating new thread...');
        const newThreadId = crypto.randomUUID();
        saveActiveThreadId(newThreadId);
        upstreamBody.threadId = newThreadId;
        upstreamResponse = await fetch(upstreamUrl, {
          method: 'POST',
          headers: buildHeaders(tokenState),
          body: JSON.stringify(upstreamBody)
        });
      }

      // Persist thread ID returned in headers
      const respThreadId = upstreamResponse.headers.get('x-thread-id');
      if (respThreadId && respThreadId !== activeThreadId) {
        saveActiveThreadId(respThreadId);
      }

      if (!upstreamResponse.ok) {
        const errorText = await upstreamResponse.text();
        return res.status(upstreamResponse.status).json({
          error: {
            message: `RelationFlow upstream error (${upstreamResponse.status}): ${errorText}`,
            type: 'upstream_error',
            status: upstreamResponse.status
          }
        });
      }

      if (!upstreamResponse.body) {
        return res.status(502).json({
          error: {
            message: 'Empty response body from RelationFlow upstream',
            type: 'upstream_error'
          }
        });
      }

      const reader = upstreamResponse.body.getReader();
      const decoder = new TextDecoder('utf-8');

      // 4. Branch based on stream flag
      if (isStream) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const textChunk = decoder.decode(value, { stream: true });
            if (!textChunk) continue;

            const chunkPayload = {
              id: chatId,
              object: 'chat.completion.chunk',
              created,
              model: clientModel,
              choices: [
                {
                  index: 0,
                  delta: { content: textChunk },
                  finish_reason: null
                }
              ]
            };

            res.write(`data: ${JSON.stringify(chunkPayload)}\n\n`);
          }

          // Final stop chunk
          const finishPayload = {
            id: chatId,
            object: 'chat.completion.chunk',
            created,
            model: clientModel,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: 'stop'
              }
            ]
          };
          res.write(`data: ${JSON.stringify(finishPayload)}\n\n`);
          res.write('data: [DONE]\n\n');
        } finally {
          res.end();
        }
      } else {
        // [stream = false]: accumulate entire upstream text into one completion object
        let fullContent = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          fullContent += decoder.decode(value, { stream: true });
        }

        const completion = {
          id: chatId,
          object: 'chat.completion',
          created,
          model: clientModel,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: fullContent
              },
              finish_reason: 'stop'
            }
          ],
          usage: {
            prompt_tokens: 0,
            completion_tokens: fullContent.length,
            total_tokens: fullContent.length
          }
        };

        res.setHeader('Content-Type', 'application/json');
        res.json(completion);
      }
    } catch (err: any) {
      console.error('[Proxy Error]', err);
      if (!res.headersSent) {
        res.status(500).json({
          error: {
            message: err.message || 'Internal proxy error',
            type: 'proxy_error'
          }
        });
      } else {
        res.end();
      }
    }
  });

  return app;
}

// Standalone execution entrypoint
if (process.argv[1] && process.argv[1].endsWith('proxy.ts')) {
  const port = parseInt(process.env.PORT || '3000', 10);
  const supabaseUrl = process.env.SUPABASE_URL || 'https://auth.relationflow.io';
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || 'sb_publishable_tHnRZvqCh23wsocWynthJg_5bQVoFsA';
  const relationFlowUrl = process.env.RELATIONFLOW_URL || 'https://app.relationflow.io';
  const accountSlug = process.env.ACCOUNT_SLUG || 'mihjrus1xyp7';

  const tokenManager = new TokenManager({
    supabaseUrl,
    supabaseAnonKey,
    initialTokens: {
      access_token: process.env.INITIAL_ACCESS_TOKEN || '',
      refresh_token: process.env.INITIAL_REFRESH_TOKEN || '',
      expires_at: 0,
      session_cookie: process.env.INITIAL_SESSION_COOKIE || ''
    }
  });

  const app = createProxyApp({
    port,
    relationFlowUrl,
    accountSlug,
    tokenManager
  });

  app.listen(port, () => {
    console.log(`[RelationFlow Proxy] Listening on http://localhost:${port}`);
    console.log(`Active thread ID: ${getActiveThreadId()}`);
    console.log(`OpenAI API compatible endpoint: http://localhost:${port}/v1/chat/completions`);
  });
}
