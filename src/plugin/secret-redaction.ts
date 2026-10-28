/**
 * Redact likely secrets from flow data before it reaches AI clients.
 *
 * Two detectors run on every AI-facing flow read:
 * 1. Name-based: env entries (`{ name, value, type }` on tabs, groups, subflows,
 *    subflow instances, global-config, …), node config keys, and name/value pairs
 *    inside nested config (change rules, inject props, http headers) whose name
 *    matches a secret-like pattern have their value replaced with `[REDACTED]`.
 * 2. Content-based: every other string field (function `func` / `initialize` /
 *    `finalize`, templates, URLs, JSON payloads, …) is scanned for known token
 *    formats and `name = "literal"` assignments; only the secret literal is
 *    replaced so code stays readable.
 *
 * Redacted entities carry `_aiRedactions: string[]` (field paths); redacted env
 * entries carry `redacted: true`. {@link restoreRedactedPlaceholders} reverses
 * this for proposals so an AI edit that keeps `[REDACTED]` never overwrites the
 * stored secret with the placeholder.
 *
 * Node-RED credentials (and env entries of type `cred`) are never part of the
 * flows API output and are left untouched.
 */

import type { FlowAdapter, FlowNode, FlowSnapshot, FlowTab } from '../runtime/types.js';
import type { Proposal } from '../storage/proposals.js';

import {
  DEFAULT_SECRET_NAME_PATTERNS,
  REDACTED_PLACEHOLDER,
  tokenizeName,
} from './secret-patterns.js';
import { getSettingsStore } from './settings.js';

export {
  DEFAULT_SECRET_NAME_PATTERNS,
  MAX_SECRET_NAME_PATTERNS,
  normalizeSecretNamePatterns,
  REDACTED_PLACEHOLDER,
  SECRET_NAME_PATTERN_RE,
  tokenizeName,
} from './secret-patterns.js';

export const AI_REDACTIONS_KEY = '_aiRedactions';

/**
 * A name whose LAST word is one of these describes a secret rather than holding
 * one (`TOKEN_URL`, `AUTH_TYPE`, `SESSION_TIMEOUT`, `keyType`), so it is skipped.
 */
const DESCRIPTOR_SUFFIXES = new Set([
  'TYPE',
  'TYPES',
  'MODE',
  'METHOD',
  'FIELD',
  'FIELDS',
  'PROP',
  'PROPERTY',
  'FORMAT',
  'TIMEOUT',
  'EXPIRY',
  'EXPIRES',
  'TTL',
  'LENGTH',
  'LEN',
  'SIZE',
  'COUNT',
  'ENABLED',
  'DISABLED',
  'ENABLE',
  'USE',
  'URL',
  'URI',
  'ENDPOINT',
  'HOST',
  'PORT',
  'PATH',
  'HEADER',
  'NAME',
  'LABEL',
  'FILE',
]);

/** Values that are configuration enums, not secrets (case-insensitive). */
const NON_SECRET_VALUES = new Set([
  'basic',
  'digest',
  'bearer',
  'none',
  'true',
  'false',
  'null',
  'undefined',
  'oauth',
  'oauth2',
  'jwt',
  'apikey',
  'api_key',
  'token',
  'password',
  'header',
  'query',
  'body',
  'cookie',
  'msg',
  'flow',
  'global',
  'env',
  'str',
  'num',
  'json',
  'bool',
  'other',
]);

/** Typed-input types whose value is a reference/expression, not a literal. */
const REFERENCE_TYPES = new Set([
  'env',
  'msg',
  'flow',
  'global',
  'jsonata',
  'bool',
  'date',
  'node',
  'cred',
]);

/** Node keys never redacted or scanned (identity, layout, wiring). */
const STRUCTURAL_KEYS = new Set([
  'id',
  'type',
  'z',
  'g',
  'x',
  'y',
  'w',
  'h',
  'wires',
  'inputs',
  'outputs',
  'links',
  'scope',
  'icon',
  'color',
  'style',
  'd',
  'l',
  'in',
  'out',
  'rev',
]);

/** Free-text fields: content scan only, never key-name redaction. */
const SCAN_ONLY_KEYS = new Set(['name', 'label', 'info']);

/** JavaScript code fields: unquoted `name = value` is an expression, not a literal. */
const CODE_KEYS = new Set(['func', 'initialize', 'finalize']);

/** Fields larger than this are not scanned; AI sees the whole field as redacted. */
export const MAX_SCAN_FIELD_CHARS = 256 * 1024;

const CHILD_ENTITY_KEYS = new Set(['nodes', 'configs', 'subflows']);

/** Name/value keys in nested config objects (value key → type key). */
const PAIR_NAME_KEYS = ['name', 'p', 'keyValue', 'key', 'property', 'k'] as const;
const PAIR_VALUE_KEYS: Record<string, string | undefined> = {
  value: 'type',
  v: 'vt',
  to: 'tot',
  valueValue: 'valueType',
};

// ---------------------------------------------------------------------------
// Name matching

export interface SecretNameMatcher {
  readonly patterns: readonly string[];
  matches(name: string): boolean;
}

const matcherCache = new Map<string, SecretNameMatcher>();

export function createSecretNameMatcher(patterns: readonly string[]): SecretNameMatcher {
  const cacheKey = patterns.join('\u0000');
  const cached = matcherCache.get(cacheKey);
  if (cached) return cached;
  const joined = [...new Set(patterns.map(p => tokenizeName(p).join('')).filter(Boolean))];
  const matcher: SecretNameMatcher = {
    patterns: [...patterns],
    matches(name: string): boolean {
      if (typeof name !== 'string' || name.length === 0 || joined.length === 0) return false;
      const tokens = tokenizeName(name);
      const last = tokens[tokens.length - 1];
      if (!last || DESCRIPTOR_SUFFIXES.has(last)) return false;
      for (const pattern of joined) {
        const plural = `${pattern}S`;
        for (let i = 0; i < tokens.length; i++) {
          let acc = '';
          for (let j = i; j < tokens.length; j++) {
            acc += tokens[j];
            if (acc === pattern || acc === plural) return true;
            if (acc.length > plural.length) break;
          }
          // Glued names (`DBPASSWORD`, `myapikey`) for long, specific patterns only.
          const token = tokens[i] ?? '';
          if (pattern.length >= 6 && (token.endsWith(pattern) || token.endsWith(plural))) {
            return true;
          }
        }
      }
      return false;
    },
  };
  if (matcherCache.size > 32) matcherCache.clear();
  matcherCache.set(cacheKey, matcher);
  return matcher;
}

/** Patterns from the bound settings store (defaults when unbound). */
export function currentSecretNamePatterns(): readonly string[] {
  const effective = getSettingsStore()?.getEffective() as
    { secretNamePatterns?: string[] } | undefined;
  return effective?.secretNamePatterns ?? DEFAULT_SECRET_NAME_PATTERNS;
}

function isSecretLikeValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed === REDACTED_PLACEHOLDER) return false;
  if (NON_SECRET_VALUES.has(trimmed.toLowerCase())) return false;
  // `${ENV_VAR}` substitution is a reference, not the secret itself.
  if (/^\$\{[A-Za-z0-9_]+\}$/.test(trimmed)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Content scanning

interface Span {
  start: number;
  end: number;
}

interface ContentRule {
  re: RegExp;
  accept?: (secret: string, m: RegExpExecArray) => boolean;
}

const rulesCache = new WeakMap<SecretNameMatcher, ContentRule[]>();

/** Compiled rules per matcher (regexes are reset before each synchronous scan). */
function contentRules(matcher: SecretNameMatcher): ContentRule[] {
  let rules = rulesCache.get(matcher);
  if (!rules) {
    rules = buildContentRules(matcher);
    rulesCache.set(matcher, rules);
  }
  return rules;
}

function buildContentRules(matcher: SecretNameMatcher): ContentRule[] {
  const keyAccepts = (s: string, m: RegExpExecArray): boolean =>
    matcher.matches(m.groups?.k ?? '') && s.length >= 1 && isSecretLikeValue(s);
  return [
    // Buffer.from("user:pw") / btoa('user:pw') basic-auth literals.
    {
      re: /\b(?:Buffer\.from|btoa)\(\s*(?<q>["'`])[^"'`:\s]+:(?<s>[^"'`\s]+)\k<q>/dg,
      accept: s => !s.includes('${'),
    },
    // Connection strings: `Server=x;User Id=sa;Password=p@ss;` (2+ key=value pairs).
    {
      re: /(?<=^|[;"'`\s])(?<k>[A-Za-z][A-Za-z0-9 _-]{0,40}?)\s*=\s*(?<s>[^;"'`\r\n]+)(?=;[A-Za-z ]|;?["'`]|;?\s*$)/dgm,
      accept: (s, m) =>
        keyAccepts(s.trim(), m) && /[A-Za-z][\w ]*=[^;=\r\n]*;\s*[A-Za-z][\w ]*=/.test(m.input),
    },
    // PEM private key body (keeps BEGIN/END lines).
    {
      re: /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY-----(?<s>[\s\S]+?)-----END \1PRIVATE KEY-----/dg,
    },
    { re: /(?<![A-Za-z0-9])(?<s>(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16})(?![A-Za-z0-9])/dg },
    { re: /(?<![A-Za-z0-9_])(?<s>gh[pousr]_[A-Za-z0-9]{36,255})(?![A-Za-z0-9_])/dg },
    { re: /(?<![A-Za-z0-9_])(?<s>github_pat_[A-Za-z0-9_]{22,255})(?![A-Za-z0-9_])/dg },
    { re: /(?<![A-Za-z0-9_-])(?<s>xox[abposr]-[A-Za-z0-9-]{10,})/dg },
    { re: /hooks\.slack\.com\/services\/(?<s>[A-Za-z0-9_/]{16,})/dg },
    { re: /(?<![A-Za-z0-9_-])(?<s>sk-[A-Za-z0-9_-]{20,})/dg },
    { re: /(?<![A-Za-z0-9_])(?<s>[sr]k_(?:live|test)_[A-Za-z0-9]{16,})/dg },
    { re: /(?<![A-Za-z0-9_-])(?<s>AIza[0-9A-Za-z_-]{35})(?![A-Za-z0-9_-])/dg },
    {
      re: /(?<![A-Za-z0-9_-])(?<s>eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,})/dg,
    },
    // `Bearer <token>` (token must contain a digit or symbol: skips prose).
    {
      re: /\b[Bb]earer\s+(?<s>(?=[A-Za-z0-9\-._~+/]*[0-9\-._~+/])[A-Za-z0-9\-._~+/]{16,}=*)/dg,
    },
    {
      re: /\b[Bb]asic\s+(?<s>(?=[A-Za-z0-9+/]*[0-9+/])[A-Za-z0-9+/]{8,}={0,2})(?![A-Za-z0-9+/])/dg,
    },
    // scheme://user:password@host
    {
      re: /\b[A-Za-z][A-Za-z0-9+.-]{1,20}:\/\/[^\s:@/'"`<>]+:(?<s>[^\s@/'"`<>]+)@/dg,
      accept: s => !/^(?:\$\{|\{\{|<|%)/.test(s) && s !== REDACTED_PLACEHOLDER,
    },
    // name = "literal" / name: 'literal' / "name": "literal" / ['name'] = `literal`
    {
      re: /(?<q>["'`]?)(?<k>[A-Za-z_$][\w$-]{0,63})\k<q>\]?\s*(?::|=(?![=>]))\s*(?<vq>["'`])(?<s>(?:\\.|(?!\k<vq>)[^\\\r\n])+)\k<vq>/dg,
      accept: (s, m) => {
        const key = m.groups?.k ?? '';
        if (!matcher.matches(key)) return false;
        if (m.groups?.vq === '`' && s.includes('${')) return false;
        if (s.length < 3 || /\s/.test(s)) return false;
        return isSecretLikeValue(s);
      },
    },
  ];
}

/** Unquoted `password: hunter2` / `token=abc` (text and config fields, not JS code). */
function unquotedRule(matcher: SecretNameMatcher): ContentRule {
  return {
    re: /(?<![\w$.-])(?<k>[A-Za-z_][\w-]{0,63})[ \t]*(?::|=)[ \t]*(?<s>[^\s;,'"`&<>(){}[\]]{3,})/dg,
    accept: (s, m) =>
      matcher.matches(m.groups?.k ?? '') &&
      isSecretLikeValue(s) &&
      !s.startsWith('$') &&
      !s.startsWith('{{') &&
      // Skip code-ish references: `msg.password`, `env.get(`, `flow.get(...)`.
      !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(s) &&
      m.input.charAt(m.indices?.groups?.s?.[1] ?? 0) !== '(',
  };
}

const unquotedCache = new WeakMap<SecretNameMatcher, ContentRule>();

export interface ScanOptions {
  /** JavaScript source: skip the unquoted assignment rule. */
  code?: boolean;
}

export interface ScanResult {
  text: string;
  /** Original secret literals, one per placeholder in `text`, in order. */
  secrets: string[];
}

export function scanTextForSecrets(
  text: string,
  matcher: SecretNameMatcher,
  options: ScanOptions = {}
): ScanResult {
  if (text.length === 0) return { text, secrets: [] };
  const spans: Span[] = [];
  let rules = contentRules(matcher);
  if (!options.code) {
    let extra = unquotedCache.get(matcher);
    if (!extra) {
      extra = unquotedRule(matcher);
      unquotedCache.set(matcher, extra);
    }
    rules = [...rules, extra];
  }
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text)) !== null) {
      const idx = m.indices?.groups?.s;
      const secret = m.groups?.s;
      if (idx && secret !== undefined && secret.length > 0) {
        if (!rule.accept || rule.accept(secret, m)) {
          spans.push({ start: idx[0], end: idx[1] });
        }
      }
      if (m[0].length === 0) rule.re.lastIndex++;
    }
  }
  if (spans.length === 0) return { text, secrets: [] };
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const span of spans) {
    const prev = merged[merged.length - 1];
    if (prev && span.start < prev.end) {
      prev.end = Math.max(prev.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }
  let out = '';
  let pos = 0;
  const secrets: string[] = [];
  for (const span of merged) {
    const secret = text.slice(span.start, span.end);
    if (secret === REDACTED_PLACEHOLDER) continue;
    out += text.slice(pos, span.start) + REDACTED_PLACEHOLDER;
    secrets.push(secret);
    pos = span.end;
  }
  out += text.slice(pos);
  return { text: out, secrets };
}

// ---------------------------------------------------------------------------
// Flow redaction

interface RedactCtx {
  matcher: SecretNameMatcher;
  count: number;
  /** When set, original secret literals per `${entityId}\u0000${path}`. */
  secrets?: Map<string, string[]>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isFlowEntity(value: unknown): value is Record<string, unknown> & { id: string } {
  return isPlainObject(value) && typeof value.id === 'string' && typeof value.type === 'string';
}

class EntityRedactor {
  readonly paths: string[] = [];
  constructor(
    private readonly ctx: RedactCtx,
    private readonly entityId: string
  ) {}

  record(path: string, secrets: string[]): void {
    if (!this.paths.includes(path)) this.paths.push(path);
    this.ctx.count += secrets.length || 1;
    this.ctx.secrets?.set(`${this.entityId}\u0000${path}`, secrets);
  }

  /** Whole-value redaction when `nameSensitive`, else content scan. */
  string(value: string, path: string, nameSensitive: boolean): string {
    if ((nameSensitive && isSecretLikeValue(value)) || value.length > MAX_SCAN_FIELD_CHARS) {
      // Oversized fields are never scanned: safest is to hide them entirely.
      this.record(path, [value]);
      return REDACTED_PLACEHOLDER;
    }
    const topKey = path.split(/[.[]/, 1)[0] ?? '';
    const scanned = scanTextForSecrets(value, this.ctx.matcher, { code: CODE_KEYS.has(topKey) });
    if (scanned.secrets.length > 0) {
      this.record(path, scanned.secrets);
      return scanned.text;
    }
    return value;
  }

  env(list: unknown[], path: string): unknown[] {
    return list.map((entry, i) => {
      if (!isPlainObject(entry)) return entry;
      const type = typeof entry.type === 'string' ? entry.type : '';
      // Node-RED credential env vars: unchanged (value never in flows output).
      if (type === 'cred' || typeof entry.value !== 'string') return entry;
      if (REFERENCE_TYPES.has(type)) return entry;
      const name = typeof entry.name === 'string' ? entry.name : '';
      const before = entry.value;
      const after = this.string(before, `${path}[${i}].value`, this.ctx.matcher.matches(name));
      if (after === before) return entry;
      return { ...entry, value: after, redacted: true };
    });
  }

  value(value: unknown, path: string, key: string, siblings?: Record<string, unknown>): unknown {
    if (typeof value === 'string') {
      if (SCAN_ONLY_KEYS.has(key)) return this.string(value, path, false);
      const typeSibling = siblings?.[`${key}Type`];
      const isReference = typeof typeSibling === 'string' && REFERENCE_TYPES.has(typeSibling);
      return this.string(value, path, !isReference && this.ctx.matcher.matches(key));
    }
    if (Array.isArray(value)) {
      if (key === 'env') return this.env(value, path);
      return value.map((item, i) => this.value(item, `${path}[${i}]`, '', undefined));
    }
    if (isPlainObject(value)) {
      return this.object(value, path);
    }
    return value;
  }

  /** Nested config object: name/value pair rule + per-key recursion. */
  object(obj: Record<string, unknown>, path: string): Record<string, unknown> {
    let pairSensitive = false;
    for (const nameKey of PAIR_NAME_KEYS) {
      const n = obj[nameKey];
      if (typeof n === 'string' && this.ctx.matcher.matches(n)) {
        pairSensitive = true;
        break;
      }
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const childPath = path ? `${path}.${k}` : k;
      if (pairSensitive && k in PAIR_VALUE_KEYS && typeof v === 'string') {
        const typeKey = PAIR_VALUE_KEYS[k];
        const t = typeKey ? obj[typeKey] : undefined;
        const isReference = typeof t === 'string' && REFERENCE_TYPES.has(t);
        out[k] = this.string(v, childPath, !isReference);
        continue;
      }
      if ((PAIR_NAME_KEYS as readonly string[]).includes(k) && typeof v === 'string') {
        // Holds a name (`keyValue: 'X-Api-Key'`), not a secret: content scan only.
        out[k] = this.string(v, childPath, false);
        continue;
      }
      out[k] = this.value(v, childPath, k, obj);
    }
    return out;
  }
}

function redactEntity(entity: Record<string, unknown> & { id: string }, ctx: RedactCtx) {
  const redactor = new EntityRedactor(ctx, entity.id);
  const existing = entity[AI_REDACTIONS_KEY];
  if (Array.isArray(existing)) {
    for (const p of existing) if (typeof p === 'string') redactor.paths.push(p);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entity)) {
    if (k === AI_REDACTIONS_KEY) continue;
    if (STRUCTURAL_KEYS.has(k)) {
      out[k] = v;
    } else if (CHILD_ENTITY_KEYS.has(k) && Array.isArray(v)) {
      out[k] = v.map(child => redactValueInner(child, ctx));
    } else if (k === 'env' && Array.isArray(v)) {
      out[k] = redactor.env(v, 'env');
    } else {
      out[k] = redactor.value(v, k, k, entity);
    }
  }
  if (redactor.paths.length > 0) out[AI_REDACTIONS_KEY] = redactor.paths;
  return out;
}

function redactValueInner(value: unknown, ctx: RedactCtx): unknown {
  if (Array.isArray(value)) return value.map(v => redactValueInner(v, ctx));
  if (isFlowEntity(value)) return redactEntity(value, ctx);
  return value;
}

export interface RedactionResult<T> {
  value: T;
  count: number;
}

/**
 * Redact a flow entity, flat flows array, or nested tab (with `nodes`/`configs`).
 * Returns a deep-enough copy; the input is never mutated.
 */
export function redactFlowData<T>(
  value: T,
  patterns: readonly string[] = currentSecretNamePatterns()
): RedactionResult<T> {
  const ctx: RedactCtx = { matcher: createSecretNameMatcher(patterns), count: 0 };
  return { value: redactValueInner(value, ctx) as T, count: ctx.count };
}

/** Redact a stored proposal's flow bodies for AI presentation / diffs. */
export function redactProposalForAi<P extends Proposal>(
  proposal: P,
  patterns: readonly string[] = currentSecretNamePatterns()
): P {
  const out: P = {
    ...proposal,
    payload: { ...proposal.payload, flow: redactFlowData(proposal.payload.flow, patterns).value },
  };
  if (proposal.baseFlow !== undefined) {
    out.baseFlow = redactFlowData(proposal.baseFlow, patterns).value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// AI-facing adapter view

const RAW_ADAPTER = Symbol.for('ai-access.rawFlowAdapter');
type RedactingAdapter = FlowAdapter & { [RAW_ADAPTER]: FlowAdapter };
const viewCache = new WeakMap<FlowAdapter, RedactingAdapter>();

/**
 * Read-redacting view over a flow adapter. `updateFlow` passes through (only
 * the human approve path writes, and it uses the raw adapter anyway).
 */
export function aiRedactingAdapter(
  inner: FlowAdapter,
  getPatterns: () => readonly string[] = currentSecretNamePatterns
): FlowAdapter {
  if (isRedactingAdapter(inner)) return inner;
  const defaultGetter = getPatterns === currentSecretNamePatterns;
  const cached = defaultGetter ? viewCache.get(inner) : undefined;
  if (cached) return cached;
  const view: RedactingAdapter = {
    kind: inner.kind,
    [RAW_ADAPTER]: inner,
    async getFlows() {
      const snapshot = await inner.getFlows();
      return {
        rev: snapshot.rev,
        flows: redactFlowData(snapshot.flows, getPatterns()).value,
      };
    },
    async getFlow(flowId: string): Promise<FlowSnapshot> {
      const snapshot = await inner.getFlow(flowId);
      return { rev: snapshot.rev, flow: redactFlowData(snapshot.flow, getPatterns()).value };
    },
    updateFlow: params => inner.updateFlow(params),
  };
  if (defaultGetter) viewCache.set(inner, view);
  return view;
}

export function isRedactingAdapter(adapter: FlowAdapter): adapter is RedactingAdapter {
  return RAW_ADAPTER in adapter;
}

/** Underlying (unredacted) adapter of a redacting view, or the adapter itself. */
export function rawFlowAdapter(adapter: FlowAdapter): FlowAdapter {
  return isRedactingAdapter(adapter) ? adapter[RAW_ADAPTER] : adapter;
}

/**
 * Adapter for a request on a shared (admin-or-AI) route: AI callers (access
 * link / OAuth) get the redacting view; admin sessions see raw flows.
 */
export function adapterForRequest(
  req: { accessLink?: unknown; auth?: unknown },
  adapter: FlowAdapter
): FlowAdapter {
  return req.accessLink || req.auth ? aiRedactingAdapter(adapter) : adapter;
}

/** Count `[REDACTED]` placeholders in a serialized response body. */
export function countRedactionPlaceholders(text: string): number {
  let count = 0;
  let idx = text.indexOf(REDACTED_PLACEHOLDER);
  while (idx !== -1) {
    count++;
    idx = text.indexOf(REDACTED_PLACEHOLDER, idx + REDACTED_PLACEHOLDER.length);
  }
  return count;
}

// ---------------------------------------------------------------------------
// Restore placeholders on proposal submit (strict)
//
// A placeholder is only turned back into the real secret when the AI left it
// exactly where it was shown: same node id, same field path, env / name-value
// entries matched by their exact name (never by array index), and the text
// around the placeholder on its line identical to the original occurrence.
// Anything else (extra placeholders, renamed env vars, swapped headers, edited
// lines) is reported as unresolved and the submit is rejected, so an approved
// proposal can never carry a secret to a place the AI chose.

export interface RestoredField {
  nodeId: string;
  property: string;
}

export interface RestoreResult {
  flow: Partial<FlowTab>;
  /** Placeholders replaced with the original secret. */
  restored: number;
  /** Fields where a secret was restored (for the human reviewer). */
  restoredFields: RestoredField[];
  /** Placeholders that could not be strictly matched (submit must be rejected). */
  unresolved: (RestoredField & { reason: string })[];
}

/** Line-local context around each placeholder occurrence. */
function placeholderContexts(text: string): { before: string; after: string }[] {
  const parts = text.split(REDACTED_PLACEHOLDER);
  const out: { before: string; after: string }[] = [];
  for (let i = 1; i < parts.length; i++) {
    const prev = parts[i - 1] ?? '';
    const next = parts[i] ?? '';
    const nl = prev.lastIndexOf('\n');
    const endNl = next.indexOf('\n');
    out.push({
      before: nl >= 0 ? prev.slice(nl + 1) : prev,
      after: endNl >= 0 ? next.slice(0, endNl) : next,
    });
  }
  return out;
}

function restoreString(
  ai: string,
  redacted: string,
  original: string,
  secrets: string[]
): { text: string; restored: number } | { error: string } {
  if (ai === redacted) {
    return { text: original, restored: countRedactionPlaceholders(ai) };
  }
  const aiCtx = placeholderContexts(ai);
  const origCtx = placeholderContexts(redacted);
  if (aiCtx.length > origCtx.length) {
    return {
      error: `contains ${aiCtx.length} [REDACTED] placeholders but the original had ${origCtx.length}`,
    };
  }
  const used = new Set<number>();
  const parts = ai.split(REDACTED_PLACEHOLDER);
  let text = parts[0] ?? '';
  for (let i = 0; i < aiCtx.length; i++) {
    const c = aiCtx[i];
    if (!c) break;
    const k = origCtx.findIndex(
      (o, idx) => !used.has(idx) && o.before === c.before && o.after === c.after
    );
    if (k < 0) {
      return { error: 'a [REDACTED] placeholder is not on an unchanged original line' };
    }
    used.add(k);
    text += (secrets[k] ?? REDACTED_PLACEHOLDER) + (parts[i + 1] ?? '');
  }
  return { text, restored: aiCtx.length };
}

interface RestoreCtx {
  secrets: Map<string, string[]>;
  restored: number;
  restoredFields: RestoredField[];
  unresolved: (RestoredField & { reason: string })[];
}

const STABLE_ELEMENT_KEYS = ['name', 'keyValue', 'p', 'property', 'key', 'k'] as const;

/** Stable identity of an array element: `<key>=<value>` from a name-like field. */
function stableElementKey(value: unknown): string | undefined {
  if (!isPlainObject(value)) return undefined;
  for (const k of STABLE_ELEMENT_KEYS) {
    const v = value[k];
    if (typeof v === 'string' && v.length > 0) return `${k}=${v}`;
  }
  return undefined;
}

function restoreWalk(
  ai: unknown,
  redacted: unknown,
  original: unknown,
  entityId: string,
  path: string,
  ctx: RestoreCtx
): unknown {
  if (typeof ai === 'string') {
    if (!ai.includes(REDACTED_PLACEHOLDER)) return ai;
    const secrets = ctx.secrets.get(`${entityId}\u0000${path}`);
    if (typeof redacted === 'string' && typeof original === 'string' && secrets?.length) {
      const r = restoreString(ai, redacted, original, secrets);
      if ('error' in r) {
        ctx.unresolved.push({ nodeId: entityId, property: path, reason: r.error });
        return ai;
      }
      ctx.restored += r.restored;
      ctx.restoredFields.push({ nodeId: entityId, property: path });
      return r.text;
    }
    ctx.unresolved.push({
      nodeId: entityId,
      property: path,
      reason: 'no redacted secret exists at this node id and field',
    });
    return ai;
  }
  if (Array.isArray(ai)) {
    const redArr: unknown[] = Array.isArray(redacted) ? redacted : [];
    const origArr: unknown[] = Array.isArray(original) ? original : [];
    return (ai as unknown[]).map(item => {
      const clean =
        isPlainObject(item) && item.redacted === true ? withoutKey(item, 'redacted') : item;
      // Match elements by exact name-like key only — never by position.
      const key = stableElementKey(clean);
      const matches =
        key === undefined
          ? []
          : origArr.map((o, j) => (stableElementKey(o) === key ? j : -1)).filter(j => j >= 0);
      const j = matches.length === 1 ? matches[0] : undefined;
      if (j !== undefined) {
        return restoreWalk(clean, redArr[j], origArr[j], entityId, `${path}[${j}]`, ctx);
      }
      return restoreWalk(clean, undefined, undefined, entityId, `${path}[?]`, ctx);
    });
  }
  if (isPlainObject(ai)) {
    const redObj = isPlainObject(redacted) ? redacted : {};
    const origObj = isPlainObject(original) ? original : {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ai)) {
      out[k] = restoreWalk(v, redObj[k], origObj[k], entityId, path ? `${path}.${k}` : k, ctx);
    }
    return out;
  }
  return ai;
}

function withoutKey(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const out = { ...obj };
  delete out[key];
  return out;
}

function stripMarkers(entity: Record<string, unknown>): Record<string, unknown> {
  const rest = withoutKey(entity, AI_REDACTIONS_KEY);
  if (Array.isArray(rest.env)) {
    rest.env = (rest.env as unknown[]).map(e => {
      if (!isPlainObject(e) || e.redacted !== true) return e;
      return withoutKey(e, 'redacted');
    });
  }
  return rest;
}

function restoreEntity(
  aiEntity: Record<string, unknown>,
  originals: Map<string, Record<string, unknown>>,
  ctx: RestoreCtx,
  rctx: RedactCtx
): Record<string, unknown> {
  const id = typeof aiEntity.id === 'string' ? aiEntity.id : '';
  const original = id ? originals.get(id) : undefined;
  const out: Record<string, unknown> = {};
  const redacted = original ? redactEntity({ ...original, id }, rctx) : undefined;
  for (const [k, v] of Object.entries(aiEntity)) {
    if (k === AI_REDACTIONS_KEY) continue;
    if (CHILD_ENTITY_KEYS.has(k) && Array.isArray(v)) {
      out[k] = (v as unknown[]).map(child =>
        isPlainObject(child) ? restoreEntity(child, originals, ctx, rctx) : child
      );
      continue;
    }
    if (STRUCTURAL_KEYS.has(k)) {
      out[k] = v;
      continue;
    }
    out[k] = restoreWalk(v, redacted?.[k], original?.[k], id, k, ctx);
  }
  return stripMarkers(out);
}

/**
 * Strictly replace `[REDACTED]` placeholders in an AI-submitted tab with the
 * original secrets from the live flows (by node id). See the section comment
 * for the matching rules; callers must reject the submit when `unresolved` is
 * non-empty.
 */
export function restoreRedactedPlaceholders(
  aiFlow: Record<string, unknown>,
  liveFlows: readonly FlowNode[] | readonly Record<string, unknown>[],
  patterns: readonly string[] = currentSecretNamePatterns()
): RestoreResult {
  const originals = new Map<string, Record<string, unknown>>();
  for (const node of liveFlows) {
    if (isPlainObject(node) && typeof node.id === 'string') originals.set(node.id, node);
  }
  const secrets = new Map<string, string[]>();
  const rctx: RedactCtx = { matcher: createSecretNameMatcher(patterns), count: 0, secrets };
  const ctx: RestoreCtx = { secrets, restored: 0, restoredFields: [], unresolved: [] };
  const flow = restoreEntity(aiFlow, originals, ctx, rctx);
  return {
    flow,
    restored: ctx.restored,
    restoredFields: ctx.restoredFields,
    unresolved: ctx.unresolved,
  };
}

/** Node fields that decide where data (and therefore a secret) is sent. */
const DESTINATION_KEYS = [
  'type',
  'url',
  'host',
  'hostname',
  'server',
  'broker',
  'port',
  'path',
  'method',
  'headers',
  'endpoint',
  'uri',
  'protocol',
  'proxy',
  'tls',
  'to',
  'ret',
];

export interface SecretChangeWarning {
  code: 'secret_destination_changed' | 'secret_node_code_changed';
  error: string;
  nodeId: string;
  property: string;
}

/**
 * For every node that had a secret restored, warn when its destination
 * (url / host / method / headers / type …) or its code changed versus the
 * live flow — the reviewer must check the secret is not being sent elsewhere.
 */
export function secretChangeWarnings(
  restoredFields: readonly RestoredField[],
  flow: Record<string, unknown>,
  liveFlows: readonly Record<string, unknown>[]
): SecretChangeWarning[] {
  const ids = [...new Set(restoredFields.map(f => f.nodeId))];
  const live = new Map<string, Record<string, unknown>>();
  for (const n of liveFlows) if (isPlainObject(n) && typeof n.id === 'string') live.set(n.id, n);
  const proposed = new Map<string, Record<string, unknown>>();
  proposed.set(String(flow.id), flow);
  for (const key of ['nodes', 'configs'] as const) {
    const list = flow[key];
    if (Array.isArray(list)) {
      for (const n of list as unknown[]) {
        if (isPlainObject(n) && typeof n.id === 'string') proposed.set(n.id, n);
      }
    }
  }
  const out: SecretChangeWarning[] = [];
  for (const id of ids) {
    const before = live.get(id);
    const after = proposed.get(id);
    if (!before || !after) continue;
    const fields = restoredFields
      .filter(f => f.nodeId === id)
      .map(f => f.property)
      .join(', ');
    const changed = DESTINATION_KEYS.filter(
      k => JSON.stringify(before[k]) !== JSON.stringify(after[k])
    );
    if (changed.length > 0) {
      out.push({
        code: 'secret_destination_changed',
        error:
          `SECURITY: node ${id} holds a secret (${fields}) restored from the live flow, and this proposal ` +
          `changes where it sends data (${changed.join(', ')}). Verify the new destination before approving.`,
        nodeId: id,
        property: changed.join(','),
      });
    }
    const code = [...CODE_KEYS].filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    if (code.length > 0) {
      out.push({
        code: 'secret_node_code_changed',
        error:
          `Node ${id} holds a secret (${fields}) and its code changed (${code.join(', ')}). ` +
          'Check the new code does not send the secret anywhere unexpected.',
        nodeId: id,
        property: code.join(','),
      });
    }
  }
  return out;
}
