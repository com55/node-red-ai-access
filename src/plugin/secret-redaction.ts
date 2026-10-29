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
import type { Proposal, ProposalWarning } from '../storage/proposals.js';

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
  // Bounded memo: scans call matches() once per candidate key.
  const memo = new Map<string, boolean>();
  const matcher: SecretNameMatcher = {
    patterns: [...patterns],
    matches(name: string): boolean {
      if (typeof name !== 'string' || name.length === 0 || joined.length === 0) return false;
      const hit = memo.get(name);
      if (hit !== undefined) return hit;
      const result = matchUncached(name);
      if (memo.size > 4096) memo.clear();
      memo.set(name, result);
      return result;
    },
  };
  function matchUncached(name: string): boolean {
    {
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
    }
  }
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
  /** Cheap pre-filter: skip the regex unless the text contains one of these. */
  hints?: readonly string[];
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
  return [
    // Buffer.from("user:pw") / btoa('user:pw') basic-auth literals.
    {
      hints: ['Buffer.from', 'btoa'],
      re: /\b(?:Buffer\.from|btoa)\([ \t]{0,8}(?<q>["'`])[^"'`:\s]{1,256}:(?<s>[^"'`\s]{1,1024})\k<q>/dg,
      accept: s => !s.includes('${'),
    },
    // PEM private key body (keeps BEGIN/END lines).
    {
      hints: ['PRIVATE KEY-----'],
      re: /-----BEGIN ((?:[A-Z0-9]{1,16} ){0,4})PRIVATE KEY-----(?<s>[^-]{1,16384})-----END \1PRIVATE KEY-----/dg,
    },
    {
      hints: ['AKIA', 'ASIA', 'ABIA', 'ACCA'],
      re: /(?<![A-Za-z0-9])(?<s>(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16})(?![A-Za-z0-9])/dg,
    },
    {
      hints: ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_'],
      re: /(?<![A-Za-z0-9_])(?<s>gh[pousr]_[A-Za-z0-9]{36,255})(?![A-Za-z0-9_])/dg,
    },
    {
      hints: ['github_pat_'],
      re: /(?<![A-Za-z0-9_])(?<s>github_pat_[A-Za-z0-9_]{22,255})(?![A-Za-z0-9_])/dg,
    },
    { hints: ['xox'], re: /(?<![A-Za-z0-9_-])(?<s>xox[abposr]-[A-Za-z0-9-]{10,512})/dg },
    {
      hints: ['hooks.slack.com'],
      re: /hooks\.slack\.com\/services\/(?<s>[A-Za-z0-9_/]{16,512})/dg,
    },
    { hints: ['sk-'], re: /(?<![A-Za-z0-9_-])(?<s>sk-[A-Za-z0-9_-]{20,512})/dg },
    {
      hints: ['k_live_', 'k_test_'],
      re: /(?<![A-Za-z0-9_])(?<s>[sr]k_(?:live|test)_[A-Za-z0-9]{16,512})/dg,
    },
    { hints: ['AIza'], re: /(?<![A-Za-z0-9_-])(?<s>AIza[0-9A-Za-z_-]{35})(?![A-Za-z0-9_-])/dg },
    {
      hints: ['eyJ'],
      re: /(?<![A-Za-z0-9_-])(?<s>eyJ[A-Za-z0-9_-]{5,8192}\.[A-Za-z0-9_-]{5,8192}\.[A-Za-z0-9_-]{5,8192})/dg,
    },
    // `Bearer <token>` (token must contain a digit or symbol: skips prose).
    {
      hints: ['earer'],
      re: /\b[Bb]earer[ \t]{1,8}(?<s>(?=[A-Za-z0-9\-._~+/]{0,4096}[0-9\-._~+/])[A-Za-z0-9\-._~+/]{16,4096}={0,3})/dg,
    },
    {
      hints: ['asic'],
      re: /\b[Bb]asic[ \t]{1,8}(?<s>(?=[A-Za-z0-9+/]{0,4096}[0-9+/])[A-Za-z0-9+/]{8,4096}={0,2})(?![A-Za-z0-9+/])/dg,
    },
    // scheme://user:password@host
    {
      hints: ['@'],
      re: /\b[A-Za-z][A-Za-z0-9+.-]{1,20}:\/\/[^\s:@/'"`<>]{1,256}:(?<s>[^\s@/'"`<>]{1,1024})@/dg,
      accept: s => !/^(?:\$\{|\{\{|<|%)/.test(s) && s !== REDACTED_PLACEHOLDER,
    },
    // URL query params: https://api.example/?key=abc123&x=1
    {
      hints: ['?', '&'],
      re: /[?&](?<k>[A-Za-z_][\w.-]{0,63})=(?<s>[^&#\s"'`<>]{1,2048})/dg,
      accept: (s, m) =>
        matcher.matches(m.groups?.k ?? '') && isSecretLikeValue(decodeURIComponentSafe(s)),
    },
    // name = "literal" / name: 'literal' / "name": "literal" / ['name'] = `literal`
    {
      hints: [':', '='],
      re: /(?<![\w$-])(?<q>["'`]?)(?<k>[A-Za-z_$][\w$-]{0,63})\k<q>\]?[ \t]{0,8}(?::|=(?![=>]))[ \t]{0,8}(?<vq>["'`])(?<s>(?:\\.|(?!\k<vq>)[^\\\r\n]){1,1024})\k<vq>/dg,
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
/** Names that are unambiguous secrets: any unquoted value counts. */
export const STRONG_SECRET_NAME_PATTERNS = [
  'PASSWORD',
  'PASSWD',
  'PASSPHRASE',
  'SECRET',
  'CLIENT_SECRET',
  'TOKEN',
  'API_KEY',
  'APIKEY',
  'PRIVATE',
  'CREDENTIAL',
  'PWD',
  'PW',
];

function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Weak names (KEY, AUTH, SESSION, COOKIE, CONN, PASS, custom…) appear in prose,
 * so their unquoted values must look random: a digit or symbol, 16+ chars,
 * or high entropy (3+ character classes, or Shannon entropy ≥ 3 bits/char).
 */
function looksRandom(s: string): boolean {
  if (/[^A-Za-z]/.test(s) || s.length >= 16) return true;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(r => r.test(s)).length;
  return classes >= 3 || shannonEntropy(s) >= 3;
}

function unquotedRule(matcher: SecretNameMatcher): ContentRule {
  const strongList = matcher.patterns.filter(p =>
    STRONG_SECRET_NAME_PATTERNS.includes(p.toUpperCase())
  );
  const strong = createSecretNameMatcher(strongList);
  return {
    hints: [':', '='],
    re: /(?<![\w$.-])(?<k>[A-Za-z_][\w-]{0,63})[ \t]{0,8}(?::(?!\/\/)|=)[ \t]{0,8}(?<s>[^\s;,'"`&<>(){}[\]]{3,1024})/dg,
    accept: (s, m) =>
      matcher.matches(m.groups?.k ?? '') &&
      isSecretLikeValue(s) &&
      !s.startsWith('$') &&
      !s.startsWith('{{') &&
      // Strong names: any value. Weak names: must look random (see looksRandom).
      (strong.matches(m.groups?.k ?? '') || looksRandom(s)) &&
      // Skip code-ish references: `msg.password`, `env.get(`, `flow.get(...)`.
      !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(s) &&
      m.input.charAt(m.indices?.groups?.s?.[1] ?? 0) !== '(',
  };
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Connection strings / DSNs (`Server=x;User Id=sa;Password=p@ss;`): split on
 * line breaks and `;` (no regex backtracking, O(n)) and redact the value of
 * each secret-named key when the line has 2+ key=value pairs.
 */
interface ConnSegment {
  k: string;
  vs: number;
  ve: number;
}

/** Parse one `key=value` segment in `[start, end)`; undefined if not a pair. */
function parseConnSegment(text: string, start: number, end: number): ConnSegment | undefined {
  const eq = text.indexOf('=', start);
  if (eq <= start || eq >= end || eq - start > 48) return undefined;
  const rawKey = text.slice(start, eq);
  const q = Math.max(rawKey.lastIndexOf('"'), rawKey.lastIndexOf("'"), rawKey.lastIndexOf('`'));
  const key = rawKey.slice(q + 1).trim();
  if (!/^[A-Za-z][\w -]{0,40}$/.test(key)) return undefined;
  let vs = eq + 1;
  while (vs < end && (text[vs] === ' ' || text[vs] === '\t')) vs++;
  let ve = vs;
  while (ve < end && !`"'\`\r`.includes(text[ve] ?? '')) ve++;
  while (ve > vs && (text[ve - 1] === ' ' || text[ve - 1] === '\t')) ve--;
  return { k: key, vs, ve };
}

/**
 * Connection strings / DSNs (`Server=x;User Id=sa;Password=p@ss;`): split on
 * line breaks and `;` (no regex backtracking, O(n)) and redact the value of
 * each secret-named key when the line has 2+ key=value pairs.
 */
function connectionStringSpans(text: string, matcher: SecretNameMatcher): Span[] {
  if (!text.includes(';') || !text.includes('=')) return [];
  const out: Span[] = [];
  let lineStart = 0;
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd < 0) lineEnd = text.length;
    const segs: ConnSegment[] = [];
    let segStart = lineStart;
    let sawSemi = false;
    while (segStart < lineEnd) {
      let segEnd = text.indexOf(';', segStart);
      if (segEnd < 0 || segEnd > lineEnd) segEnd = lineEnd;
      else sawSemi = true;
      const seg = parseConnSegment(text, segStart, segEnd);
      if (seg) segs.push(seg);
      segStart = segEnd + 1;
    }
    if (sawSemi && segs.length >= 2) {
      for (const seg of segs) {
        if (seg.ve <= seg.vs || !matcher.matches(seg.k)) continue;
        if (isSecretLikeValue(text.slice(seg.vs, seg.ve))) out.push({ start: seg.vs, end: seg.ve });
      }
    }
    lineStart = lineEnd + 1;
  }
  return out;
}

const unquotedCache = new WeakMap<SecretNameMatcher, ContentRule>();

export interface ScanOptions {
  /** JavaScript source: skip the unquoted assignment rule. */
  code?: boolean;
}

export interface ScanResult {
  text: string;
  /** Original secret literals, excluding pre-existing literal placeholders. */
  secrets: string[];
  /** Source offsets of the actual secret replacements, excluding literals. */
  spans: Span[];
}

export function scanTextForSecrets(
  text: string,
  matcher: SecretNameMatcher,
  options: ScanOptions = {}
): ScanResult {
  if (text.length === 0) return { text, secrets: [], spans: [] };
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
  spans.push(...connectionStringSpans(text, matcher));
  for (const rule of rules) {
    if (rule.hints && !rule.hints.some(h => text.includes(h))) continue;
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
  if (spans.length === 0) return { text, secrets: [], spans: [] };
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
  const replaced: Span[] = [];
  for (const span of merged) {
    const secret = text.slice(span.start, span.end);
    if (secret === REDACTED_PLACEHOLDER) continue;
    out += text.slice(pos, span.start) + REDACTED_PLACEHOLDER;
    secrets.push(secret);
    replaced.push(span);
    pos = span.end;
  }
  out += text.slice(pos);
  return { text: out, secrets, spans: replaced };
}

// ---------------------------------------------------------------------------
// Flow redaction

interface PlaceholderOccurrence {
  kind: 'literal' | 'secret';
  value: string;
}

interface RedactedField {
  text: string;
  occurrences: PlaceholderOccurrence[];
}

/** Classify every output placeholder using source offsets, never secret-array indices. */
function classifyPlaceholders(original: string, spans: Span[]): PlaceholderOccurrence[] {
  const out: PlaceholderOccurrence[] = [];
  let pos = 0;
  const literals = (text: string) => {
    const count = countRedactionPlaceholders(text);
    for (let i = 0; i < count; i++) out.push({ kind: 'literal', value: REDACTED_PLACEHOLDER });
  };
  for (const span of spans) {
    literals(original.slice(pos, span.start));
    out.push({ kind: 'secret', value: original.slice(span.start, span.end) });
    pos = span.end;
  }
  literals(original.slice(pos));
  return out;
}

interface RedactCtx {
  matcher: SecretNameMatcher;
  count: number;
  /** When set, original secret literals per `${entityId}\u0000${path}`. */
  secrets?: Map<string, string[]>;
  fields?: Map<string, RedactedField>;
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
      this.ctx.fields?.set(`${this.entityId}\u0000${path}`, {
        text: REDACTED_PLACEHOLDER,
        occurrences: [{ kind: 'secret', value }],
      });
      return REDACTED_PLACEHOLDER;
    }
    const topKey = path.split(/[.[]/, 1)[0] ?? '';
    const scanned = scanTextForSecrets(value, this.ctx.matcher, { code: CODE_KEYS.has(topKey) });
    if (this.ctx.fields && scanned.text.includes(REDACTED_PLACEHOLDER)) {
      this.ctx.fields.set(`${this.entityId}\u0000${path}`, {
        text: scanned.text,
        occurrences: classifyPlaceholders(value, scanned.spans),
      });
    }
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

/** Named env/header entries keep their identity when the editor reorders them. */
function normalizeSecretArrays(value: unknown): unknown {
  if (Array.isArray(value)) {
    const entries = value.map(item => ({
      item: normalizeSecretArrays(item),
      key: stableElementKey(item),
    }));
    if (
      entries.every(entry => entry.key !== undefined) &&
      new Set(entries.map(entry => entry.key)).size === entries.length
    ) {
      entries.sort((a, b) => (a.key ?? '').localeCompare(b.key ?? ''));
    }
    return entries.map(entry => entry.item);
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, normalizeSecretArrays(child)])
    );
  }
  return value;
}

/** Whether the editor changed any secret value on a node since the base. */
export function secretValuesChanged(before: FlowNode, after: FlowNode): boolean {
  const values = (node: FlowNode): Map<string, string[]> => {
    const secrets = new Map<string, string[]>();
    redactEntity(normalizeSecretArrays(node) as FlowNode, {
      matcher: createSecretNameMatcher(currentSecretNamePatterns()),
      count: 0,
      secrets,
    });
    return secrets;
  };
  const a = values(before);
  const b = values(after);
  return [...new Set([...a.keys(), ...b.keys()])].some(
    key => JSON.stringify(a.get(key)) !== JSON.stringify(b.get(key))
  );
}

/** Conflict labels can contain the same secrets as node names in flow reads. */
export function redactConflictLabels<T extends { nodeName?: string }>(
  conflicts: readonly T[],
  patterns: readonly string[] = currentSecretNamePatterns()
): T[] {
  return conflicts.map(conflict => {
    if (conflict.nodeName === undefined) return { ...conflict };
    const label = redactFlowData(
      { id: 'conflict', type: 'node', name: conflict.nodeName },
      patterns
    );
    return { ...conflict, nodeName: label.value.name };
  });
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
  if (proposal.conflictChoice) {
    out.conflictChoice = {
      nodeId: proposal.conflictChoice.nodeId,
      choice: proposal.conflictChoice.choice,
      ...(proposal.conflictChoice.chooser ? { chooser: proposal.conflictChoice.chooser } : {}),
    };
  }
  if (proposal.baseFlow !== undefined) {
    out.baseFlow = redactFlowData(proposal.baseFlow, patterns).value;
  }
  if (proposal.rebase) {
    out.rebase = {
      ...proposal.rebase,
      conflicts: redactConflictLabels(proposal.rebase.conflicts, patterns),
    };
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

function contextKey(context: { before: string; after: string }): string {
  return JSON.stringify([context.before, context.after]);
}

function indexOccurrences(field: RedactedField): Map<string, number[]> {
  const index = new Map<string, number[]>();
  placeholderContexts(field.text).forEach((context, i) => {
    const key = contextKey(context);
    const indices = index.get(key) ?? [];
    indices.push(i);
    index.set(key, indices);
  });
  return index;
}

function restoreString(
  ai: string,
  redacted: string,
  original: string,
  occurrences: PlaceholderOccurrence[]
): { text: string; restored: number } | { error: string } {
  if (ai === redacted) {
    return { text: original, restored: occurrences.filter(o => o.kind === 'secret').length };
  }
  const aiCtx = placeholderContexts(ai);
  const origCtx = placeholderContexts(redacted);
  if (aiCtx.length > origCtx.length) {
    return {
      error: `contains ${aiCtx.length} [REDACTED] placeholders but the original had ${origCtx.length}`,
    };
  }
  const index = indexOccurrences({ text: redacted, occurrences });
  const ambiguous = new Set(
    [...index]
      .filter(([, indices]) => new Set(indices.map(i => occurrences[i]?.kind)).size > 1)
      .map(([key]) => key)
  );
  const consumed = new Map<string, number>();
  const parts = ai.split(REDACTED_PLACEHOLDER);
  let text = parts[0] ?? '';
  let restored = 0;
  for (let i = 0; i < aiCtx.length; i++) {
    const c = aiCtx[i];
    if (!c) break;
    const key = contextKey(c);
    const candidates = index.get(key) ?? [];
    // Identical contexts of different classifications cannot be safely distinguished.
    if (ambiguous.has(key)) {
      return { error: 'ambiguous literal and secret [REDACTED] occurrences' };
    }
    const used = consumed.get(key) ?? 0;
    const k = candidates[used] ?? -1;
    if (k < 0) {
      return { error: 'a [REDACTED] placeholder is not on an unchanged original line' };
    }
    consumed.set(key, used + 1);
    const occurrence = occurrences[k];
    if (occurrence?.kind === 'secret') restored++;
    text += (occurrence?.value ?? REDACTED_PLACEHOLDER) + (parts[i + 1] ?? '');
  }
  return { text, restored };
}

interface RestoreCtx {
  fields: Map<string, RedactedField>;
  restored: number;
  restoredFields: RestoredField[];
  unresolved: (RestoredField & { reason: string })[];
}

const STABLE_ELEMENT_KEYS = ['name', 'keyValue', 'p', 'property', 'key', 'k'] as const;

/** Stable identity of an array element: `<key>=<value>` from a name-like field. */
export function stableElementKey(value: unknown): string | undefined {
  if (!isPlainObject(value)) return undefined;
  for (const k of STABLE_ELEMENT_KEYS) {
    const v = value[k];
    if (typeof v === 'string' && v.length > 0) return `${k}=${v}`;
  }
  return undefined;
}

/** Warn when changed env arrays contain names that cannot be paired uniquely. */
export function duplicateEnvWarnings(
  before: Partial<FlowTab>,
  after: Partial<FlowTab>
): ProposalWarning[] {
  const entities = (tab: Partial<FlowTab>) => [tab, ...(tab.nodes ?? []), ...(tab.configs ?? [])];
  const previous = new Map(entities(before).map(node => [node.id, node]));
  const warnings: ProposalWarning[] = [];
  for (const node of entities(after)) {
    const old = previous.get(node.id);
    if (JSON.stringify(old?.env) === JSON.stringify(node.env)) continue;
    const hasDuplicates = (env: unknown) => {
      const names = new Set<string>();
      if (!Array.isArray(env)) return false;
      return env.some(entry => {
        if (!isPlainObject(entry) || typeof entry.name !== 'string' || !entry.name) return false;
        if (names.has(entry.name)) return true;
        names.add(entry.name);
        return false;
      });
    };
    if (!hasDuplicates(old?.env) && !hasDuplicates(node.env)) continue;
    warnings.push({
      code: 'duplicate_env_keys',
      ...(node.id ? { nodeId: node.id } : {}),
      property: 'env',
      error:
        'Duplicate env names make pairing by name ambiguous when entries are reordered. Review the env values before approval.',
    });
  }
  return warnings;
}

/** A retained duplicate secret cannot be paired after another copy was deleted. */
export class SecretAlignmentConflictError extends Error {
  constructor() {
    super(
      'A duplicate secret line was removed while its live values changed. Resolve this field against the live flow.'
    );
    this.name = 'SecretAlignmentConflictError';
  }
}

/** Keep each unchanged proposed secret span at its live value, preserving other edits. */
export function preserveLiveSecrets(
  base: FlowNode,
  proposed: FlowNode,
  live: FlowNode,
  warnings: ProposalWarning[] = []
): FlowNode {
  const fieldsFor = (node: FlowNode) => {
    const fields = new Map<string, RedactedField>();
    redactEntity(node, {
      matcher: createSecretNameMatcher(currentSecretNamePatterns()),
      count: 0,
      fields,
    });
    return fields;
  };
  const baseFields = fieldsFor(base),
    proposedFields = fieldsFor(proposed),
    liveFields = fieldsFor(live);
  const walk = (b: unknown, p: unknown, c: unknown, bp: string, pp = bp, cp = bp): unknown => {
    if (typeof p === 'string') {
      const bf = baseFields.get(`${base.id}\u0000${bp}`);
      if (!bf?.occurrences.some(o => o.kind === 'secret')) return p;
      const pf = proposedFields.get(`${proposed.id}\u0000${pp}`);
      const cf = liveFields.get(`${live.id}\u0000${cp}`);
      const bc = placeholderContexts(bf.text);
      const baseIndex = indexOccurrences(bf);
      const proposedIndex = pf ? indexOccurrences(pf) : new Map<string, number[]>();
      const liveIndex = cf ? indexOccurrences(cf) : new Map<string, number[]>();
      const values = pf?.occurrences.map(o => o.value) ?? [];
      const proposedContexts = pf ? placeholderContexts(pf.text) : [];
      const unmatchedProposedSecret = pf?.occurrences.some((o, j) => {
        const pc = proposedContexts[j];
        return o.kind === 'secret' && pc && !baseIndex.has(contextKey(pc));
      });
      let ambiguous = false;
      bf.occurrences.forEach((occurrence, i) => {
        if (occurrence.kind !== 'secret') return;
        const context = bc[i];
        const key = context ? contextKey(context) : '';
        const baseCopies = baseIndex.get(key) ?? [];
        const proposedCopies = proposedIndex.get(key) ?? [];
        const liveCopies = liveIndex.get(key) ?? [];
        if (
          baseCopies.length > 1 &&
          proposedCopies.length > 0 &&
          proposedCopies.length < baseCopies.length &&
          JSON.stringify(baseCopies.map(j => bf.occurrences[j]?.value)) !==
            JSON.stringify(liveCopies.map(j => cf?.occurrences[j]?.value))
        ) {
          throw new SecretAlignmentConflictError();
        }
        const matches = (lookup: Map<string, number[]>, field: RedactedField | undefined) => {
          const indices = lookup.get(key) ?? [];
          // A literal with the same context also makes alignment ambiguous.
          const [index] = indices;
          return indices.length === 1 &&
            index !== undefined &&
            field?.occurrences[index]?.kind === 'secret'
            ? index
            : undefined;
        };
        const bi = matches(baseIndex, bf),
          pi = matches(proposedIndex, pf),
          ci = matches(liveIndex, cf);
        // A removed secret span cannot restore an old value. Keep warning for
        // retained secrets whose surrounding code changed or became ambiguous.
        if (!proposedIndex.has(key) && !unmatchedProposedSecret) return;
        if (bi === undefined || pi === undefined || ci === undefined) {
          ambiguous = true;
          return;
        }
        const liveOccurrence = cf?.occurrences[ci];
        if (pf?.occurrences[pi]?.value === occurrence.value && liveOccurrence)
          values[pi] = liveOccurrence.value;
      });
      if (ambiguous)
        warnings.push({
          code: 'secret_may_revert',
          nodeId: base.id,
          property: pp,
          error:
            'Secret spans could not be aligned reliably. The proposed value was kept and may revert an editor secret change. Review this field before approval.',
        });
      if (!pf || ambiguous) return p;
      return pf.text
        .split(REDACTED_PLACEHOLDER)
        .reduce(
          (text, part, i) => text + (i ? (values[i - 1] ?? REDACTED_PLACEHOLDER) : '') + part,
          ''
        );
    }
    if (Array.isArray(p)) {
      const before: unknown[] = Array.isArray(b) ? b : [];
      const current: unknown[] = Array.isArray(c) ? c : [];
      const usedBase = new Set<number>(),
        usedLive = new Set<number>();
      return p.map((item: unknown, i: number) => {
        const key = stableElementKey(item);
        const match = (list: unknown[], used: Set<number>): number => {
          const index =
            key === undefined
              ? i
              : list.findIndex((entry, j) => !used.has(j) && stableElementKey(entry) === key);
          used.add(index);
          return index;
        };
        const bi = match(before, usedBase),
          ci = match(current, usedLive);
        return walk(before[bi], item, current[ci], `${bp}[${bi}]`, `${pp}[${i}]`, `${cp}[${ci}]`);
      });
    }
    if (isPlainObject(p)) {
      const before = isPlainObject(b) ? b : {},
        current = isPlainObject(c) ? c : {};
      const path = (prefix: string, key: string) => (prefix ? `${prefix}.${key}` : key);
      return Object.fromEntries(
        Object.entries(p)
          .map(([key, value]) => [
            key,
            walk(before[key], value, current[key], path(bp, key), path(pp, key), path(cp, key)),
          ])
          .filter(([, value]) => value !== undefined)
      );
    }
    return p;
  };
  return walk(base, proposed, live, '') as FlowNode;
}

/** Validate actual literal occurrences retained in a restored proposal against live text. */
export function hasNewLiteralPlaceholder(proposed: string, live: string): boolean {
  const occurrences = classifyPlaceholders(live, []);
  return 'error' in restoreString(proposed, live, live, occurrences);
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
    const field = ctx.fields.get(`${entityId}\u0000${path}`);
    if (
      typeof redacted === 'string' &&
      typeof original === 'string' &&
      (field || original.includes(REDACTED_PLACEHOLDER))
    ) {
      const r = restoreString(
        ai,
        redacted,
        original,
        field?.occurrences ?? classifyPlaceholders(original, [])
      );
      if ('error' in r) {
        ctx.unresolved.push({ nodeId: entityId, property: path, reason: r.error });
        return ai;
      }
      // An existing literal placeholder is retained, not a restored secret.
      if (r.restored > 0) {
        ctx.restored += r.restored;
        ctx.restoredFields.push({ nodeId: entityId, property: path });
      }
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
    // Match elements by exact name-like key only — never by position. With
    // duplicate keys (two `Set-Cookie` headers) the k-th AI entry maps to the
    // k-th unused original with that key, so each original is used once.
    const used = new Set<number>();
    return (ai as unknown[]).map(item => {
      const clean =
        isPlainObject(item) && item.redacted === true ? withoutKey(item, 'redacted') : item;
      const key = stableElementKey(clean);
      let j = -1;
      if (key !== undefined) {
        const candidates = origArr
          .map((o, idx) => (stableElementKey(o) === key && !used.has(idx) ? idx : -1))
          .filter(idx => idx >= 0);
        if (candidates.length > 0) j = candidates[0] ?? -1;
      }
      if (j >= 0) {
        used.add(j);
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
  const fields = new Map<string, RedactedField>();
  const rctx: RedactCtx = { matcher: createSecretNameMatcher(patterns), count: 0, fields };
  const ctx: RestoreCtx = { fields, restored: 0, restoredFields: [], unresolved: [] };
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

export type SecretChangeCode =
  | 'secret_destination_changed'
  | 'secret_node_code_changed'
  | 'secret_wires_changed'
  | 'secret_scope_changed'
  | 'outbound_node_changed'
  | 'secret_tab_changed'
  | 'secret_reference_added';

export interface SecretChangeWarning {
  code: SecretChangeCode;
  error: string;
  nodeId: string;
  property: string;
}

/** Node types that can send data off the box. */
const OUTBOUND_TYPES = new Set([
  'http request',
  'http response',
  'link out',
  'link call',
  'mqtt out',
  'mqtt-broker',
  'tcp out',
  'tcp request',
  'udp out',
  'e-mail',
  'websocket out',
  'websocket-client',
  'websocket-listener',
  'function',
  'exec',
  'file',
]);

/** Fields that make an unknown (third-party) node type look outbound. */
const OUTBOUND_HINT_KEYS = ['url', 'host', 'hostname', 'server', 'broker', 'endpoint', 'uri'];

function isOutboundNode(node: Record<string, unknown>): boolean {
  if (typeof node.type === 'string' && OUTBOUND_TYPES.has(node.type)) return true;
  return OUTBOUND_HINT_KEYS.some(k => typeof node[k] === 'string' && node[k] !== '');
}

/** Typed-input / pair keys whose `env` / `global` / `flow` type makes the value a name reference. */
const REF_TYPES = new Set(['env', 'global', 'flow']);

/**
 * Names of env/context values a node reads: `env.get("X")`, `$env("X")`,
 * `${X}`, `global.get("X")`, `flow.get("X")`, and typed inputs whose type is
 * `env` / `global` / `flow` (`fooType`, `vt`, `valueType`, `tot`, …).
 */
export function referencedNames(node: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 12) return;
    if (typeof v === 'string') {
      if (v.length > MAX_SCAN_FIELD_CHARS) return;
      const re =
        /(?:\b(?:env|global|flow)\.get|\$env)\([ \t]{0,8}["'`]([^"'`\r\n]{1,128})["'`]|\$\{([A-Za-z_][\w.-]{0,127})\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(v)) !== null) out.add(m[1] ?? m[2] ?? '');
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (!isPlainObject(v)) return;
    for (const [k, x] of Object.entries(v)) {
      const typeKeys = [
        `${k}Type`,
        k === 'v' ? 'vt' : '',
        k === 'to' ? 'tot' : '',
        k === 'value' ? 'type' : '',
        k === 'valueValue' ? 'valueType' : '',
        k === 'keyValue' ? 'keyType' : '',
      ];
      const typed = typeKeys.some(t => t && typeof v[t] === 'string' && REF_TYPES.has(v[t]));
      if (typed && typeof x === 'string') out.add(x);
      walk(x, depth + 1);
    }
  };
  walk(node, 0);
  out.delete('');
  return out;
}

/** Layout-only keys ignored when deciding whether a node "changed". */
const LAYOUT_KEYS = new Set(['x', 'y', 'w', 'h', 'l']);

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function nodeChanged(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (LAYOUT_KEYS.has(k) || k === 'nodes' || k === 'configs') continue;
    if (!sameJson(before[k], after[k])) return true;
  }
  return false;
}

/** Group chain, tab, and referenced config node ids that scope a node's env / settings. */
function scopeIds(
  node: Record<string, unknown>,
  all: Map<string, Record<string, unknown>>,
  tabId: string
): string[] {
  const out = new Set<string>([tabId]);
  let g = typeof node.g === 'string' ? node.g : undefined;
  for (let depth = 0; g && depth < 32 && !out.has(g); depth++) {
    out.add(g);
    const grp = all.get(g);
    g = grp && typeof grp.g === 'string' ? grp.g : undefined;
  }
  for (const v of Object.values(node)) {
    if (typeof v === 'string' && v !== node.id && all.get(v)?.z === undefined && all.has(v)) {
      out.add(v); // config node (no z) referenced by id
    }
  }
  for (const [id, n] of all) if (n.type === 'global-config') out.add(id);
  return [...out];
}

type NodeMap = Map<string, Record<string, unknown>>;

function restoredFieldList(restoredFields: readonly RestoredField[], id: string): string {
  return restoredFields
    .filter(f => f.nodeId === id)
    .map(f => f.property)
    .join(', ');
}

/** Destination / code / wires changes on one secret-holding node. */
function secretNodeWarnings(
  id: string,
  fields: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>
): SecretChangeWarning[] {
  const out: SecretChangeWarning[] = [];
  const changed = DESTINATION_KEYS.filter(k => !sameJson(before[k], after[k]));
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
  const code = [...CODE_KEYS].filter(k => !sameJson(before[k], after[k]));
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
  if (!sameJson(before.wires, after.wires)) {
    out.push({
      code: 'secret_wires_changed',
      error:
        `SECURITY: node ${id} holds a secret (${fields}) and its output wires changed. ` +
        'Check where its messages (which may carry the secret) now go.',
      nodeId: id,
      property: 'wires',
    });
  }
  return out;
}

/** Env / config scope changes (tab env, group chain, referenced config nodes). */
function scopeWarnings(
  id: string,
  before: Record<string, unknown>,
  live: NodeMap,
  proposed: NodeMap,
  tabId: string,
  flagged: Set<string>
): SecretChangeWarning[] {
  const out: SecretChangeWarning[] = [];
  for (const sid of scopeIds(before, live, tabId)) {
    if (sid === id || flagged.has(sid)) continue;
    const b = live.get(sid);
    const isTab = sid === tabId;
    const a = proposed.get(sid) ?? (b && !isTab && b.z === undefined ? b : undefined);
    const differs = isTab
      ? !sameJson(b?.env, a?.env)
      : b !== undefined && a !== undefined && nodeChanged(b, a);
    if (!differs) continue;
    flagged.add(sid);
    const kind = isTab ? 'tab' : typeof b?.type === 'string' ? b.type : 'node';
    out.push({
      code: 'secret_scope_changed',
      error:
        `SECURITY: ${kind} ${sid} scopes or configures secret-holding node ${id} ` +
        '(env vars like ${HOST} or a config node) and it changed. Check URLs/hosts it resolves to.',
      nodeId: sid,
      property: isTab ? 'env' : 'config',
    });
  }
  return out;
}

/** Added/changed outbound nodes, secret-name references, and other tab changes. */
function tabWarnings(
  ids: readonly string[],
  live: NodeMap,
  proposed: NodeMap,
  tabId: string,
  matcher: SecretNameMatcher
): SecretChangeWarning[] {
  const out: SecretChangeWarning[] = [];
  const otherChanged: string[] = [];
  for (const [nid, after] of proposed) {
    if (nid === tabId) continue;
    const before = live.get(nid);
    if (before && !nodeChanged(before, after)) continue;
    if (!ids.includes(nid)) otherChanged.push(nid);
    const type = typeof after.type === 'string' ? after.type : 'node';
    if (isOutboundNode(after) && !ids.includes(nid)) {
      out.push({
        code: 'outbound_node_changed',
        error:
          `SECURITY: this proposal ${before ? 'changes' : 'adds'} outbound-capable node ${nid} ` +
          `(${type}). Check where it sends data before approving.`,
        nodeId: nid,
        property: [...new Set([...Object.keys(before ?? {}), ...Object.keys(after)])]
          .filter(
            key =>
              !LAYOUT_KEYS.has(key) &&
              key !== 'nodes' &&
              key !== 'configs' &&
              !sameJson(before?.[key], after[key])
          )
          .sort()
          .join(','),
      });
    }
    const had = before ? referencedNames(before) : new Set<string>();
    const added = [...referencedNames(after)].filter(n => !had.has(n) && matcher.matches(n));
    if (added.length > 0) {
      out.push({
        code: 'secret_reference_added',
        error:
          `SECURITY: node ${nid} (${type}) now reads secret-named value(s) ${added.slice(0, 5).join(', ')} ` +
          '(env / global / flow). The AI cannot see these values but the flow will use them at runtime; ' +
          'check they are not sent anywhere unexpected.',
        nodeId: nid,
        property: added.slice(0, 5).join(','),
      });
    }
  }
  if (ids.length === 0) return out;
  for (const [nid, before] of live) {
    if (before.z === tabId && !proposed.has(nid)) otherChanged.push(nid);
  }
  if (otherChanged.length > 0) {
    const shown = otherChanged.slice(0, 10).join(', ') + (otherChanged.length > 10 ? ', …' : '');
    out.push({
      code: 'secret_tab_changed',
      error:
        `This proposal restores secrets in this tab and also changes ${otherChanged.length} other ` +
        `node(s) (${shown}). Review every change: any of them could route secret data elsewhere.`,
      nodeId: tabId,
      property: 'nodes',
    });
  }
  return out;
}

function proposedNodeMap(flow: Record<string, unknown>, tabId: string): NodeMap {
  const proposed: NodeMap = new Map();
  proposed.set(tabId, flow);
  for (const key of ['nodes', 'configs'] as const) {
    const list = flow[key];
    if (!Array.isArray(list)) continue;
    for (const n of list as unknown[]) {
      if (isPlainObject(n) && typeof n.id === 'string') proposed.set(n.id, n);
    }
  }
  return proposed;
}

/**
 * Warnings for a proposal in which secrets were restored. The AI never saw the
 * values, but approving runs them in the proposed flow, so any change that
 * could route data elsewhere is surfaced to the reviewer:
 * destination/code/wires of a secret-holding node, env or config scoping it,
 * any added/changed outbound-capable node, and any other change in the tab.
 */
export function secretChangeWarnings(
  restoredFields: readonly RestoredField[],
  flow: Record<string, unknown>,
  liveFlows: readonly Record<string, unknown>[],
  patterns: readonly string[] = currentSecretNamePatterns()
): SecretChangeWarning[] {
  const ids = [...new Set(restoredFields.map(f => f.nodeId))];
  const tabId = String(flow.id);
  const live: NodeMap = new Map();
  for (const n of liveFlows) if (isPlainObject(n) && typeof n.id === 'string') live.set(n.id, n);
  const proposed = proposedNodeMap(flow, tabId);
  const out: SecretChangeWarning[] = [];
  const flagged = new Set<string>();
  for (const id of ids) {
    const before = live.get(id);
    const after = proposed.get(id);
    if (!before || !after) continue;
    out.push(...secretNodeWarnings(id, restoredFieldList(restoredFields, id), before, after));
    out.push(...scopeWarnings(id, before, live, proposed, tabId, flagged));
  }
  out.push(...tabWarnings(ids, live, proposed, tabId, createSecretNameMatcher(patterns)));
  return out;
}
