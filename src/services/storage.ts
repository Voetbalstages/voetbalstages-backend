import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { env } from '../env.js'
import { badGateway } from '../lib/errors.js'

/** Same bucket and key scheme as the old backend's uploadFile. */
export const BUCKET = 'voetbalstages'
export const REGION = 'eu-central-1'
export const PUBLIC_BASE = `https://${BUCKET}.s3.${REGION}.amazonaws.com/`

export interface StorageGateway {
  put(key: string, body: Buffer, contentType: string): Promise<void>
}

let client: S3Client | null = null
const s3Gateway: StorageGateway = {
  async put(key, body, contentType) {
    if (!env.AWS_S3_USER_KEY || !env.AWS_S3_USER_SECRET) {
      throw badGateway('UPLOAD_NOT_CONFIGURED', 'AWS_S3_USER_KEY / AWS_S3_USER_SECRET are not set')
    }
    client ??= new S3Client({
      region: REGION,
      credentials: { accessKeyId: env.AWS_S3_USER_KEY, secretAccessKey: env.AWS_S3_USER_SECRET }
    })
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: body,
          ACL: 'public-read',
          ContentType: contentType,
          CacheControl: 'max-age=86400'
        })
      )
    } catch {
      throw badGateway('UPLOAD_FAILED', 'Could not store the file')
    }
  }
}

let gateway = s3Gateway
export const storage = () => gateway
export const setStorageGateway = (g: StorageGateway) => (gateway = g)
