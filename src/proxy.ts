import express, { type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { TokenManager, type TokenManagerConfig } from './token-manager.ts';

export interface ProxyConfig {
  port?: number;
  relationFlowUrl: string;
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
  [key: string]: any;
}

export function createProxyApp(config: ProxyConfig) {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get(['/v1', '/v1/models'], (_req: Request, res: Response) => {
    res.json({
      object: 'list',
      data: [
        {
          id: 'relationflow-chat',
          object: 'model',
          created: 1700000000,
          owned_by: 'relationflow'
        },
        {
          id: 'gpt-4o',
          object: 'model',
          created: 1700000000,
          owned_by: 'relationflow'
        },
        {
          id: 'gpt-4o-mini',
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
    const model = body.model || 'relationflow-chat';

    try {
      // 1. Obtain valid access token (refreshes via Supabase Auth if needed)
      const tokenState = await config.tokenManager.getValidToken();

      // 2. Prepare headers for RelationFlow
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenState.access_token}`
      };

      if (tokenState.session_cookie) {
        headers['Cookie'] = tokenState.session_cookie;
      }

      // 3. Forward request to RelationFlow /api/chat
      const upstreamUrl = `${config.relationFlowUrl.replace(/\/+$/, '')}/api/chat`;
      const upstreamResponse = await fetch(upstreamUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });

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
              model,
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
            model,
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
          model,
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
  const supabaseUrl = process.env.SUPABASE_URL || 'http://localhost:54321';
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || 'default-anon-key';
  const relationFlowUrl = process.env.RELATIONFLOW_URL || 'http://localhost:4000';

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
    tokenManager
  });

  app.listen(port, () => {
    console.log(`[RelationFlow Proxy] Listening on http://localhost:${port}`);
    console.log(`OpenAI API compatible endpoint: http://localhost:${port}/v1/chat/completions`);
  });
}
