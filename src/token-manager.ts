import fs from 'node:fs/promises';
import path from 'node:path';

export interface TokenState {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix timestamp in ms
  session_cookie?: string;
}

export interface TokenManagerConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  storageFilePath?: string;
  initialTokens?: Partial<TokenState>;
  bufferMs?: number; // Refresh before expiration margin (default 60s)
}

export class TokenManager {
  private config: TokenManagerConfig;
  private state: TokenState | null = null;
  private refreshPromise: Promise<TokenState> | null = null;
  private storagePath: string;

  constructor(config: TokenManagerConfig) {
    this.config = config;
    this.storagePath = config.storageFilePath || path.resolve('./tokens.json');
  }

  async loadTokens(): Promise<TokenState> {
    if (this.state) {
      return this.state;
    }

    try {
      const raw = await fs.readFile(this.storagePath, 'utf-8');
      this.state = JSON.parse(raw);
      return this.state!;
    } catch {
      this.state = {
        access_token: this.config.initialTokens?.access_token || '',
        refresh_token: this.config.initialTokens?.refresh_token || '',
        expires_at: this.config.initialTokens?.expires_at ?? 0,
        session_cookie: this.config.initialTokens?.session_cookie || ''
      };
      return this.state;
    }
  }

  async saveTokens(newState: TokenState): Promise<void> {
    this.state = newState;
    await fs.mkdir(path.dirname(this.storagePath), { recursive: true });
    await fs.writeFile(this.storagePath, JSON.stringify(newState, null, 2), 'utf-8');
  }

  async getValidToken(): Promise<TokenState> {
    const current = await this.loadTokens();
    const buffer = this.config.bufferMs ?? 60_000;

    // If token exists and is not expired (taking buffer into account)
    if (current.access_token && current.expires_at > Date.now() + buffer) {
      return current;
    }

    // Mutex / promise sharing for concurrent requests
    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshToken().finally(() => {
        this.refreshPromise = null;
      });
    }

    return this.refreshPromise;
  }

  async forceRefresh(): Promise<TokenState> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshToken().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  private async refreshToken(): Promise<TokenState> {
    const current = await this.loadTokens();

    if (!current.refresh_token) {
      throw new Error('Cannot refresh token: no refresh_token available');
    }

    const refreshUrl = `${this.config.supabaseUrl.replace(/\/+$/, '')}/auth/v1/token?grant_type=refresh_token`;
    const response = await fetch(refreshUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': this.config.supabaseAnonKey
      },
      body: JSON.stringify({
        refresh_token: current.refresh_token
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Supabase Auth refresh failed (${response.status}): ${errText}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in?: number;
      expires_at?: number;
      [key: string]: any;
    };

    const expiresInSec = data.expires_in || 3600;
    const expiresAt = data.expires_at ? data.expires_at * 1000 : Date.now() + expiresInSec * 1000;

    // Reconstruct Supabase session cookie chunking
    const sessionJson = JSON.stringify(data);
    const sessionBase64 = Buffer.from(sessionJson).toString('base64');
    const CHUNK_SIZE = 3180;
    const chunk0 = sessionBase64.slice(0, CHUNK_SIZE);
    const chunk1 = sessionBase64.slice(CHUNK_SIZE);

    let otherCookies: string[] = [];
    if (current.session_cookie) {
      otherCookies = current.session_cookie
        .split(';')
        .map(c => c.trim())
        .filter(c => c && !c.startsWith('sb-auth-auth-token.'));
    }
    if (otherCookies.length === 0) {
      otherCookies = ['relationflow-beta-notice-dismissed=v1', 'NEXT_LOCALE=en'];
    }

    const newCookie = [
      `sb-auth-auth-token.0=base64-${chunk0}`,
      ...(chunk1 ? [`sb-auth-auth-token.1=${chunk1}`] : []),
      ...otherCookies
    ].join('; ');

    const newState: TokenState = {
      access_token: data.access_token,
      refresh_token: data.refresh_token, // Rotated refresh token!
      expires_at: expiresAt,
      session_cookie: newCookie
    };

    await this.saveTokens(newState);
    return newState;
  }

  getState(): TokenState | null {
    return this.state;
  }
}

