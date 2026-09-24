import fs from 'node:fs';
import path from 'node:path';

export interface LogiccConfig {
  sessionId: string;
  orgId?: string;
  clientCookie: string;
  defaultChatId?: string;
}

export interface LogiccTokenState {
  jwt: string;
  expiresAt: number;
}

export class LogiccClient {
  private config: LogiccConfig;
  private tokenState: LogiccTokenState | null = null;
  private refreshPromise: Promise<string> | null = null;

  constructor(config: LogiccConfig) {
    this.config = config;
  }

  async getValidToken(): Promise<string> {
    if (this.tokenState && this.tokenState.expiresAt > Date.now() + 10_000) {
      return this.tokenState.jwt;
    }

    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshToken().finally(() => {
        this.refreshPromise = null;
      });
    }

    return this.refreshPromise;
  }

  async refreshToken(): Promise<string> {
    const url = `https://clerk.logicc.com/v1/client/sessions/${this.config.sessionId}/touch?__clerk_api_version=2026-05-12&_clerk_js_version=6.32.0`;
    const formBody = this.config.orgId ? `active_organization_id=${encodeURIComponent(this.config.orgId)}` : '';

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'cookie': this.config.clientCookie,
        'origin': 'https://app.logicc.com',
        'referer': 'https://app.logicc.com/',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: formBody
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Clerk touch failed (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as any;
    const session = data.response?.sessions?.find((s: any) => s.id === this.config.sessionId) || data.response;
    const jwt = session?.last_active_token?.jwt;

    if (!jwt) {
      throw new Error('Clerk touch did not return a valid JWT token');
    }

    // Clerk tokens expire in 60s, renew every 50s
    this.tokenState = {
      jwt,
      expiresAt: Date.now() + 50_000
    };

    return jwt;
  }

  async streamChat(options: {
    prompt: string;
    chatId?: string;
    modelId?: string;
    reasoningEffort?: string;
  }): Promise<ReadableStream<Uint8Array>> {
    const token = await this.getValidToken();
    const chatId = options.chatId || this.config.defaultChatId || '71defe4d-ce5e-4ec0-bda0-6f355c8c052e';
    const modelId = options.modelId || 'claude-5.5-opus';
    const reasoningEffort = options.reasoningEffort || 'high';

    const url = `https://app.logicc.com/api/chats/${chatId}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'accept': 'text/event-stream',
        'authorization': `Bearer ${token}`,
        'content-type': 'application/json',
        'origin': 'https://app.logicc.com',
        'referer': `https://app.logicc.com/chat/${chatId}`,
        'stream-response-protocol': 'ai-sdk-v6',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: JSON.stringify({
        isVoicePrompt: false,
        modelId,
        prompt: options.prompt,
        reasoningEffort
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Logicc chat failed (${res.status}): ${errText}`);
    }

    if (!res.body) {
      throw new Error('Empty body from Logicc');
    }

    return res.body;
  }
}
