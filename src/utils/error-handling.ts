/**
 * Comprehensive error handling utilities
 */

import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

import { ApiResponse, LogEntry } from '../types/mcp-extensions.js';

/** Express request with an optional request-correlation id. */
export interface RequestWithId extends Request {
  requestId?: string;
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;
  public readonly timestamp: string;
  public requestId?: string;

  constructor(message: string, statusCode = 500, code = 'INTERNAL_ERROR', isOperational = true) {
    super(message);

    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
    this.timestamp = new Date().toISOString();

    Error.captureStackTrace(this, this.constructor);
  }

  setRequestId(requestId: string): this {
    this.requestId = requestId;
    return this;
  }
}

export class ValidationError extends AppError {
  public readonly field?: string | undefined;
  public readonly value?: unknown;

  constructor(message: string, field?: string, value?: unknown) {
    super(message, 400, 'VALIDATION_ERROR');
    this.field = field ?? undefined;
    this.value = value;
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    const message = id ? `${resource} with id '${id}' not found` : `${resource} not found`;
    super(message, 404, 'NOT_FOUND');
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Authentication failed') {
    super(message, 401, 'AUTHENTICATION_ERROR');
  }
}

export class AuthorizationError extends AppError {
  constructor(action: string, resource = 'resource') {
    super(`Not authorized to ${action} ${resource}`, 403, 'AUTHORIZATION_ERROR');
  }
}

export class NodeRedError extends AppError {
  public readonly nodeRedStatusCode?: number | undefined;
  public readonly nodeRedResponse?: unknown;

  constructor(
    message: string,
    statusCode = 500,
    nodeRedStatusCode?: number,
    nodeRedResponse?: unknown
  ) {
    super(message, statusCode, 'NODERED_ERROR');
    this.nodeRedStatusCode = nodeRedStatusCode ?? undefined;
    this.nodeRedResponse = nodeRedResponse;
  }
}

export class SSEError extends AppError {
  public readonly connectionId?: string | undefined;

  constructor(message: string, connectionId?: string) {
    super(message, 500, 'SSE_ERROR');
    this.connectionId = connectionId ?? undefined;
  }
}

export class RateLimitError extends AppError {
  public readonly retryAfter: number;

  constructor(retryAfter = 60) {
    super('Rate limit exceeded', 429, 'RATE_LIMIT_ERROR');
    this.retryAfter = retryAfter;
  }
}

/**
 * Create standardized error response
 */
export function createErrorResponse<T = never>(
  error: AppError | Error,
  requestId?: string
): ApiResponse<T> {
  const timestamp = new Date().toISOString();

  if (error instanceof AppError) {
    return {
      success: false,
      error: {
        code: error.code,
        message: error.message,
        details:
          process.env.NODE_ENV === 'development'
            ? {
                stack: error.stack,
                ...(error instanceof NodeRedError && {
                  nodeRedStatusCode: error.nodeRedStatusCode,
                  nodeRedResponse: error.nodeRedResponse,
                }),
                ...(error instanceof ValidationError && {
                  field: error.field,
                  value: error.value,
                }),
                ...(error instanceof SSEError && {
                  connectionId: error.connectionId,
                }),
              }
            : undefined,
      },
      timestamp,
      requestId: requestId ?? error.requestId ?? undefined,
    };
  }

  // Handle unexpected errors
  return {
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message:
        process.env.NODE_ENV === 'development' ? error.message : 'An unexpected error occurred',
      details:
        process.env.NODE_ENV === 'development'
          ? {
              stack: error.stack,
            }
          : undefined,
    },
    timestamp,
    requestId: requestId ?? undefined,
  };
}

/**
 * Express error handling middleware
 */
export function errorHandler(error: Error, req: Request, res: Response, _next: NextFunction): void {
  const requestId = (req as RequestWithId).requestId ?? uuidv4();

  // Log the error
  logError(error, {
    requestId,
    method: req.method,
    url: req.url,
    userAgent: req.get('User-Agent'),
    ip: req.ip,
  });

  // Handle specific error types
  if (error instanceof AppError) {
    const response = createErrorResponse(error, requestId);

    // Add rate limit headers for rate limit errors
    if (error instanceof RateLimitError) {
      res.set('Retry-After', error.retryAfter.toString());
    }

    res.status(error.statusCode).json(response);
    return;
  }

  // Handle unexpected errors
  const response = createErrorResponse(error, requestId);
  res.status(500).json(response);
}

/**
 * Async error wrapper for Express handlers.
 * Returns the settled promise so callers/tests can await microtask completion;
 * Express itself ignores the return value.
 */
export function asyncHandler<T extends unknown[]>(
  fn: (req: Request, res: Response, next: NextFunction, ...args: T) => Promise<unknown> | void
) {
  return (req: Request, res: Response, next: NextFunction, ...args: T): Promise<unknown> => {
    return Promise.resolve(fn(req, res, next, ...args)).catch(next);
  };
}

const RESPONSE_PREVIEW_LIMIT = 500;

/**
 * Axios-like error shape used by real Axios errors and by tests that pass
 * plain `{ response }` / `{ request }` objects. Prefer duck-typing over
 * `axios.isAxiosError` so mock errors keep the same message paths.
 */
interface AxiosLikeError {
  message?: string;
  code?: string;
  config?: { url?: string; method?: string };
  response?: {
    status: number;
    statusText?: string;
    data?: unknown;
    headers?: Record<string, unknown>;
  };
  request?: unknown;
}

function asAxiosLike(error: unknown): AxiosLikeError | null {
  if (error === null || typeof error !== 'object') {
    return null;
  }
  // Real Axios errors and plain mock `{ response }` / `{ request }` objects.
  return error;
}

function headerContentType(headers: Record<string, unknown> | undefined): string {
  const raw = headers?.['content-type'];
  return typeof raw === 'string' ? raw : '';
}

/**
 * Describe the request an Axios error came from, e.g. `GET /flows`.
 * Returns undefined when the error carries no request config.
 */
function describeRequest(error: unknown): string | undefined {
  const axiosLike = asAxiosLike(error);
  const config = axiosLike?.config;
  if (!config?.url) return undefined;
  const methodName = config.method && config.method.length > 0 ? config.method : 'get';
  return `${methodName.toUpperCase()} ${config.url}`;
}

/**
 * Map an Axios-like response error into a NodeRedError and throw.
 */
function throwFromAxiosResponse(
  axiosLike: AxiosLikeError & { response: NonNullable<AxiosLikeError['response']> },
  context: string,
  requestSuffix: string,
  request: string | undefined
): never {
  const { status, statusText } = axiosLike.response;
  const data: unknown = axiosLike.response.data;
  const contentType = headerContentType(axiosLike.response.headers);

  if (axiosLike.message?.includes('Unexpected token') && contentType.includes('text/html')) {
    throw new NodeRedError(
      `Node-RED returned HTML instead of JSON in ${context}${requestSuffix} (HTTP ${status}). This usually indicates an authentication redirect or configuration issue. Check your Node-RED admin settings and authentication.`,
      502,
      status,
      {
        originalError: axiosLike.message,
        contentType,
        request,
        responsePreview:
          typeof data === 'string' ? data.substring(0, RESPONSE_PREVIEW_LIMIT) : data,
      }
    );
  }

  const detail = summarizeResponseBody(data);
  const statusLabel = statusText ? `HTTP ${status} ${statusText}` : `HTTP ${status}`;

  if (status === 409) {
    throw new NodeRedError(
      `Node-RED API conflict in ${context}${requestSuffix}: ${statusLabel}${
        detail ? ` — ${detail}` : ''
      }. The flow revision (rev) is out of date — re-read flows and retry.`,
      409,
      status,
      data
    );
  }

  throw new NodeRedError(
    `Node-RED API error in ${context}${requestSuffix}: ${statusLabel}${
      detail ? ` — ${detail}` : ' (no response body)'
    }`,
    status >= 500 ? 502 : status,
    status,
    data
  );
}

/**
 * Summarise an upstream response body for an error message. Node-RED is not
 * consistent about the shape here: some endpoints return `{message}`, some
 * `{error}`, some a bare string, some nothing at all. Falling straight through
 * to "Unknown error" hid all of it, so keep whatever is actually there.
 */
function summarizeResponseBody(data: unknown): string | undefined {
  if (data === undefined || data === null || data === '') return undefined;

  if (typeof data === 'string') {
    const trimmed = data.trim();
    return trimmed ? trimmed.slice(0, RESPONSE_PREVIEW_LIMIT) : undefined;
  }

  if (typeof data === 'object') {
    const body = data as Record<string, unknown>;
    // Prefer a meaningful message, but Node-RED often returns
    // `{ code: "version_mismatch", message: "Error" }` — skip the generic
    // "Error" string so the machine-readable code surfaces instead.
    const candidates = [body.message, body.error_description, body.error, body.code];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      const trimmed = candidate.trim();
      if (!trimmed) continue;
      if (/^error$/i.test(trimmed) && typeof body.code === 'string' && body.code.trim()) {
        continue;
      }
      return trimmed;
    }
    return safeStringify(body).slice(0, RESPONSE_PREVIEW_LIMIT);
  }

  if (typeof data === 'number' || typeof data === 'boolean' || typeof data === 'bigint') {
    return String(data);
  }

  return undefined;
}

function errorMessage(error: unknown, axiosLike: AxiosLikeError | null): string {
  if (error instanceof Error) return error.message;
  if (typeof axiosLike?.message === 'string') return axiosLike.message;
  return String(error);
}

/**
 * Handle Node-RED API errors
 */
export function handleNodeRedError(error: unknown, context: string): never {
  const request = describeRequest(error);
  const requestSuffix = request ? ` [${request}]` : '';
  const axiosLike = asAxiosLike(error);

  if (axiosLike?.response) {
    throwFromAxiosResponse(
      axiosLike as AxiosLikeError & { response: NonNullable<AxiosLikeError['response']> },
      context,
      requestSuffix,
      request
    );
  }

  if (axiosLike?.request) {
    const code = axiosLike.code ? ` (${axiosLike.code})` : '';
    throw new NodeRedError(
      `Failed to connect to Node-RED in ${context}${requestSuffix}: ${axiosLike.message}${code}`,
      503
    );
  }

  const message = errorMessage(error, axiosLike);
  if (message.includes('Node-RED returned HTML')) {
    throw new NodeRedError(`${message} (Context: ${context})`, 502);
  }

  throw new NodeRedError(`Error in ${context}${requestSuffix}: ${message}`, 500);
}

/**
 * Validate required fields
 */
export function validateRequired(data: Record<string, unknown>, requiredFields: string[]): void {
  for (const field of requiredFields) {
    if (data[field] === undefined || data[field] === null || data[field] === '') {
      throw new ValidationError(`Field '${field}' is required`, field, data[field]);
    }
  }
}

/**
 * Validate field types
 */
export function validateTypes(
  data: Record<string, unknown>,
  fieldTypes: Record<string, string>
): void {
  for (const [field, expectedType] of Object.entries(fieldTypes)) {
    if (data[field] !== undefined) {
      const actualType = typeof data[field];
      if (actualType !== expectedType) {
        throw new ValidationError(
          `Field '${field}' must be of type ${expectedType}, got ${actualType}`,
          field,
          data[field]
        );
      }
    }
  }
}

/**
 * Whether `LOG_LEVEL=debug` was requested.
 */
export function isDebugLoggingEnabled(): boolean {
  return process.env.LOG_LEVEL?.trim().toLowerCase() === 'debug';
}

/**
 * Emit a debug line when `LOG_LEVEL=debug`.
 *
 * Writes to stderr, never stdout: stdout carries the JSON-RPC stream under the
 * stdio transport and any stray write there corrupts it.
 */
export function logDebug(message: string, context?: Record<string, unknown>): void {
  if (!isDebugLoggingEnabled()) return;

  process.stderr.write(
    `${safeStringify({
      level: 'debug',
      timestamp: new Date().toISOString(),
      message,
      ...(context ? { context } : {}),
    })}\n`
  );
}

/**
 * Log error with context
 */
export function logError(error: Error, context?: Record<string, unknown>): void {
  const logEntry: LogEntry = {
    level: 'error',
    message: error.message,
    timestamp: new Date().toISOString(),
    source: 'error-handler',
    error,
    context: context ?? undefined,
  };

  if (process.env.NODE_ENV === 'development') {
    console.error('Error:', {
      ...logEntry,
      stack: error.stack,
    });
  } else {
    // In production, use structured logging
    console.error(JSON.stringify(logEntry));
  }
}

/**
 * Create request ID middleware
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = uuidv4();
  (req as RequestWithId).requestId = requestId;
  res.set('X-Request-ID', requestId);
  next();
}

/**
 * Sanitize error for client response
 */
export function sanitizeError(error: unknown): {
  code: string;
  message: string;
  statusCode: number;
} {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.message,
      statusCode: error.statusCode,
    };
  }

  return {
    code: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred',
    statusCode: 500,
  };
}

/**
 * Check if error is operational (expected) or programming error
 */
export function isOperationalError(error: Error): boolean {
  if (error instanceof AppError) {
    return error.isOperational;
  }
  return false;
}

/**
 * Safe JSON stringify that handles circular references and errors
 */
export function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(
      obj,
      (_key, value: unknown) => {
        if (value instanceof Error) {
          return {
            name: value.name,
            message: value.message,
            stack: value.stack,
          };
        }
        return value;
      },
      2
    );
  } catch {
    return '[Unable to stringify object]';
  }
}
