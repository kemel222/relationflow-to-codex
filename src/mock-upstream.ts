import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';

export interface MockAuthHistory {
  refreshTokenReceived: string;
  timestamp: number;
}

export interface MockRelationFlowHistory {
  authorization: string;
  cookie?: string;
  body: any;
  timestamp: number;
}

export class MockUpstreams {
  public authHistory: MockAuthHistory[] = [];
  public relationFlowHistory: MockRelationFlowHistory[] = [];
  public refreshCount = 0;
  
  private authApp = express();
  private relationFlowApp = express();
  private authServer: Server | null = null;
  private relationFlowServer: Server | null = null;

  public authPort = 0;
  public relationFlowPort = 0;

  constructor() {
    this.setupAuthServer();
    this.setupRelationFlowServer();
  }

  private setupAuthServer() {
    this.authApp.use(express.json());

    this.authApp.post('/auth/v1/token', (req: Request, res: Response) => {
      const grantType = req.query.grant_type;
      const apikey = req.headers['apikey'];
      const { refresh_token } = req.body || {};

      if (!apikey) {
        return res.status(401).json({ error: 'Missing apikey header' });
      }

      if (grantType !== 'refresh_token') {
        return res.status(400).json({ error: 'Unsupported grant_type' });
      }

      if (!refresh_token) {
        return res.status(400).json({ error: 'Missing refresh_token' });
      }

      this.refreshCount++;
      this.authHistory.push({
        refreshTokenReceived: refresh_token,
        timestamp: Date.now()
      });

      const newAccessToken = `supabase-access-token-${this.refreshCount}`;
      const newRefreshToken = `rotated-refresh-token-${this.refreshCount}`;

      res.setHeader('Set-Cookie', `sb_session=session_cookie_v${this.refreshCount}; Path=/; HttpOnly`);
      return res.json({
        access_token: newAccessToken,
        refresh_token: newRefreshToken,
        token_type: 'bearer',
        expires_in: 3600
      });
    });
  }

  private setupRelationFlowServer() {
    this.relationFlowApp.use(express.json());

    this.relationFlowApp.post('/api/chat', async (req: Request, res: Response) => {
      const auth = req.headers['authorization'];
      const cookie = req.headers['cookie'];

      if (!auth || !auth.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or invalid Bearer token' });
      }

      this.relationFlowHistory.push({
        authorization: auth,
        cookie,
        body: req.body,
        timestamp: Date.now()
      });

      // Stream text chunks to client
      const chunks = [
        'Hello',
        ' from',
        ' RelationFlow',
        ' upstream',
        ' backend!'
      ];

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');

      for (const chunk of chunks) {
        res.write(chunk);
        // Small delay to simulate realistic streaming
        await new Promise((r) => setTimeout(r, 20));
      }

      res.end();
    });
  }

  async start(): Promise<{ authUrl: string; relationFlowUrl: string }> {
    await new Promise<void>((resolve) => {
      this.authServer = this.authApp.listen(0, () => {
        const addr = this.authServer!.address() as any;
        this.authPort = addr.port;
        resolve();
      });
    });

    await new Promise<void>((resolve) => {
      this.relationFlowServer = this.relationFlowApp.listen(0, () => {
        const addr = this.relationFlowServer!.address() as any;
        this.relationFlowPort = addr.port;
        resolve();
      });
    });

    return {
      authUrl: `http://localhost:${this.authPort}`,
      relationFlowUrl: `http://localhost:${this.relationFlowPort}`
    };
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.authServer) this.authServer.close(() => resolve());
      else resolve();
    });
    await new Promise<void>((resolve) => {
      if (this.relationFlowServer) this.relationFlowServer.close(() => resolve());
      else resolve();
    });
  }
}
