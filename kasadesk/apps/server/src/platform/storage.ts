import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from './config.ts';

/** Object storage for media. Keys always start with the business id. */
export interface ObjectStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
}

export class LocalStorage implements ObjectStorage {
  constructor(private readonly root: string) {}
  private resolve(key: string) {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(path.resolve(this.root) + path.sep)) throw new Error('invalid storage key');
    return p;
  }
  async put(key: string, body: Buffer): Promise<void> {
    const p = this.resolve(key);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, body);
  }
  get(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }
}

/** AWS S3 or any S3-compatible store (Cloudflare R2, MinIO). Loaded lazily so local dev needs no AWS SDK setup. */
export class S3Storage implements ObjectStorage {
  private client: Promise<import('@aws-sdk/client-s3').S3Client>;
  constructor(private readonly c: Config) {
    this.client = import('@aws-sdk/client-s3').then(
      ({ S3Client }) =>
        new S3Client({
          region: c.S3_REGION,
          ...(c.S3_ENDPOINT && { endpoint: c.S3_ENDPOINT }),
          credentials: { accessKeyId: c.S3_ACCESS_KEY_ID, secretAccessKey: c.S3_SECRET_ACCESS_KEY },
        }),
    );
  }
  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await (await this.client).send(new PutObjectCommand({ Bucket: this.c.S3_BUCKET, Key: key, Body: body, ContentType: contentType }));
  }
  async get(key: string): Promise<Buffer> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const r = await (await this.client).send(new GetObjectCommand({ Bucket: this.c.S3_BUCKET, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
}

export function createStorage(c: Config): ObjectStorage {
  return c.STORAGE_DRIVER === 's3' ? new S3Storage(c) : new LocalStorage(c.STORAGE_LOCAL_DIR);
}
