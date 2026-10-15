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
  margin: 0 0 1.5rem;
}
nav.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-bottom: 1.1rem;
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
  background: var`;
}

function pageStylesPartB(): string {
  return `(--accent-soft);
  color: var(--accent);
  font-size: 0.82rem;
  font-weight: 650;
}
.muted { color: var(--muted); font-size: 0.92rem; }
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
  overflow-x: auto;
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
  white-space: pre;
  min-width: max-content;
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
.diff-line .code { padding-left: 0.35rem; }
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
  overflow-x: auto;
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

export function pageStyles(): string {
  return (
    pageStylesPartA() +
    pageStylesPartB() +
    pageStylesPartC() +
    pageStylesPartD() +
    pageStylesPartE() +
    pageStylesPartF()
  ).trim();
}
