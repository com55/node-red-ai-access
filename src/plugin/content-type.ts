/**
 * Require JSON Content-Type on REST/MCP write routes (415 otherwise).
 */

import type { NextFunction, Request, Response } from 'express';

import { buildChannelError, type ErrorChannel } from './channel-errors.js';

function isJsonContentType(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const mime = value.split(';')[0]?.trim().toLowerCase() ?? '';
  return mime === 'application/json' || mime.endsWith('+json');
}

function hasRequestBody(req: Request): boolean {
  const lengthHeader = req.headers['content-length'];
  if (typeof lengthHeader === 'string' && lengthHeader.length > 0) {
    const n = Number(lengthHeader);
    if (Number.isFinite(n) && n > 0) {
      return true;
    }
    if (n === 0) {
      return false;
    }
  }
  return req.headers['transfer-encoding'] !== undefined;
}

/**
 * Reject non-JSON Content-Type with 415.
 * Empty bodies with no Content-Type (e.g. bare POST approve) are allowed;
 * any declared non-JSON type, or a body without JSON type, is rejected.
 */
export function requireJsonContentType(channel: ErrorChannel = 'rest') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const contentType = req.headers['content-type'];
    if (isJsonContentType(contentType)) {
      next();
      return;
    }
    if (!contentType && !hasRequestBody(req)) {
      next();
      return;
    }
    const mapped = buildChannelError(channel, 'unsupported_media_type', { statusCode: 415 });
    res.status(mapped.statusCode).json(mapped.body);
  };
}

const TEXT_PLAIN = 'text/plain; charset=utf-8';
const TEXT_HTML = 'text/html; charset=utf-8';

/** CSP for GET-link HTML: no scripts, styles, forms, frames, or external loads. */
export const GET_LINK_HTML_CSP =
  "default-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'";

/** Representation chosen for a GET-link response. */
export type GetLinkRepresentation = 'html' | 'native' | 'plain';

function formatParam(req: Request): string | undefined {
  const value = req.query?.format;
  return typeof value === 'string' ? value.toLowerCase() : undefined;
}

/**
 * Pick the representation for a GET-link response:
 * - `?format=md` / `?format=json` → native (the route's real type).
 * - `Accept` preferring `application/json` or `text/markdown` → native.
 * - `Accept` preferring `text/plain` → the same body as `text/plain`.
 * - Otherwise (no Accept, wildcards, browser-style lists, `text/html`) → HTML,
 *   because some AI web fetchers only read `text/html`.
 */
export function chooseGetLinkRepresentation(req: Request): GetLinkRepresentation {
  const format = formatParam(req);
  if (format === 'md' || format === 'json') return 'native';
  if (!req.get('accept')) return 'html';
  const picked = req.accepts(['text/html', 'application/json', 'text/markdown', 'text/plain']);
  if (picked === 'application/json' || picked === 'text/markdown') return 'native';
  if (picked === 'text/plain') return 'plain';
  return 'html';
}

/** Escape `& < > " '` for HTML text and attribute contexts. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Relative links in already-escaped text: `./` + safe path chars, optional
 * `?query` of safe chars, at a word boundary. The match only contains
 * `[A-Za-z0-9._~\-/?=&%]`, so it is safe as an href as-is.
 */
export const RELATIVE_LINK_RE =
  /(?<![A-Za-z0-9_.~\-/])\.\/[A-Za-z0-9._~\-/]+(?:\?[A-Za-z0-9._~\-=&%]+)?/g;

/** Wrap safe relative links (no `..` segments) in anchors. Input must be escaped. */
export function linkifyEscaped(escaped: string): string {
  return escaped.replace(RELATIVE_LINK_RE, match => {
    // Drop trailing sentence punctuation from the link.
    const link = match.replace(/[.]+$/, '');
    const rest = match.slice(link.length);
    if (link.length <= 2 || link.includes('..') || link.includes('//') || link.includes('&')) {
      return match;
    }
    return `<a href="${link}">${link}</a>${rest}`;
  });
}

/** Minimal standalone HTML document with the text in one escaped `<pre>`. */
export function renderGetLinkHtml(text: string, baseHref?: string): string {
  const base = baseHref ? `<base href="${escapeHtml(baseHref)}">` : '';
  return (
    '<!doctype html>\n<html><head><meta charset="utf-8">' +
    base +
    '<title>Node-RED AI Access</title></head><body><pre>' +
    linkifyEscaped(escapeHtml(text)) +
    '</pre></body></html>\n'
  );
}

/** `/…/mcp/a/<token>/` base path from the original URL (safe token chars only). */
export function getLinkBaseHref(originalUrl: string): string | undefined {
  const path = originalUrl.split('?')[0] ?? '';
  const m = /^(.*?\/mcp\/a\/[A-Za-z0-9_-]+)(?:\/|$)/.exec(path);
  if (!m?.[1] || !/^[A-Za-z0-9._~\-/]*$/.test(m[1])) return undefined;
  return `${m[1]}/`;
}

function prettyJson(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

/**
 * GET-link channel middleware (`/mcp/a/*`). Adds hardening headers and
 * `Vary: Accept`, then re-represents markdown / JSON bodies per
 * {@link chooseGetLinkRepresentation}. Status codes and body data are unchanged.
 */
export function getLinkContentNegotiation() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const representation = chooseGetLinkRepresentation(req);
    // Capture before handlers redact the token from req.url.
    const baseHref = getLinkBaseHref(req.originalUrl);
    res.vary('Accept');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const originalSend = res.send.bind(res);
    res.send = ((body?: unknown) => {
      const type = String(res.getHeader('Content-Type') ?? '').toLowerCase();
      const isJson = type.startsWith('application/json');
      const isMarkdown = type.startsWith('text/markdown');
      if (representation === 'native' || (!isJson && !isMarkdown) || res.headersSent) {
        return originalSend(body);
      }
      const text =
        typeof body === 'string' ? body : Buffer.isBuffer(body) ? body.toString('utf8') : undefined;
      if (text === undefined) return originalSend(body);
      if (representation === 'plain') {
        res.setHeader('Content-Type', TEXT_PLAIN);
        return originalSend(text);
      }
      res.setHeader('Content-Type', TEXT_HTML);
      res.setHeader('Content-Security-Policy', GET_LINK_HTML_CSP);
      return originalSend(renderGetLinkHtml(isJson ? prettyJson(text) : text, baseHref));
    }) as Response['send'];
    next();
  };
}
