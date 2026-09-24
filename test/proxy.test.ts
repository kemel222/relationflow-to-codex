import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { Server } from 'node:http';

import { MockUpstreams } from '../src/mock-upstream.ts';
import { TokenManager } from '../src/token-manager.ts';
import { createProxyApp } from '../src/proxy.ts';

const TEST_STORAGE_DIR = path.resolve('./test-data');
const TEST_TOKENS_FILE = path.join(TEST_STORAGE_DIR, 'test-tokens.json');

test('RelationFlow Proxy End-to-End Suite', async (t) => {
  let upstreams: MockUpstreams;
  let proxyServer: Server;
  let proxyUrl: string;
  let tokenManager: TokenManager;

  t.before(async () => {
    await fs.mkdir(TEST_STORAGE_DIR, { recursive: true });
    try {
      await fs.unlink(TEST_TOKENS_FILE);
    } catch {}

    // 1. Start mock servers (Supabase Auth & RelationFlow)
    upstreams = new MockUpstreams();
    const { authUrl, relationFlowUrl } = await upstreams.start();

    // 2. Initialize token manager with expired initial token
    tokenManager = new TokenManager({
      supabaseUrl: authUrl,
      supabaseAnonKey: 'test-anon-key-123',
      storageFilePath: TEST_TOKENS_FILE,
      initialTokens: {
        access_token: 'initial-expired-access-token',
        refresh_token: 'initial-refresh-token-1',
        expires_at: 0 // Expired!
      }
    });

    // 3. Start proxy app
    const app = createProxyApp({
      relationFlowUrl,
      tokenManager
    });

    await new Promise<void>((resolve) => {
      proxyServer = app.listen(0, () => {
        const addr = proxyServer.address() as any;
        proxyUrl = `http://localhost:${addr.port}`;
        resolve();
      });
    });
  });

  t.after(async () => {
    if (proxyServer) {
      await new Promise<void>((r) => proxyServer.close(() => r()));
    }
    if (upstreams) {
      await upstreams.stop();
    }
    try {
      await fs.rm(TEST_STORAGE_DIR, { recursive: true, force: true });
    } catch {}
  });

  await t.test('1. [Token Refresh & Rotation] Automatically refreshes expired token on first request and persists rotated token', async () => {
    assert.equal(upstreams.refreshCount, 0, 'No refresh should have occurred yet');

    const res = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Привет' }],
        stream: false
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.object, 'chat.completion');
    assert.equal(data.choices[0].message.content, 'Hello from RelationFlow upstream backend!');

    // Verify Supabase Auth refresh was triggered with the initial refresh token
    assert.equal(upstreams.refreshCount, 1, 'Supabase Auth should be called once');
    assert.equal(upstreams.authHistory[0].refreshTokenReceived, 'initial-refresh-token-1');

    // Verify RelationFlow received the refreshed Bearer token and cookie
    assert.equal(upstreams.relationFlowHistory.length, 1);
    assert.equal(upstreams.relationFlowHistory[0].authorization, 'Bearer supabase-access-token-1');
    assert.match(upstreams.relationFlowHistory[0].cookie || '', /sb-auth-auth-token/);

    // Verify tokens were persisted to disk with rotation
    const rawSaved = await fs.readFile(TEST_TOKENS_FILE, 'utf-8');
    const saved = JSON.parse(rawSaved);
    assert.equal(saved.access_token, 'supabase-access-token-1');
    assert.equal(saved.refresh_token, 'rotated-refresh-token-1');
  });

  await t.test('2. [Streaming: stream=true] Streams SSE chunks format chat.completion.chunk ending in [DONE]', async () => {
    const res = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'relationflow-pro',
        messages: [{ role: 'user', content: 'Stream test' }],
        stream: true
      })
    });

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);

    const bodyText = await res.text();
    const lines = bodyText.split('\n\n').filter(Boolean);

    // Collect deltas
    let combinedContent = '';
    let sawDone = false;
    let sawStopReason = false;

    for (const line of lines) {
      if (line === 'data: [DONE]') {
        sawDone = true;
        continue;
      }
      if (line.startsWith('data: ')) {
        const payload = JSON.parse(line.slice(6));
        assert.equal(payload.object, 'chat.completion.chunk');
        assert.equal(payload.model, 'relationflow-pro');
        const choice = payload.choices[0];
        if (choice.delta?.content) {
          combinedContent += choice.delta.content;
        }
        if (choice.finish_reason === 'stop') {
          sawStopReason = true;
        }
      }
    }

    assert.equal(combinedContent, 'Hello from RelationFlow upstream backend!');
    assert.equal(sawStopReason, true, 'Should include finish_reason stop');
    assert.equal(sawDone, true, 'Should terminate stream with data: [DONE]');
  });

  await t.test('3. [Non-streaming: stream=false] Subsequent request reuses valid access token without calling Supabase Auth again', async () => {
    const previousRefreshCount = upstreams.refreshCount;

    const res = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'No stream test' }],
        stream: false
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.object, 'chat.completion');
    assert.equal(data.model, 'gpt-4o-mini');
    assert.equal(data.choices[0].finish_reason, 'stop');
    assert.equal(data.choices[0].message.role, 'assistant');
    assert.equal(data.choices[0].message.content, 'Hello from RelationFlow upstream backend!');

    // Token was still valid, so refreshCount must NOT increase
    assert.equal(upstreams.refreshCount, previousRefreshCount, 'Token should be reused without redundant refresh');
  });

  await t.test('4. [Concurrent Requests] Parallel requests share refresh promise and do not duplicate token rotation', async () => {
    // Force token expiration to simulate simultaneous wake-up
    const state = tokenManager.getState()!;
    state.expires_at = 0; // Expired!

    const previousRefreshCount = upstreams.refreshCount;

    // Send 5 concurrent requests
    const promises = Array.from({ length: 5 }).map((_, idx) =>
      fetch(`${proxyUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: `Concurrent query ${idx}` }],
          stream: false
        })
      }).then((r) => r.json())
    );

    const results = await Promise.all(promises);

    for (const r of results) {
      assert.equal(r.object, 'chat.completion');
      assert.equal(r.choices[0].message.content, 'Hello from RelationFlow upstream backend!');
    }

    // Exactly one refresh should have taken place due to in-flight promise locking
    assert.equal(
      upstreams.refreshCount,
      previousRefreshCount + 1,
      'Concurrent requests must trigger exactly ONE token refresh'
    );
  });

  await t.test('5. [Model Mapping] Translates gpt-6-astra to RelationFlow target model', async () => {
    const res = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-6-astra',
        messages: [{ role: 'user', content: 'Testing astra remapping' }],
        stream: false
      })
    });

    assert.equal(res.status, 200);
    const lastUpstreamCall = upstreams.relationFlowHistory[upstreams.relationFlowHistory.length - 1];
    assert.equal(
      lastUpstreamCall.body.model,
      'managed:claude-opus-5.5',
      'Should remap gpt-6-astra to configured DEFAULT_MODEL (managed:claude-opus-5.5)'
    );
  });
});
