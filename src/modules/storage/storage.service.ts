import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  PutBucketLifecycleConfigurationCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';
import * as fs from 'node:fs';

export interface LifecycleRule {
  id: string;
  prefix: string;
  expirationDays: number;
}

@Injectable()
export class StorageService {
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly presignExpiresSec: number;

  constructor(private readonly config: ConfigService) {
    const endpoint = this.config.get<string>(
      'S3_ENDPOINT',
      'http://localhost:9000',
    );
    const region = this.config.get<string>('S3_REGION', 'eu-central-1');
    const accessKeyId = this.config.get<string>('S3_ACCESS_KEY', 'minioadmin');
    const secretAccessKey = this.config.get<string>(
      'S3_SECRET_KEY',
      'minioadmin',
    );
    const forcePathStyle =
      this.config.get<string>('S3_FORCE_PATH_STYLE', 'true') === 'true';

    this.bucket = this.config.get<string>('S3_BUCKET', 'renderer');
    this.presignExpiresSec = Number(
      this.config.get<string>('S3_PRESIGN_EXPIRES_SECONDS', '1800'),
    );

    this.s3 = new S3Client({
      region,
      endpoint,
      forcePathStyle,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  async ensureBucketExists() {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  /**
   * Устанавливает lifecycle rules на бакете.
   */
  async putBucketLifecycle(rules: LifecycleRule[]): Promise<void> {
    await this.s3.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: this.bucket,
        LifecycleConfiguration: {
          Rules: rules.map((r) => ({
            ID: r.id,
            Status: 'Enabled',
            Filter: { Prefix: r.prefix },
            Expiration: { Days: r.expirationDays },
          })),
        },
      }),
    );
  }

  /**
   * Перечислить все объекты в бакете с указанным префиксом.
   * Обходит пагинацию автоматически (до 10 000 ключей).
   */
  async listObjects(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const res = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          MaxKeys: 1000,
          ...(continuationToken
            ? { ContinuationToken: continuationToken }
            : {}),
        }),
      );

      for (const obj of res.Contents ?? []) {
        if (obj.Key) keys.push(obj.Key);
      }

      continuationToken = res.IsTruncated
        ? res.NextContinuationToken
        : undefined;
    } while (continuationToken);

    return keys;
  }

  async uploadStream(
    key: string,
    body: Readable,
    contentType = 'application/octet-stream',
    contentLength?: number,
  ) {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ...(typeof contentLength === 'number'
          ? { ContentLength: contentLength }
          : {}),
      }),
    );
    return { bucket: this.bucket, key };
  }

  async uploadFile(
    key: string,
    filePath: string,
    contentType = 'application/octet-stream',
  ) {
    const stream = fs.createReadStream(filePath);
    try {
      return await this.uploadStream(key, stream, contentType);
    } catch (e) {
      stream.destroy();
      throw e;
    }
  }

  async downloadToFile(key: string, filePath: string) {
    const res = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const body = res.Body;
    if (!body || typeof (body as any).pipe !== 'function') {
      throw new Error('S3 GetObject returned empty body');
    }
    await new Promise<void>((resolve, reject) => {
      const src = body as Readable;
      const out = fs.createWriteStream(filePath);
      src.on('error', (err) => {
        out.destroy();
        reject(err);
      });
      out.on('error', (err) => {
        src.destroy();
        reject(err);
      });
      out.on('finish', () => resolve());
      src.pipe(out);
    });
  }

  async presignGetUrl(key: string, expiresSec = this.presignExpiresSec) {
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expiresSec },
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.s3.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}
