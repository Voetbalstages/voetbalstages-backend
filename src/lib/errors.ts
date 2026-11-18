import type { ContentfulStatusCode } from 'hono/utils/http-status'

export class ApiError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message?: string
  ) {
    super(message ?? code)
  }
}

export const badRequest = (code: string, message?: string) => new ApiError(400, code, message)
export const unauthorized = () => new ApiError(401, 'UNAUTHENTICATED', 'Login required')
export const notFound = (what = 'Resource') => new ApiError(404, 'NOT_FOUND', `${what} not found`)
export const conflict = (code: string, message?: string) => new ApiError(409, code, message)
export const tooManyRequests = () => new ApiError(429, 'RATE_LIMITED', 'Too many requests')
export const badGateway = (code: string, message?: string) => new ApiError(502, code, message)
