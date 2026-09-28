declare module "cos-nodejs-sdk-v5" {
  interface CosOptions { SecretId: string; SecretKey: string; }
  interface BaseParams { Bucket: string; Region: string; }
  interface ObjectItem { Key?: string; Size?: string; LastModified?: string; ETag?: string; }
  interface BucketResult { Contents?: ObjectItem[]; IsTruncated?: string | boolean; NextMarker?: string; }
  type Callback<T> = (error: Error | null, data: T) => void;

  export default class COS {
    constructor(options: CosOptions);
    getBucket(params: BaseParams & { Prefix: string; Marker?: string; MaxKeys?: number }, callback: Callback<BucketResult>): void;
    putObject(params: BaseParams & { Key: string; Body: Buffer; ContentLength: number; ContentType: string }, callback: Callback<Record<string, unknown>>): void;
    deleteObject(params: BaseParams & { Key: string }, callback: Callback<Record<string, unknown>>): void;
  }
}
