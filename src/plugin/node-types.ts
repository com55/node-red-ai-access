/**
 * Installed palette node-type discovery + unknown-type validation.
 *
 * Read-only: lists types from Node-RED's node catalogue and parses HTML
 * registerType defaults when available. Never installs packages.
 */

import { createRequire } from 'node:module';

import type { FlowTab } from '../runtime/types.js';

import { AiOpsValidationError } from './ai-ops.js';

/** Built-in structural types that are always known (not palette modules). */
export const STRUCTURAL_NODE_TYPES = new Set(['tab', 'subflow', 'group', 'junction']);

export const DEFAULT_NODE_TYPE_LIST_CAP = 100;
export const DEFAULT_PALETTE_SEARCH_CAP = 30;
export const PALETTE_HINT =
  'Recommend only — ask the user to install via Manage palette, then recheck node-types. This API never installs.';

const DEFAULT_CATALOGUE_URL = 'https://catalogue.nodered.org/catalogue.json';
const CATALOGUE_CACHE_TTL_MS = 60 * 60 * 1000;

/** Common core types used when tests inject a FlowAdapter without a node-types mock. */
export const COMMON_TEST_NODE_TYPES = [
  'inject',
  'debug',
  'function',
  'template',
  'comment',
  'change',
  'switch',
  'delay',
  'trigger',
  'link in',
  'link out',
  'link call',
  'mqtt in',
  'mqtt out',
  'http in',
  'http response',
  'http request',
  'websocket in',
  'websocket out',
  'tcp in',
  'tcp out',
  'udp in',
  'udp out',
  'catch',
  'status',
  'complete',
  'join',
  'split',
  'sort',
  'batch',
  'csv',
  'html',
  'json',
  'xml',
  'yaml',
  'file',
  'file in',
  'watch',
  'exec',
  'range',
  'rbe',
] as const;

export interface NodeSetInfo {
  id: string;
  module: string;
  version?: string;
  types: string[];
  enabled?: boolean;
  name?: string;
}

export interface NodeTypesAdapter {
  listNodeSets(): Promise<NodeSetInfo[]>;
  getNodeConfigHtml?(setId: string, lang?: string): Promise<string | null>;
}

export interface NodeTypeListItem {
  type: string;
  module: string;
  category?: string;
  description?: string;
  enabled?: boolean;
  version?: string;
  setId?: string;
}

export interface NodeTypeDetail {
  type: string;
  module: string;
  setId?: string;
  version?: string;
  enabled?: boolean;
  category?: string;
  color?: string;
  inputs?: number;
  outputs?: number;
  properties?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  requiredConfigNodeTypes?: string[];
  help?: string;
}

export interface ListNodeTypesResult {
  types: NodeTypeListItem[];
  total: number;
  truncated: boolean;
  q?: string;
}

export interface CatalogueModule {
  id: string;
  description?: string;
  updated_at?: string;
  version?: string;
  keywords?: string[];
  url?: string;
  downloads?: number;
}

export interface CatalogueJson {
  modules?: CatalogueModule[];
  [key: string]: unknown;
}

export type CatalogueFetcher = (
  url: string,
  etag?: string
) => Promise<{
  status: number;
  etag?: string;
  body?: CatalogueJson | null;
}>;

export interface PaletteSearchItem {
  module: string;
  description?: string;
  version?: string;
  updated?: string;
  downloads?: number;
  link?: string;
  installed: boolean;
}

export interface PaletteSearchResult {
  q: string;
  modules: PaletteSearchItem[];
  total: number;
  truncated: boolean;
  hint: string;
}

export function isStructuralNodeType(type: string): boolean {
  if (!type) {
    return false;
  }
  if (STRUCTURAL_NODE_TYPES.has(type)) {
    return true;
  }
  return type.startsWith('subflow:');
}

/** Simple Levenshtein distance for nearest-type hints. */
export function editDistance(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  if (s === t) {
    return 0;
  }
  const m = s.length;
  const n = t.length;
  if (m === 0) {
    return n;
  }
  if (n === 0) {
    return m;
  }
  const prev = new Array<number>(n + 1);
  const cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) {
    prev[j] = j;
  }
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    const si = s.charAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = si === t.charAt(j - 1) ? 0 : 1;
      cur[j] = Math.min((cur[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    for (let j = 0; j <= n; j++) {
      prev[j] = cur[j] ?? 0;
    }
  }
  return prev[n] ?? n;
}

function sharedPrefixLength(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  const lim = Math.min(s.length, t.length);
  let i = 0;
  while (i < lim && s.charAt(i) === t.charAt(i)) {
    i += 1;
  }
  return i;
}

/** Rank installed type names nearest to `type` (edit distance, then shared prefix). */
export function nearestNodeTypes(type: string, candidates: string[], limit = 5): string[] {
  const scored = candidates
    .filter(c => c !== type)
    .map(c => ({
      c,
      dist: editDistance(type, c),
      prefix: sharedPrefixLength(type, c),
    }))
    .sort((a, b) => a.dist - b.dist || b.prefix - a.prefix || a.c.localeCompare(b.c));
  return scored.slice(0, limit).map(s => s.c);
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function createPluginRequire(): NodeRequire {
  if (typeof require === 'function') {
    return require;
  }
  const metaUrl = (0, eval)('import.meta.url') as string;
  return createRequire(metaUrl);
}

function isRuntimeSettingsAvailable(): boolean {
  try {
    const req = createPluginRequire();
    const settings = req('@node-red/runtime/lib/settings') as { available?: () => boolean };
    return typeof settings.available === 'function' && settings.available() === true;
  } catch {
    return false;
  }
}

function normalizeNodeSet(raw: Record<string, unknown>): NodeSetInfo | null {
  const typesRaw = raw.types;
  const types = Array.isArray(typesRaw)
    ? typesRaw.filter((t): t is string => typeof t === 'string' && t.length > 0)
    : [];
  let module = '';
  if (typeof raw.module === 'string' && raw.module) {
    module = raw.module;
  } else if (typeof raw.name === 'string' && raw.name) {
    module = raw.name;
  } else if (typeof raw.id === 'string') {
    const head = String(raw.id).split('/')[0];
    module = head && head.length > 0 ? head : String(raw.id);
  }
  const id =
    typeof raw.id === 'string' && raw.id
      ? raw.id
      : types.length === 1 && module
        ? `${module}/${types[0]}`
        : module;
  if (!id || types.length === 0) {
    return null;
  }
  const info: NodeSetInfo = { id, module: module.length > 0 ? module : id, types };
  if (typeof raw.version === 'string') {
    info.version = raw.version;
  }
  if (typeof raw.enabled === 'boolean') {
    info.enabled = raw.enabled;
  }
  if (typeof raw.name === 'string') {
    info.name = raw.name;
  }
  return info;
}

/** Static adapter for unit tests (no network / runtime). */
export function createStaticNodeTypesAdapter(
  types: readonly string[] = COMMON_TEST_NODE_TYPES,
  options: { module?: string; version?: string; configs?: Record<string, string> } = {}
): NodeTypesAdapter {
  const module = options.module ?? 'node-red';
  const version = options.version ?? '4.0.0';
  const list: string[] = [...types];
  const configs = options.configs ?? {};
  return {
    listNodeSets(): Promise<NodeSetInfo[]> {
      return Promise.resolve([
        {
          id: module,
          module,
          version,
          types: list,
          enabled: true,
          name: module,
        },
      ]);
    },
    getNodeConfigHtml(setId: string): Promise<string | null> {
      if (configs[setId]) {
        return Promise.resolve(configs[setId] ?? null);
      }
      // setId may be module/type
      const type = setId.includes('/') ? setId.slice(setId.lastIndexOf('/') + 1) : setId;
      if (configs[type]) {
        return Promise.resolve(configs[type] ?? null);
      }
      return Promise.resolve(null);
    },
  };
}

/**
 * HTTP Admin API adapter — GET /nodes (JSON) + optional HTML config per set.
 */
export class HttpNodeTypesAdapter implements NodeTypesAdapter {
  private readonly baseUrl: string;
  private readonly accessToken: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { baseUrl: string; accessToken?: string; fetch?: typeof fetch }) {
    this.baseUrl = trimTrailingSlash(options.baseUrl);
    this.accessToken = options.accessToken;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private headers(accept: string): Headers {
    const headers = new Headers();
    headers.set('Accept', accept);
    if (this.accessToken) {
      headers.set('Authorization', `Bearer ${this.accessToken}`);
    }
    return headers;
  }

  async listNodeSets(): Promise<NodeSetInfo[]> {
    const response = await this.fetchImpl(`${this.baseUrl}/nodes`, {
      headers: this.headers('application/json'),
    });
    if (!response.ok) {
      throw new Error(`Admin API GET /nodes failed (${response.status})`);
    }
    const body = (await response.json()) as unknown;
    if (!Array.isArray(body)) {
      throw new Error('Admin API GET /nodes returned non-array JSON');
    }
    const sets: NodeSetInfo[] = [];
    for (const entry of body) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        continue;
      }
      const normalized = normalizeNodeSet(entry as Record<string, unknown>);
      if (normalized) {
        sets.push(normalized);
      }
    }
    return sets;
  }

  async getNodeConfigHtml(setId: string, lang?: string): Promise<string | null> {
    const encoded = setId
      .split('/')
      .map(p => encodeURIComponent(p))
      .join('/');
    const qs = lang ? `?lang=${encodeURIComponent(lang)}` : '';
    const response = await this.fetchImpl(`${this.baseUrl}/nodes/${encoded}${qs}`, {
      headers: this.headers('text/html'),
    });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      return null;
    }
    return response.text();
  }
}

/**
 * Public `@node-red/runtime`.nodes is the Admin API mixin (expects `{ user, req }`).
 * Low-level registry helpers take `(id, lang)` — support both shapes.
 */
interface RuntimeNodesApi {
  getNodeList?: ((opts?: { user?: unknown; req?: unknown }) => unknown) | (() => unknown);
  getNodeConfig?:
    | ((opts: { id: string; lang?: string; user?: unknown; req?: unknown }) => unknown)
    | ((id: string, lang?: string) => unknown);
}

const EMPTY_API_OPTS = { user: null, req: null };

/** In-process adapter over `@node-red/runtime`.nodes when settings.available(). */
export class RedNodeTypesAdapter implements NodeTypesAdapter {
  constructor(private readonly nodes: RuntimeNodesApi) {}

  async listNodeSets(): Promise<NodeSetInfo[]> {
    if (typeof this.nodes.getNodeList !== 'function') {
      return [];
    }
    let list: unknown;
    const getList = this.nodes.getNodeList;
    try {
      // API mixin: getNodeList(opts). Low-level: getNodeList() / filter fn.
      list = await Promise.resolve(getList(EMPTY_API_OPTS));
    } catch {
      try {
        list = await Promise.resolve(getList());
      } catch {
        return [];
      }
    }
    if (!Array.isArray(list)) {
      return [];
    }
    const sets: NodeSetInfo[] = [];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        continue;
      }
      const normalized = normalizeNodeSet(entry as Record<string, unknown>);
      if (normalized) {
        sets.push(normalized);
      }
    }
    return sets;
  }

  async getNodeConfigHtml(setId: string, lang?: string): Promise<string | null> {
    if (typeof this.nodes.getNodeConfig !== 'function') {
      return null;
    }
    try {
      const html = await Promise.resolve(
        (this.nodes.getNodeConfig as (opts: Record<string, unknown>) => unknown)({
          id: setId,
          lang: lang ?? 'en-US',
          ...EMPTY_API_OPTS,
        })
      );
      if (typeof html === 'string' && html.length > 0) {
        return html;
      }
    } catch {
      // try low-level (id, lang)
    }
    try {
      const html = await Promise.resolve(
        (this.nodes.getNodeConfig as (id: string, lang?: string) => unknown)(setId, lang)
      );
      return typeof html === 'string' && html.length > 0 ? html : null;
    } catch {
      return null;
    }
  }
}

export interface CreateNodeTypesAdapterOptions {
  baseUrl?: string;
  accessToken?: string;
  fetch?: typeof fetch;
}

/**
 * Prefer in-process runtime.nodes when initialized; else HTTP Admin /nodes.
 */
export function createNodeTypesAdapter(
  options: CreateNodeTypesAdapterOptions = {}
): NodeTypesAdapter {
  if (isRuntimeSettingsAvailable()) {
    try {
      const req = createPluginRequire();
      const runtime = req('@node-red/runtime') as { nodes?: RuntimeNodesApi };
      if (runtime.nodes && typeof runtime.nodes.getNodeList === 'function') {
        return new RedNodeTypesAdapter(runtime.nodes);
      }
    } catch {
      // fall through to HTTP
    }
  }
  if (options.baseUrl) {
    return new HttpNodeTypesAdapter({
      baseUrl: options.baseUrl,
      ...(options.accessToken ? { accessToken: options.accessToken } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }
  throw new Error('No usable NodeTypesAdapter: runtime.nodes unavailable and no HTTP baseUrl');
}

async function flattenInstalledTypes(adapter: NodeTypesAdapter): Promise<{
  byType: Map<string, NodeTypeListItem>;
  allNames: string[];
}> {
  const sets = await adapter.listNodeSets();
  const byType = new Map<string, NodeTypeListItem>();
  for (const set of sets) {
    for (const type of set.types) {
      if (byType.has(type)) {
        continue;
      }
      const item: NodeTypeListItem = {
        type,
        module: set.module,
        setId: set.id,
      };
      if (typeof set.enabled === 'boolean') {
        item.enabled = set.enabled;
      }
      if (set.version) {
        item.version = set.version;
      }
      byType.set(type, item);
    }
  }
  return { byType, allNames: [...byType.keys()] };
}

function matchesQuery(item: NodeTypeListItem, q: string): boolean {
  const needle = q.toLowerCase();
  const hay = [item.type, item.module, item.category ?? '', item.description ?? '']
    .join('\n')
    .toLowerCase();
  return hay.includes(needle);
}

/**
 * List installed palette types, optionally filtered by `q`.
 */
export async function listNodeTypes(
  adapter: NodeTypesAdapter,
  options: { q?: string; limit?: number } = {}
): Promise<ListNodeTypesResult> {
  const limit = options.limit ?? DEFAULT_NODE_TYPE_LIST_CAP;
  const { byType } = await flattenInstalledTypes(adapter);
  let items = [...byType.values()].sort((a, b) => a.type.localeCompare(b.type));
  const q = options.q?.trim();
  if (q) {
    items = items.filter(item => matchesQuery(item, q));
  }
  const total = items.length;
  const truncated = total > limit;
  const types = items.slice(0, limit);
  const result: ListNodeTypesResult = { types, total, truncated };
  if (q) {
    result.q = q;
  }
  return result;
}

/**
 * Extract the inner HTML of `<script data-help-name="type">…</script>` without
 * a fragile `</script>` regex (CodeQL: Bad HTML filtering regexp).
 */
function extractHelpScriptBody(html: string, type: string): string | null {
  const needle = `data-help-name="${type}"`;
  const needleSq = `data-help-name='${type}'`;
  const lower = html.toLowerCase();
  let searchFrom = 0;
  while (searchFrom < html.length) {
    const dq = html.indexOf(needle, searchFrom);
    const sq = html.indexOf(needleSq, searchFrom);
    let attrAt = -1;
    if (dq >= 0 && (sq < 0 || dq < sq)) {
      attrAt = dq;
    } else if (sq >= 0) {
      attrAt = sq;
    }
    if (attrAt < 0) {
      return null;
    }
    const scriptOpen = lower.lastIndexOf('<script', attrAt);
    if (scriptOpen < 0 || scriptOpen < searchFrom) {
      searchFrom = attrAt + 1;
      continue;
    }
    const openEnd = html.indexOf('>', attrAt);
    if (openEnd < 0) {
      return null;
    }
    const closeStart = lower.indexOf('</script', openEnd + 1);
    if (closeStart < 0) {
      return null;
    }
    let j = closeStart + '</script'.length;
    while (j < html.length && /\s/.test(html.charAt(j))) {
      j += 1;
    }
    if (html.charAt(j) !== '>') {
      searchFrom = closeStart + 1;
      continue;
    }
    return html.slice(openEnd + 1, closeStart);
  }
  return null;
}

/**
 * Remove paired HTML blocks (`script` / `style`) without fragile end-tag regexes.
 * Accepts optional whitespace before `>` on the closing tag (e.g. `</script >`).
 */
function removeHtmlBlocks(html: string, tag: string): string {
  const open = `<${tag}`;
  const close = `</${tag}`;
  let out = '';
  let i = 0;
  const lower = html.toLowerCase();
  while (i < html.length) {
    const start = lower.indexOf(open, i);
    if (start < 0) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, start);
    const openEnd = html.indexOf('>', start);
    if (openEnd < 0) {
      break;
    }
    const closeStart = lower.indexOf(close, openEnd + 1);
    if (closeStart < 0) {
      break;
    }
    let j = closeStart + close.length;
    while (j < html.length && /\s/.test(html.charAt(j))) {
      j += 1;
    }
    if (html.charAt(j) === '>') {
      i = j + 1;
      out += ' ';
    } else {
      i = closeStart + close.length;
    }
  }
  return out;
}

/**
 * Lightly strip HTML tags and collapse whitespace for help text.
 * Does not HTML-unescape entities (avoids double-unescape of `&amp;…`).
 */
export function stripHelpText(raw: string, maxLen = 2000): string {
  let text = removeHtmlBlocks(raw, 'script');
  text = removeHtmlBlocks(text, 'style');
  text = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/[#*_`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > maxLen) {
    text = `${text.slice(0, maxLen - 1)}…`;
  }
  return text;
}

/**
 * Parse RED.nodes.registerType('type', { … }) from node HTML config.
 * Best-effort: failures return null (caller still returns metadata).
 */
export function parseRegisterTypeFromHtml(
  html: string,
  expectedType?: string
): {
  type: string;
  category?: string;
  color?: string;
  inputs?: number;
  outputs?: number;
  defaults?: Record<string, unknown>;
  properties?: Record<string, unknown>;
  requiredConfigNodeTypes?: string[];
  help?: string;
} | null {
  try {
    const typeMatch = /RED\.nodes\.registerType\s*\(\s*['"]([^'"]+)['"]\s*,\s*\{/.exec(html);
    if (!typeMatch?.[1]) {
      return null;
    }
    const type = typeMatch[1];
    if (expectedType && type !== expectedType) {
      // HTML may contain multiple registerType calls; try to find the right one.
      const re = /RED\.nodes\.registerType\s*\(\s*['"]([^'"]+)['"]\s*,\s*\{/g;
      let found: RegExpExecArray | null;
      let matchedType: string | null = null;
      let matchIndex = -1;
      while ((found = re.exec(html)) !== null) {
        if (found[1] === expectedType) {
          matchedType = found[1];
          matchIndex = found.index;
          break;
        }
      }
      if (!matchedType || matchIndex < 0) {
        return null;
      }
      return parseRegisterTypeAt(html, matchIndex, matchedType);
    }
    return parseRegisterTypeAt(html, typeMatch.index, type);
  } catch {
    return null;
  }
}

function parseRegisterTypeAt(
  html: string,
  startIndex: number,
  type: string
): ReturnType<typeof parseRegisterTypeFromHtml> {
  const from = html.slice(startIndex);
  const braceStart = from.indexOf('{');
  if (braceStart < 0) {
    return { type };
  }
  const objectText = extractBalancedObject(from.slice(braceStart));
  if (!objectText) {
    return { type };
  }

  const category = matchStringProp(objectText, 'category');
  const color = matchStringProp(objectText, 'color');
  const inputs = matchNumberProp(objectText, 'inputs');
  const outputs = matchNumberProp(objectText, 'outputs');
  const defaults = parseDefaultsBlock(objectText);
  const requiredConfigNodeTypes: string[] = [];
  if (defaults) {
    for (const value of Object.values(defaults)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const t = (value as { type?: unknown }).type;
        if (typeof t === 'string' && t.length > 0) {
          requiredConfigNodeTypes.push(t);
        }
      }
    }
  }

  let help: string | undefined;
  const helpBody = extractHelpScriptBody(html, type);
  if (helpBody) {
    help = stripHelpText(helpBody);
  }

  const result: NonNullable<ReturnType<typeof parseRegisterTypeFromHtml>> = { type };
  if (category) {
    result.category = category;
  }
  if (color) {
    result.color = color;
  }
  if (inputs !== undefined) {
    result.inputs = inputs;
  }
  if (outputs !== undefined) {
    result.outputs = outputs;
  }
  if (defaults) {
    result.defaults = defaults;
    result.properties = defaults;
  }
  if (requiredConfigNodeTypes.length > 0) {
    result.requiredConfigNodeTypes = [...new Set(requiredConfigNodeTypes)];
  }
  if (help) {
    result.help = help;
  }
  return result;
}

function extractBalancedObject(text: string): string | null {
  if (!text.startsWith('{')) {
    return null;
  }
  let depth = 0;
  let inStr: '"' | "'" | '`' | null = null;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === inStr) {
        inStr = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
      continue;
    }
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(0, i + 1);
      }
    }
  }
  return null;
}

function matchStringProp(objectText: string, key: string): string | undefined {
  const re = new RegExp(`\\b${key}\\s*:\\s*['"]([^'"]+)['"]`);
  const m = objectText.match(re);
  return m?.[1];
}

function matchNumberProp(objectText: string, key: string): number | undefined {
  const re = new RegExp(`\\b${key}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`);
  const m = objectText.match(re);
  if (!m?.[1]) {
    return undefined;
  }
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse a defaults: { … } block into a shallow map of property descriptors.
 * Values are best-effort JSON-ish (value/type/required) — never throws hard.
 */
function parseDefaultsBlock(objectText: string): Record<string, unknown> | undefined {
  const idx = objectText.search(/\bdefaults\s*:/);
  if (idx < 0) {
    return undefined;
  }
  const after = objectText.slice(idx);
  const brace = after.indexOf('{');
  if (brace < 0) {
    return undefined;
  }
  const block = extractBalancedObject(after.slice(brace));
  if (!block) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  // Match `propName: { ... }` entries at depth 1 inside defaults.
  const propRe = /([a-zA-Z_$][\w$]*)\s*:\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = propRe.exec(block)) !== null) {
    const name = m[1];
    if (!name || name === 'defaults') {
      continue;
    }
    const obj = extractBalancedObject(block.slice(m.index + m[0].length - 1));
    if (!obj) {
      continue;
    }
    const desc: Record<string, unknown> = {};
    const typeM = /\btype\s*:\s*['"]([^'"]+)['"]/.exec(obj);
    if (typeM?.[1]) {
      desc.type = typeM[1];
    }
    if (/\brequired\s*:\s*true\b/.test(obj)) {
      desc.required = true;
    }
    const valueM = /\bvalue\s*:\s*/.exec(obj);
    if (valueM) {
      const rest = obj.slice(valueM.index + valueM[0].length).trimStart();
      desc.value = parseLooseValue(rest);
    }
    out[name] = desc;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseLooseValue(rest: string): unknown {
  if (rest.startsWith("'") || rest.startsWith('"')) {
    const q = rest[0];
    let i = 1;
    let out = '';
    while (i < rest.length) {
      const ch = rest[i];
      if (ch === '\\' && i + 1 < rest.length) {
        out += rest[i + 1];
        i += 2;
        continue;
      }
      if (ch === q) {
        break;
      }
      out += ch;
      i += 1;
    }
    return out;
  }
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']');
    if (end > 0) {
      try {
        return JSON.parse(rest.slice(0, end + 1).replace(/'/g, '"')) as unknown;
      } catch {
        return rest.slice(0, end + 1);
      }
    }
  }
  if (rest.startsWith('{')) {
    const obj = extractBalancedObject(rest);
    return obj ?? undefined;
  }
  const num = /^-?\d+(?:\.\d+)?/.exec(rest);
  if (num) {
    return Number(num[0]);
  }
  if (rest.startsWith('true')) {
    return true;
  }
  if (rest.startsWith('false')) {
    return false;
  }
  if (rest.startsWith('null')) {
    return null;
  }
  return undefined;
}

function findSetForType(
  sets: NodeSetInfo[],
  type: string
): { set: NodeSetInfo; setId: string } | null {
  for (const set of sets) {
    if (set.types.includes(type)) {
      // Prefer module/type id when set id is the module alone.
      const setId =
        set.id.includes('/') || set.types.length === 1 ? set.id : `${set.module}/${type}`;
      return { set, setId };
    }
  }
  return null;
}

/**
 * Detail for one installed type. 404-style AiOpsValidationError when unknown.
 */
export async function getNodeTypeDetail(
  adapter: NodeTypesAdapter,
  type: string
): Promise<NodeTypeDetail> {
  if (!type || typeof type !== 'string') {
    throw new AiOpsValidationError('Missing node type', 'missing_node_type');
  }
  if (isStructuralNodeType(type)) {
    const detail: NodeTypeDetail = {
      type,
      module: 'node-red',
      category: 'config',
      help: 'Built-in structural Node-RED type (not a palette node).',
    };
    return detail;
  }

  const sets = await adapter.listNodeSets();
  const found = findSetForType(sets, type);
  if (!found) {
    const allNames = sets.flatMap(s => s.types);
    throw new AiOpsValidationError(`Node type '${type}' was not found`, 'node_type_not_found', {
      statusCode: 404,
      details: { type, nearest: nearestNodeTypes(type, allNames, 5) },
    });
  }

  const detail: NodeTypeDetail = {
    type,
    module: found.set.module,
    setId: found.setId,
  };
  if (found.set.version) {
    detail.version = found.set.version;
  }
  if (typeof found.set.enabled === 'boolean') {
    detail.enabled = found.set.enabled;
  }

  if (typeof adapter.getNodeConfigHtml === 'function') {
    try {
      const html =
        (await adapter.getNodeConfigHtml(found.setId)) ??
        (await adapter.getNodeConfigHtml(`${found.set.module}/${type}`)) ??
        (await adapter.getNodeConfigHtml(type));
      if (html) {
        const parsed = parseRegisterTypeFromHtml(html, type);
        if (parsed) {
          if (parsed.category) {
            detail.category = parsed.category;
          }
          if (parsed.color) {
            detail.color = parsed.color;
          }
          if (parsed.inputs !== undefined) {
            detail.inputs = parsed.inputs;
          }
          if (parsed.outputs !== undefined) {
            detail.outputs = parsed.outputs;
          }
          if (parsed.defaults) {
            detail.defaults = parsed.defaults;
            detail.properties = parsed.properties ?? parsed.defaults;
          }
          if (parsed.requiredConfigNodeTypes) {
            detail.requiredConfigNodeTypes = parsed.requiredConfigNodeTypes;
          }
          if (parsed.help) {
            detail.help = parsed.help;
          }
        }
      }
    } catch {
      // Parsing/HTML failures must not crash — return metadata only.
    }
  }

  return detail;
}

function collectFlowNodeTypes(flow: Partial<FlowTab> | Record<string, unknown>): string[] {
  const types: string[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      return;
    }
    const n = node as Record<string, unknown>;
    if (typeof n.type === 'string' && n.type) {
      types.push(n.type);
    }
    if (Array.isArray(n.nodes)) {
      for (const child of n.nodes) {
        visit(child);
      }
    }
    if (Array.isArray(n.configs)) {
      for (const child of n.configs) {
        visit(child);
      }
    }
  };
  visit(flow);
  if (Array.isArray((flow as FlowTab).nodes)) {
    for (const n of (flow as FlowTab).nodes ?? []) {
      visit(n);
    }
  }
  if (Array.isArray((flow as FlowTab).configs)) {
    for (const n of (flow as FlowTab).configs ?? []) {
      visit(n);
    }
  }
  return types;
}

/**
 * Ensure every non-structural node.type in the flow is installed.
 */
export async function assertKnownNodeTypes(
  adapter: NodeTypesAdapter,
  flow: Partial<FlowTab> | Record<string, unknown>
): Promise<void> {
  const { allNames } = await flattenInstalledTypes(adapter);
  const installed = new Set(allNames);
  const seen = new Set<string>();
  for (const type of collectFlowNodeTypes(flow)) {
    if (seen.has(type) || isStructuralNodeType(type)) {
      continue;
    }
    seen.add(type);
    if (!installed.has(type)) {
      throw new AiOpsValidationError(
        `Unknown node type '${type}'. Call node-types / palette search; ask the user to install via Manage palette, then recheck.`,
        'unknown_node_type',
        {
          details: {
            type,
            nearest: nearestNodeTypes(type, allNames, 5),
          },
        }
      );
    }
  }
}

/**
 * Assert a single type is installed (for flow-patch op:add).
 */
export async function assertKnownNodeType(adapter: NodeTypesAdapter, type: string): Promise<void> {
  if (isStructuralNodeType(type)) {
    return;
  }
  const { allNames } = await flattenInstalledTypes(adapter);
  if (allNames.includes(type)) {
    return;
  }
  throw new AiOpsValidationError(
    `Unknown node type '${type}'. Call node-types / palette search; ask the user to install via Manage palette, then recheck.`,
    'unknown_node_type',
    {
      details: {
        type,
        nearest: nearestNodeTypes(type, allNames, 5),
      },
    }
  );
}

interface CatalogueCacheEntry {
  fetchedAt: number;
  etag?: string;
  body: CatalogueJson;
}

let catalogueCache: CatalogueCacheEntry | null = null;

/** Reset in-memory catalogue cache (tests). */
export function resetCatalogueCache(): void {
  catalogueCache = null;
}

async function defaultCatalogueFetcher(
  url: string,
  etag?: string
): Promise<{ status: number; etag?: string; body?: CatalogueJson | null }> {
  const headers = new Headers({ Accept: 'application/json' });
  if (etag) {
    headers.set('If-None-Match', etag);
  }
  const response = await fetch(url, { headers });
  const nextEtag = response.headers.get('etag') ?? undefined;
  if (response.status === 304) {
    return { status: 304, ...(nextEtag ? { etag: nextEtag } : {}) };
  }
  if (!response.ok) {
    return { status: response.status, body: null, ...(nextEtag ? { etag: nextEtag } : {}) };
  }
  const body = (await response.json()) as CatalogueJson;
  return { status: response.status, body, ...(nextEtag ? { etag: nextEtag } : {}) };
}

async function loadCatalogue(
  fetcher: CatalogueFetcher,
  catalogueUrl: string
): Promise<CatalogueJson> {
  const now = Date.now();
  if (catalogueCache && now - catalogueCache.fetchedAt < CATALOGUE_CACHE_TTL_MS) {
    return catalogueCache.body;
  }
  const prevEtag = catalogueCache?.etag;
  const result = await fetcher(catalogueUrl, prevEtag);
  if (result.status === 304 && catalogueCache) {
    catalogueCache = {
      ...catalogueCache,
      fetchedAt: now,
      ...(result.etag ? { etag: result.etag } : {}),
    };
    return catalogueCache.body;
  }
  if (!result.body || !Array.isArray(result.body.modules)) {
    if (catalogueCache) {
      return catalogueCache.body;
    }
    throw new AiOpsValidationError('Node-RED catalogue unavailable', 'catalogue_unavailable', {
      statusCode: 502,
    });
  }
  catalogueCache = {
    fetchedAt: now,
    body: result.body,
    ...(result.etag ? { etag: result.etag } : {}),
  };
  return result.body;
}

/**
 * Search the public Node-RED catalogue (recommend only — never installs).
 */
export async function searchPalette(
  adapter: NodeTypesAdapter,
  q: string,
  options: {
    limit?: number;
    catalogueUrl?: string;
    catalogueFetcher?: CatalogueFetcher;
  } = {}
): Promise<PaletteSearchResult> {
  const query = q.trim();
  if (!query) {
    throw new AiOpsValidationError('q query parameter is required', 'missing_query');
  }
  const limit = options.limit ?? DEFAULT_PALETTE_SEARCH_CAP;
  const catalogueUrl = options.catalogueUrl ?? DEFAULT_CATALOGUE_URL;
  const fetcher = options.catalogueFetcher ?? defaultCatalogueFetcher;
  const catalogue = await loadCatalogue(fetcher, catalogueUrl);
  const modules = Array.isArray(catalogue.modules) ? catalogue.modules : [];

  const sets = await adapter.listNodeSets();
  const installedModules = new Set(sets.map(s => s.module));

  const needle = query.toLowerCase();
  const hits: PaletteSearchItem[] = [];
  for (const mod of modules) {
    const hay = [mod.id, mod.description ?? '', ...(mod.keywords ?? [])].join('\n').toLowerCase();
    if (!hay.includes(needle)) {
      continue;
    }
    const item: PaletteSearchItem = {
      module: mod.id,
      installed: installedModules.has(mod.id),
    };
    if (typeof mod.description === 'string') {
      item.description = mod.description;
    }
    if (typeof mod.version === 'string') {
      item.version = mod.version;
    }
    if (typeof mod.updated_at === 'string') {
      item.updated = mod.updated_at;
    }
    if (typeof mod.downloads === 'number') {
      item.downloads = mod.downloads;
    }
    if (typeof mod.url === 'string') {
      item.link = mod.url;
    }
    hits.push(item);
  }

  const total = hits.length;
  const truncated = total > limit;
  return {
    q: query,
    modules: hits.slice(0, limit),
    total,
    truncated,
    hint: PALETTE_HINT,
  };
}
