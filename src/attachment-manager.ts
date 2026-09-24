import crypto from 'node:crypto';
import type { TokenManager } from './token-manager.ts';

function E(e: ArrayBuffer | Uint8Array): Uint8Array {
  return new Uint8Array(e);
}

async function D(keyBytes: Uint8Array): Promise<crypto.webcrypto.CryptoKey> {
  return crypto.subtle.importKey('raw', E(keyBytes), 'AES-GCM', false, ['encrypt']);
}

async function L(
  cryptoKey: crypto.webcrypto.CryptoKey,
  context: { accountId: string; threadId: string; attachmentId: string },
  frameSize: number,
  frameIndex: number,
  isLastFrame: boolean,
  plaintextBytes: Uint8Array
): Promise<Uint8Array> {
  const iv = new Uint8Array(12);
  const ivView = new DataView(iv.buffer);
  ivView.setBigUint64(4, BigInt(frameIndex), false);

  const l = new Uint8Array(11);
  const o = new DataView(l.buffer);
  o.setUint32(1, frameIndex, false);
  l[5] = isLastFrame ? 1 : 0;
  l[6] = 2;
  o.setUint32(7, frameSize, false);

  const aadText = `${context.accountId}|chat_attachment_frame|${context.threadId}|${context.attachmentId}`;
  const aadBytes = new TextEncoder().encode(aadText);

  const fullAad = new Uint8Array(aadBytes.byteLength + l.byteLength);
  fullAad.set(aadBytes, 0);
  fullAad.set(l, aadBytes.byteLength);

  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: fullAad, tagLength: 128 },
    cryptoKey,
    E(plaintextBytes)
  );

  return new Uint8Array(encryptedBuffer);
}

async function encryptAttachment(
  fileBuffer: Buffer,
  context: { accountId: string; threadId: string; attachmentId: string },
  cryptoMeta: { frameSize: number; header: Buffer; objectKey: Buffer }
): Promise<Buffer> {
  const { frameSize, header, objectKey } = cryptoMeta;
  const nKey = await D(new Uint8Array(objectKey));
  const totalFrames = Math.max(1, Math.ceil(fileBuffer.length / frameSize));

  const chunks: Buffer[] = [header];
  for (let r = 0; r < totalFrames; r++) {
    const start = r * frameSize;
    const end = Math.min(start + frameSize, fileBuffer.length);
    const slice = fileBuffer.subarray(start, end);
    const encryptedFrame = await L(nKey, context, frameSize, r, r === totalFrames - 1, slice);
    chunks.push(Buffer.from(encryptedFrame));
  }
  return Buffer.concat(chunks);
}

export interface AttachmentUploadOptions {
  content: string | Buffer;
  fileName?: string;
  mimeType?: string;
  threadId: string;
  accountSlug: string;
  relationFlowUrl: string;
  tokenManager: TokenManager;
}

export async function uploadAttachment(options: AttachmentUploadOptions): Promise<any[]> {
  const {
    content,
    fileName = 'context.txt',
    mimeType = 'text/plain',
    threadId,
    accountSlug,
    relationFlowUrl,
    tokenManager
  } = options;

  const fileBuffer = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
  const tokenState = await tokenManager.getValidToken();

  // 1. Request capability
  const capUrl = `${relationFlowUrl.replace(/\/+$/, '')}/api/chat/attachments/capability`;
  const capRes = await fetch(capUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cookie': tokenState.session_cookie || '',
      'origin': relationFlowUrl,
      'user-agent': 'Mozilla/5.0'
    },
    body: JSON.stringify({
      accountSlug,
      threadId,
      files: [{ fileName, mimeType, sizeBytes: fileBuffer.length }]
    })
  });

  if (!capRes.ok) {
    const errText = await capRes.text();
    throw new Error(`Attachments capability failed (${capRes.status}): ${errText}`);
  }

  const capData = (await capRes.json()) as any;
  const cap = capData.capabilities?.[0];
  if (!cap) {
    throw new Error('No attachment capabilities returned by RelationFlow');
  }

  // 2. Encrypt
  const accountId = cap.path.split('/')[0];
  const encryptedPayload = await encryptAttachment(
    fileBuffer,
    {
      accountId,
      threadId,
      attachmentId: cap.attachmentId
    },
    {
      header: Buffer.from(cap.header, 'base64'),
      objectKey: Buffer.from(cap.objectKey, 'base64'),
      frameSize: cap.frameSize
    }
  );

  // 3. Upload to Supabase Storage
  const storageUrl = `https://pilvfwfeidqfxfhmevtd.supabase.co/storage/v1/object/${cap.bucketId}/${cap.path}`;
  const uploadRes = await fetch(storageUrl, {
    method: 'POST',
    headers: {
      'apikey': 'sb_publishable_tHnRZvqCh23wsocWynthJg_5bQVoFsA',
      'Authorization': `Bearer ${tokenState.access_token}`,
      'Content-Type': cap.contentType,
      'x-upsert': 'false'
    },
    body: encryptedPayload
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    throw new Error(`Storage upload failed (${uploadRes.status}): ${errText}`);
  }

  // 4. Commit attachment
  const commitUrl = `${relationFlowUrl.replace(/\/+$/, '')}/api/chat/attachments/commit`;
  const commitRes = await fetch(commitUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cookie': tokenState.session_cookie || '',
      'origin': relationFlowUrl,
      'user-agent': 'Mozilla/5.0'
    },
    body: JSON.stringify({
      accountSlug,
      attachmentIds: [cap.attachmentId]
    })
  });

  if (!commitRes.ok) {
    const errText = await commitRes.text();
    throw new Error(`Attachment commit failed (${commitRes.status}): ${errText}`);
  }

  const commitData = (await commitRes.json()) as any;
  return commitData.attachments || [];
}
