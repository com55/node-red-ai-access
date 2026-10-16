/** CSS for the /mcp admin page. */

import { DIFF_SPLIT_MIN_PX } from './diff-ui.js';

function pageStylesPartA(): string {
  return `
:root {
  color-scheme: light;
  --bg: #eef2f5;
  --ink: #1a2330;
  --muted: #5a6a7a;
  --accent: #0a5c45;
  --accent-soft: #dceee7;
  --warn-bg: #fff7eb;
  --warn-border: #d9a15b;
  --danger: #9b2c2c;
  --card: #ffffff;
  --line: #cfd8e3;
  --ok: #1b6b4a;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: "Source Sans 3", "Segoe UI", sans-serif;
  background:
    radial-gradient(ellipse at 0% 0%, #d4ebe2 0%, transparent 45%),
    linear-gradient(165deg, #e8eef3 0%, var(--bg) 55%, #e4ebe6 100%);
  color: var(--ink);
  min-height: 100vh;
}
main {
  width: 100%;
  max-width: min(1400px, 95vw);
  margin: 0 auto;
  padding: 2.25rem clamp(0.85rem, 2.5vw, 1.75rem) 3.5rem;
}
h1 {
  font-size: clamp(1.85rem, 3.5vw, 2.45rem);
  letter-spacing: -0.03em;
  margin: 0 0 0.35rem;
}
.lede {
  color: var(--muted);
  font-size: 1.02rem;
  line-height: 1.5;
  margin: 0 0 0.85rem;
}
.how-it-works {
  margin: 0 0 1.25rem;
  padding: 0.75rem 0.9rem 0.75rem 1.6rem;
  background: var(--accent-soft);
  border-radius: 8px;
  color: var(--ink);
  line-height: 1.45;
  font-size: 0.95rem;
}
.how-it-works li { margin: 0.2rem 0; }
.how-it-works strong { color: var(--accent); }
.auth-gate {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 1.25rem 1.35rem;
  margin-bottom: 1rem;
}
.auth-gate h2 { margin: 0 0 0.4rem; font-size: 1.2rem; }
.auth-gate a.action {
  display: inline-block;
  text-decoration: none;
  text-align: center;
}
`;
}

function pageStylesPartA2(): string {
  return `
nav.tabs {
  position: sticky;
  top: 0;
  z-index: 40;
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin: 0 0 1.1rem;
  padding: 0.55rem 0;
  background: var(--bg);
  border-bottom: 1px solid transparent;
  transition: box-shadow 0.15s ease, border-color 0.15s ease;
}
nav.tabs.is-stuck {
  box-shadow: 0 4px 12px rgba(26, 35, 48, 0.08);
  border-bottom-color: var(--line);
  background: #f3f6f8;
}
nav.tabs button {
  border: 1px solid var(--line);
  background: var(--card);
  color: var(--ink);
  padding: 0.4rem 0.85rem;
  border-radius: 8px;
  cursor: pointer;
  font: inherit;
}
nav.tabs button[aria-selected="true"] {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.tab-badge {
  display: inline-block;
  margin-left: 0.25rem;
  min-width: 1.15rem;
  max-width: 14rem;
  padding: 0.05rem 0.45rem;
  border-radius: 999px;
  background: #fff;
  color: var(--accent);
  font-size: 0.72rem;
  font-weight: 700;
  line-height: 1.25;
  vertical-align: middle;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
nav.tabs button[aria-selected="true"] .tab-badge {
  background: rgba(255, 255, 255, 0.92);
  color: var(--accent);
}
section.panel {
  display: none;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 1.15rem 1.25rem 1.35rem;
}
section.panel.active { display: block; }
section.panel h2 {
  margin: 0 0 0.75rem;
  font-size: 1.15rem;
}
.warning {
  background: var(--warn-bg);
  border: 1px solid var(--warn-border);
  border-radius: 10px;
  padding: 0.95rem 1.1rem;
  margin-bottom: 1.15rem;
}
.warning h2 { margin: 0 0 0.35rem; font-size: 1.05rem; }
.warning p { margin: 0; line-height: 1.45; }
dl.status {
  display: grid;
  grid-template-columns: 11rem 1fr;
  gap: 0.45rem 1rem;
  margin: 0;
}
dt { color: var(--muted); }
dd {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.9rem;
  word-break: break-all;
}
.badge {
  display: inline-block;
  margin-top: 0.9rem;
  padding: 0.22rem 0.55rem;
  border-radius: 6px;
  cursor: help;
  background: var`;
}

function pageStylesPartB(): string {
  return `(--accent-soft);
  color: var(--accent);
  font-size: 0.82rem;
  font-weight: 650;
}
.muted { color: var(--muted); font-size: 0.92rem; }
.empty-state {
  padding: 1.25rem 0.85rem;
  text-align: left;
  border: 1px dashed var(--line);
  border-radius: 8px;
  background: #f7faf8;
}
.empty-state .empty-title {
  margin: 0 0 0.25rem;
  font-weight: 650;
  color: var(--ink);
}
.empty-state .muted { margin: 0; }
.row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  justify-content: flex-end;
  align-items: center;
}
.links-table { width: 100%; border-collapse: collapse; }
.links-table th, .links-table td {
  text-align: left;
  padding: 0.45rem 0.4rem;
  border-bottom: 1px solid var(--line);
  vertical-align: middle;
}
.kind-badge {
  display: inline-block;
  padding: 0.12rem 0.45rem;
  border-radius: 4px;
  font-size: 0.78rem;
  font-weight: 650;
  white-space: nowrap;
  background: #eef2f0;
  color: #3a4a42;
}
.kind-badge.kind-get_link { background: #e8f1fb; color: #1a4a7a; }
.kind-badge.kind-rest { background: #eef6ea; color: #2a5a28; }
.kind-badge.kind-mcp { background: #f4efe6; color: #6a4a14; }
.token-kind-label {
  margin: 0 0 0.35rem;
  font-weight: 650;
  color: var(--ink);
}
button.action.copied {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}
.row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.55rem;
  align-items: end;
  margin-bottom: 0.85rem;
}
label {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.85rem;
  color: var(--muted);
}
input, select, textarea, button.action {
  font: inherit;
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 0.4rem 0.55rem;
  background: #fff;
  color: var(--ink);
}
textarea { min-height: 4rem; width: min(100%, 28rem); }
button.action {
  cursor: pointer;
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  font-weight: 600;
}
button.action.secondary {
  background: #fff;
  color: var(--ink);
  border-color: var(--line);
}
button.action.danger {
  background: var(--danger);
  border-color: var(--danger);
}
button.action:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
th, td {
  text-align: left;
  padding: 0.45rem 0.35rem;
  border-bottom: 1px solid var(--line);
  vertical-align: top;
}
th { color: var(--muted); font-weight: 600; }
.token-once {
  background: #f4faf7;
  border: 1px dashed var(--accent);
  border-radius: 8px;
  padding: 0.75rem 0.9rem;
  margin: 0.75rem 0;
  word-break: break-all;
}
.token-once strong { display: block; margin-bottom: 0.35rem; }
.token-once .token-copy-block {
  margin: 0.6rem 0;
  padding: 0.55rem 0.65rem;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 6px;
  font-size: 0.8rem;
  white-space: pre-wrap;
  word-break: break-word;
}
.token-once #token-copy-btn { margin-top: 0.35rem; }
.token-once #token-docs-hint { margin: 0.45rem 0 0; }
.flash {
  margin: 0.5rem 0 0.85rem;
  padding: 0.55rem 0.7rem;
  border-radius: 7px;
  font-size: 0.9rem;
}
.flash.error { background: #fdecec; color: var(--danger); }
.flash.ok { background: #e8f6ef; color: var(--ok); }
.proposal-detail {
  margin-top: 0.75rem;
  padding: 0.75rem;
  background: #f7fafc;
  border-radius: 8px;
  border: 1px solid var(--line);
  overflow-wrap: anywhere;
}
.proposal-detail pre {
  margin: 0.4rem 0 0;
  white-space: pre;
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: 0.82rem;
  max-height: 14rem;
  overflow: auto;
}
.readonly-note {
  margin: 0 0 0.85rem;
  color: var(--muted);
  font-size: 0.92rem;
}
`;
}

function pageStylesPartC(): string {
  return `
.logs-toolbar { margin-bottom: 0.65rem; }
table.audit-table {
  table-layout: fixed;
  width: 100%;
}
.audit-table .col-when {
  width: 9.5rem;
  min-width: 9.5rem;
  white-space: nowrap;
  overflow-wrap: normal;
  word-break: normal;
}
.audit-table .col-action {
  width: 6.5rem;
  min-width: 6.5rem;
  white-space: nowrap;
  overflow-wrap: normal;
  word-break: normal;
}
.audit-table .col-actor {
  width: 9rem;
  min-width: 8rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  overflow-wrap: normal;
  word-break: normal;
}
.audit-table .col-details { width: auto; }
.audit-table td.col-details, .audit-table th.col-details {
  overflow-wrap: anywhere;
  word-break: break-word;
  white-space: normal;
}
.action-badge {
  display: inline-block;
  padding: 0.12rem 0.45rem;
  border-radius: 5px;
  font-size: 0.78rem;
  font-weight: 650;
  letter-spacing: 0.01em;
  white-space: nowrap;
  background: #eef2f5;
  color: var(--ink);
}
.action-badge.action-created { background: #e8f1fb; color: #1a4a7a; }
.action-badge.action-approved { background: #e8f6ef; color: var(--ok); }
.action-badge.action-rejected { background: #f4efe6; color: #6a4a14; }
.action-badge.action-failed { background: #fdeceb; color: var(--danger); }
.audit-summary { line-height: 1.4; }
.audit-raw {
  margin-top: 0.25rem;
  font-size: 0.8rem;
}
.audit-raw summary {
  cursor: pointer;
  color: var(--muted);
  user-select: none;
}
.audit-raw pre {
  margin: 0.35rem 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 10rem;
  overflow: auto;
  font-size: 0.78rem;
  background: #f4f7fa;
  padding: 0.4rem 0.5rem;
  border-radius: 6px;
}
.id-short {
  font-size: 0.85em;
  cursor: help;
  border-bottom: 1px dotted var(--line);
}
`;
}

function pageStylesPartD(): string {
  return `
.proposal-diff {
  margin: 0.65rem 0;
  padding: 0.55rem 0.65rem;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 7px;
  overflow-wrap: anywhere;
}
.diff-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
  align-items: center;
  justify-content: space-between;
  margin: 0 0 0.55rem;
}
.diff-mode-toggle {
  display: inline-flex;
  border: 1px solid var(--line);
  border-radius: 7px;
  overflow: hidden;
  background: #f4f7fa;
}
.diff-mode-toggle button {
  border: 0;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 0.82rem;
  padding: 0.28rem 0.65rem;
  cursor: pointer;
}
.diff-mode-toggle button[aria-pressed="true"] {
  background: var(--accent);
  color: #fff;
}
.diff-summary { margin: 0 0 0.35rem; }
.stale-banner {
  margin: 0 0 0.55rem;
  padding: 0.45rem 0.6rem;
  background: var(--warn-bg);
  border: 1px solid var(--warn-border);
  border-radius: 6px;
  color: #6a4a14;
  font-size: 0.9rem;
}
.diff-section { margin-top: 0.55rem; }
.diff-section h4 {
  margin: 0 0 0.3rem;
  font-size: 0.92rem;
}
.diff-section ul {
  margin: 0;
  padding-left: 1.1rem;
}
.modified-node {
  margin: 0.35rem 0 0.55rem;
  padding-bottom: 0.35rem;
  border-bottom: 1px solid var(--line);
}
.prop-change { margin: 0.25rem 0 0.35rem; font-size: 0.88rem; }
.prop-change-scalar.split {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 0.45rem;
  align-items: start;
}
.prop-change-scalar .scalar-side {
  min-width: 0;
}
.prop-change-scalar .scalar-side .side-label {
  display: block;
  font-size: 0.75rem;
  color: var(--muted);
  margin-bottom: 0.15rem;
}
`;
}

function pageStylesPartE(): string {
  return `
.diff-block {
  margin-top: 0.25rem;
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: 0.78rem;
  line-height: 1.4;
  overflow-x: hidden;
  overflow-y: auto;
  max-height: 18rem;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: #fafbfc;
}
.diff-line {
  display: grid;
  grid-template-columns: 2.6rem 1.1rem minmax(0, 1fr);
  column-gap: 0.2rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  width: 100%;
  padding: 0 0.35rem 0 0;
}
.diff-line .ln {
  text-align: right;
  color: #8a97a6;
  user-select: none;
  padding-right: 0.35rem;
  border-right: 1px solid var(--line);
}
.diff-line .gutter {
  text-align: center;
  user-select: none;
  font-weight: 650;
}
.diff-line .code {
  padding-left: 0.35rem;
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.diff-add { background: #e6f6ec; color: #145a32; }
.diff-remove { background: #fdeceb; color: #7a1f1f; }
.diff-eq { color: var(--muted); }
.diff-blank { background: #f0f3f6; color: transparent; }
.diff-split {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0;
  border: 1px solid var(--line);
  border-radius: 5px;
  overflow: hidden;
  margin-top: 0.25rem;
}
.diff-split .diff-pane {
  min-width: 0;
  overflow-x: hidden;
  overflow-y: auto;
  max-height: 18rem;
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: 0.78rem;
  line-height: 1.4;
  background: #fafbfc;
}
.diff-split .diff-pane + .diff-pane {
  border-left: 1px solid var(--line);
}
.diff-split .pane-head {
  position: sticky;
  top: 0;
  z-index: 1;
  background: #eef2f5;
  color: var(--muted);
  font-size: 0.72rem;
  font-weight: 650;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  padding: 0.2rem 0.55rem;
  border-bottom: 1px solid var(--line);
}
.diff-before { color: var(--danger); word-break: break-word; }
.diff-after { color: var(--ok); word-break: break-word; }
`;
}

function pageStylesPartF(): string {
  return `
.proposal-detail {
  scroll-margin-top: 4.5rem;
}
.proposal-detail.proposal-highlight {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  box-shadow: 0 0 0 4px var(--accent-soft);
}
.proposal-heading {
  font-size: 1.05rem;
  font-weight: 650;
  margin: 0 0 0.15rem;
  letter-spacing: -0.01em;
}
.proposal-id {
  margin: 0 0 0.35rem;
  font-size: 0.8rem;
}
.node-presence {
  margin: 0.35rem 0 0.55rem;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #fafbfc;
}
.node-presence > summary {
  cursor: pointer;
  padding: 0.4rem 0.55rem;
  user-select: none;
  list-style: none;
}
.node-presence > summary::-webkit-details-marker { display: none; }
.node-presence.node-added > summary { background: #e6f6ec; }
.node-presence.node-removed > summary { background: #fdeceb; }
.presence-summary-text { font-weight: 600; }
.presence-body { padding: 0.35rem 0.55rem 0.55rem; }
.presence-key-fields { margin-bottom: 0.35rem; }
.presence-all-props {
  margin-top: 0.35rem;
  border-top: 1px dashed var(--line);
  padding-top: 0.25rem;
}
.presence-all-props > summary {
  cursor: pointer;
  color: var(--muted);
  font-size: 0.85rem;
  user-select: none;
}
.presence-text { margin: 0.25rem 0; }
.presence-text > summary {
  cursor: pointer;
  font-size: 0.88rem;
  user-select: none;
}
.presence-text-toolbar {
  display: flex;
  gap: 0.4rem;
  margin: 0.25rem 0;
}
.presence-preview-toggle {
  font: inherit;
  font-size: 0.8rem;
  padding: 0.15rem 0.55rem;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: #fff;
  color: var(--ink);
  cursor: pointer;
}
.presence-preview-toggle[aria-pressed="true"] {
  background: var(--accent-soft);
  border-color: var(--accent);
}
.presence-preview-host {
  margin: 0.3rem 0;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: #fff;
  overflow: hidden;
}
.presence-preview-frame {
  display: block;
  width: 100%;
  min-height: 10rem;
  max-height: 18rem;
  border: 0;
  background: #fff;
}
.presence-pre {
  margin: 0.3rem 0 0;
  white-space: pre;
  overflow: auto;
  max-height: 14rem;
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: 0.78rem;
  line-height: 1.4;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 0.4rem 0.5rem;
}
.vs-current {
  margin-top: 0.85rem;
  border-top: 1px dashed var(--line);
  padding-top: 0.55rem;
}
.vs-current > summary {
  cursor: pointer;
  color: var(--muted);
  font-size: 0.9rem;
  user-select: none;
}
@media (max-width: ${DIFF_SPLIT_MIN_PX}px) {
  .diff-split { grid-template-columns: 1fr; }
  .diff-split .diff-pane + .diff-pane { border-left: 0; border-top: 1px solid var(--line); }
  .prop-change-scalar.split {
    grid-template-columns: 1fr;
  }
  .prop-change-scalar .scalar-arrow { display: none; }
}
@media (max-width: 640px) {
  dl.status { grid-template-columns: 1fr; }
  .audit-table .col-when { width: 7.5rem; min-width: 7.5rem; }
  .audit-table .col-action { width: 5.5rem; min-width: 5.5rem; }
  .audit-table .col-actor { width: 7rem; min-width: 6rem; }
}
`;
}

function pageStylesPartG(): string {
  return `
.dash-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10.5rem, 1fr));
  gap: 0.65rem;
  margin: 0 0 1rem;
}
.dash-card {
  background: #f7faf8;
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 0.75rem 0.85rem;
}
.dash-card-clickable { cursor: pointer; }
.dash-card-clickable:hover { border-color: var(--accent); background: var(--accent-soft); }
.dash-label { color: var(--muted); font-size: 0.8rem; margin-bottom: 0.2rem; }
.dash-value { font-size: 1.25rem; font-weight: 700; letter-spacing: -0.02em; }
.permissions-blurb { margin: 0 0 1rem; max-width: 42rem; line-height: 1.45; }
.tech-details { margin: 0.5rem 0 0; }
.tech-details > summary {
  cursor: pointer;
  color: var(--muted);
  font-size: 0.92rem;
  user-select: none;
  margin-bottom: 0.45rem;
}
.filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin: 0 0 0.75rem;
  align-items: center;
}
.proposals-search {
  flex: 1 1 12rem;
  min-width: 10rem;
  max-width: 22rem;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 0.28rem 0.65rem;
  font: inherit;
  font-size: 0.88rem;
  background: #fff;
  color: var(--ink);
}
.proposals-search:focus {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
button.id-copy {
  display: inline;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  vertical-align: baseline;
}
button.id-copy:hover .id-short,
button.id-copy:focus .id-short {
  text-decoration: underline;
  text-underline-offset: 2px;
}
button.id-copy:focus {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 3px;
}
.filter-chip {
  border: 1px solid var(--line);
  background: #fff;
  color: var(--ink);
  border-radius: 999px;
  padding: 0.28rem 0.75rem;
  font: inherit;
  font-size: 0.88rem;
  cursor: pointer;
}
.filter-chip[aria-pressed="true"] {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.proposal-card-compact {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 0.75rem;
  align-items: baseline;
  padding: 0.55rem 0.75rem;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fafbfc;
  margin-top: 0.45rem;
  cursor: pointer;
}
.proposal-card-compact:hover { border-color: var(--accent); }
.proposal-plain-summary { margin: 0.15rem 0 0.35rem; color: var(--ink); font-size: 0.95rem; }
.proposal-meta-line { color: var(--muted); font-size: 0.88rem; }
.proposal-flow { color: var(--ink); font-weight: 600; }
.proposal-changes { margin: 0.35rem 0 0.55rem; }
.delete-banner {
  margin: 0 0 0.55rem;
  padding: 0.55rem 0.7rem;
  background: #fdeceb;
  border: 1px solid #e2a0a0;
  border-radius: 6px;
  color: var(--danger);
  font-weight: 650;
  font-size: 0.92rem;
}
.proposal-warnings {
  margin: 0 0 0.55rem;
  padding: 0.55rem 0.7rem;
  background: #fff8e8;
  border: 1px solid #e0c070;
  border-radius: 6px;
  color: #6a4a14;
  font-size: 0.9rem;
}
.proposal-warnings-title {
  margin: 0 0 0.35rem;
  font-weight: 650;
  font-size: 0.92rem;
}
.proposal-warnings ul {
  margin: 0;
  padding-left: 1.15rem;
}
.proposal-warnings li {
  margin: 0.15rem 0;
  line-height: 1.4;
}
.proposal-warnings .warn-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.82em;
  opacity: 0.85;
}
.diff-warnings {
  margin: 0.45rem 0 0.65rem;
}
.danger-text { color: var(--danger); }
.ttl-custom-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: flex-end;
  margin: 0.25rem 0 0.35rem;
}
.ttl-long-warn {
  margin: 0.5rem 0 0;
  color: #b42318;
  font-size: 0.9rem;
}
.ttl-reset-note {
  margin: 0.35rem 0 0;
  color: var(--muted, #667);
  font-size: 0.85rem;
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.token-once .copy-ai-primary {
  font-size: 1.05rem;
  padding: 0.65rem 1rem;
  width: 100%;
  max-width: 28rem;
}
.mcp-setup-panel {
  margin: 0.75rem 0 0.25rem;
}
.mcp-setup-fallback {
  margin: 0 0 0.65rem;
}
.mcp-setup-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin: 0 0 0.65rem;
}
.mcp-setup-tab {
  appearance: none;
  border: 1px solid var(--border, #ccd);
  background: var(--surface, #fff);
  color: inherit;
  border-radius: 4px;
  padding: 0.35rem 0.65rem;
  font: inherit;
  cursor: pointer;
}
.mcp-setup-tab.is-active {
  border-color: var(--accent, #1a4a7a);
  background: #e8f1fb;
}
.mcp-setup-snippet {
  margin: 0 0 0.65rem;
  padding: 0.75rem;
  overflow: auto;
  max-height: 16rem;
  font-size: 0.85rem;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--code-bg, #f6f8fa);
  border-radius: 4px;
}
`;
}

function pageStylesPartH(): string {
  return `
.stale-group {
  margin: 1rem 0 0;
  border: 1px solid var(--warn-border);
  border-radius: 8px;
  background: var(--warn-bg);
  padding: 0.35rem 0.75rem 0.75rem;
}
.stale-group > summary {
  cursor: pointer;
  font-weight: 650;
  color: #6a4a14;
  padding: 0.45rem 0;
  user-select: none;
}
.stale-group-actions { margin: 0.35rem 0 0.55rem; }
.stale-item {
  margin: 0.55rem 0 0;
  padding: 0.55rem 0.65rem;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 7px;
}
.stale-item-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem 0.75rem;
  align-items: center;
  justify-content: space-between;
}
.stale-item-main {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}
.stale-reason {
  font-size: 0.85rem;
  font-weight: 400;
}
.stale-item-diff { margin-top: 0.45rem; }
.stale-item-diff > summary {
  cursor: pointer;
  color: var(--muted);
  font-size: 0.9rem;
  user-select: none;
}
.dismiss-vs-reject { margin: 0.25rem 0 0.45rem; font-size: 0.88rem; }
.vs-current-plain { margin: 0.45rem 0 0; }
.large-diff-btn {
  display: inline-block;
  cursor: pointer;
  color: var(--accent);
  font-weight: 600;
  list-style: none;
}
.large-diff-btn::-webkit-details-marker { display: none; }
.large-diff-details { margin-top: 0.25rem; }
.toast-host {
  position: fixed;
  right: 1rem;
  bottom: 1rem;
  z-index: 80;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  max-width: min(28rem, calc(100vw - 2rem));
}
.toast {
  background: var(--ink);
  color: #fff;
  padding: 0.9rem 1.05rem;
  border-radius: 10px;
  font-size: 1rem;
  line-height: 1.45;
  box-shadow: 0 10px 28px rgba(0,0,0,0.2);
}
.toast .toast-title { font-weight: 600; display: block; margin: 0 0 0.2rem; }
.toast .toast-body { display: block; }
.toast a.toast-link {
  color: #fff;
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 2px;
  margin-left: 0.35rem;
}
.toast.ok { background: var(--ok); }
.toast.error { background: var(--danger); }
.dialog-proposal-title {
  margin: 0 0 0.55rem;
  font-weight: 600;
  font-size: 1.02rem;
  color: var(--ink);
  word-break: break-word;
}
.cross-tab-hint {
  margin: 0.75rem 0 0;
  padding: 0.65rem 0.8rem;
  background: var(--accent-soft);
  border-radius: 8px;
  font-size: 0.95rem;
}
.cross-tab-hint button {
  margin-left: 0.35rem;
  font: inherit;
  color: var(--accent);
  background: none;
  border: none;
  padding: 0;
  text-decoration: underline;
  cursor: pointer;
  font-weight: 600;
}
.search-cleared-note {
  margin: 0 0 0.65rem;
  font-size: 0.92rem;
}
dialog {
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 1rem 1.15rem;
  max-width: min(28rem, 94vw);
  box-shadow: 0 12px 40px rgba(26, 35, 48, 0.18);
}
dialog::backdrop { background: rgba(26, 35, 48, 0.35); }
dialog h3 { margin: 0 0 0.4rem; }
.dialog-actions { justify-content: flex-end; margin: 0.85rem 0 0; }
.advanced-block { margin: 0.45rem 0; }
.advanced-block > summary {
  cursor: pointer;
  color: var(--muted);
  font-size: 0.88rem;
  user-select: none;
}
.full-deploy-warn {
  margin: 0.35rem 0 0;
  color: var(--danger);
  font-size: 0.85rem;
}
.time-relative[title] { cursor: help; border-bottom: 1px dotted var(--line); }
.status-pill {
  display: inline-block;
  padding: 0.1rem 0.45rem;
  border-radius: 5px;
  font-size: 0.78rem;
  font-weight: 650;
  text-transform: capitalize;
}
.status-pill.pending { background: #e8f1fb; color: #1a4a7a; }
.status-pill.approved { background: #e8f6ef; color: var(--ok); }
.status-pill.rejected { background: #f4efe6; color: #6a4a14; }
.status-pill.failed { background: #fdeceb; color: var(--danger); }
.status-pill.withdrawn { background: #eef0f3; color: #4a5564; }
.status-pill.expired { background: #f3ebe0; color: #8a5a00; }
.status-pill.superseded { background: #ebe4f5; color: #5b3d8a; }
.debug-toggle {
  flex-direction: row;
  align-items: center;
  gap: 0.35rem;
  margin-left: auto;
}
.debug-toggle input { width: auto; }
`;
}

export function pageStyles(): string {
  return (
    pageStylesPartA() +
    pageStylesPartA2() +
    pageStylesPartB() +
    pageStylesPartC() +
    pageStylesPartD() +
    pageStylesPartE() +
    pageStylesPartF() +
    pageStylesPartG() +
    pageStylesPartH()
  ).trim();
}
