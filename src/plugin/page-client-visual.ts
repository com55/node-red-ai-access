/** ES5 browser helpers for the proposal canvas. Kept separate from dashboard orchestration. */
export function pageClientVisualGeometryScript(): string {
  return `
  // Pure geometry: the pill centre is the fixed point at the current zoom.
  function visualRunGeometry(widths, anchor, mode, gap) {
    gap = gap == null ? 65 : gap;
    var centres = [0];
    for (var i = 1; i < widths.length; i += 1) centres.push(centres[i - 1] + widths[i - 1] / 2 + gap + widths[i] / 2);
    var focus = mode === 'leading' ? centres[centres.length - 1] : mode === 'trailing' ? 0 :
      widths.length % 2 ? centres[(widths.length - 1) / 2] :
      (centres[0] - widths[0] / 2 + centres[centres.length - 1] + widths[widths.length - 1] / 2) / 2;
    return centres.map(function (x) { return x + anchor - focus; });
  }
  function visualShiftPositions(graph, state, ids, delta) {
    var moved = Object.create(null);
    ids.forEach(function (id) { moved[id] = true; });
    graph.runs.forEach(function (run) {
      if (moved[run.id]) run.ids.forEach(function (id) { moved[id] = true; });
      if (moved[run.id] || run.ids.every(function (id) { return moved[id]; })) {
        if (!moved[run.id] && state.positions[run.id]) state.positions[run.id].x += delta;
        if (state.anchors[run.id]) state.anchors[run.id].x += delta;
      }
    });
    Object.keys(moved).forEach(function (id) { if (state.positions[id]) state.positions[id].x += delta; });
  }
  function visualToggleRun(graph, state, visible, id) {
      var run = graph.runs.filter(function (r) { return r.id === id; })[0];
      if (!run) return;
      visible.nodes.forEach(function (n) { state.positions[n.id] = { x: n.px, y: n.py }; });
      if (state.expanded[id]) {
        (state.displacements[id] || []).forEach(function (part) {
          visualShiftPositions(graph, state, part.ids, -part.delta);
        });
        state.positions[id] = { x: state.anchors[id].x, y: state.anchors[id].y };
        delete state.expanded[id]; delete state.displacements[id];
      } else {
        var pill = visible.byId[id], mode = run.left && run.right ? 'middle' : run.right ? 'leading' : 'trailing';
        state.anchors[id] = { x: pill.px, y: pill.py };
        var centres = visualRunGeometry(run.ids.map(function (nid) { return graph.byId[nid].w; }), pill.px, mode);
        run.ids.forEach(function (nid, i) { state.positions[nid] = { x: centres[i], y: pill.py }; });
        var start = centres[0] - graph.byId[run.ids[0]].w / 2;
        var end = centres[centres.length - 1] + graph.byId[run.ids[run.ids.length - 1]].w / 2;
        var left = visible.nodes.filter(function (n) { return n.id !== id && n.px < pill.px; });
        var right = visible.nodes.filter(function (n) { return n.id !== id && n.px >= pill.px; });
        var dl = Math.max.apply(null, [0].concat(left.map(function (n) { return n.px + n.w / 2 + 65 - start; })));
        var dr = Math.max.apply(null, [0].concat(right.map(function (n) { return end + 65 - (n.px - n.w / 2); })));
        if (mode === 'middle') dl = dr = Math.max(dl, dr);
        var parts = [{ ids: left.map(function (n) { return n.id; }), delta: -dl }, { ids: right.map(function (n) { return n.id; }), delta: dr }];
        parts.forEach(function (part) { visualShiftPositions(graph, state, part.ids, part.delta); });
        state.displacements[id] = parts;
        state.expanded[id] = true;
      }
    }
  function visualPointerMoved(start, point) {
    return Math.pow(point.x - start.x, 2) + Math.pow(point.y - start.y, 2) > 16;
  }
`;
}

function pageClientVisualGraphScript(): string {
  return `
  var visualStates = {};
  var visualTypeMetadata = {};
  var visualColors = { inject: '#a6bbcf', function: '#fdd0a2', template: '#f3b567', debug: '#87a980', change: '#E2D96E', switch: '#E2D96E', 'http in': '#e7e7ae', 'http response': '#e7e7ae', comment: '#fff' };
  var visualStatusColors = { added: '#2a9d4a', removed: '#c65353', modified: '#2f6fed', conflict: '#dc9419' };
  var visualBadges = { added: '+', removed: '−', modified: '✎', conflict: '!' };
  function visualCollect(flow) {
    var result = Object.create(null);
    ((flow && flow.nodes) || []).concat((flow && flow.configs) || []).forEach(function (n) { result[n.id] = n; });
    return result;
  }
  function visualGraph(p, diff) {
    var before = visualCollect(p.baseFlow || p.visualLiveFlow), after = visualCollect(p.payload && p.payload.flow), live = visualCollect(p.visualLiveFlow), kinds = Object.create(null), entries = Object.create(null);
    ['added', 'removed', 'modified'].forEach(function (kind) {
      (diff[kind] || []).forEach(function (n) { kinds[n.id] = kind; entries[n.id] = n; });
    });
    ((diff.rebase && diff.rebase.conflicts) || []).forEach(function (c) { if (c.nodeId) kinds[c.nodeId] = 'conflict'; });
    Object.keys(live).forEach(function (id) {
      if (!kinds[id]) {
        // A deleted base node is a proposed removal, not unchanged live context.
        if (!before[id] || after[id]) after[id] = live[id];
      }
    });
    var ids = Object.keys(after).concat(Object.keys(before).filter(function (id) { return !after[id]; }));
    var nodes = ids.map(function (id, index) {
      var raw = after[id] || before[id], old = before[id], meta = visualTypeMetadata[raw.type] || {};
      var name = String(raw.name || raw.label || raw.type || 'node');
      var outputs = typeof raw.outputs === 'number' ? raw.outputs : Array.isArray(raw.wires) ? raw.wires.length : Number(meta.outputs) || 0;
      var width = Math.max(100, Math.ceil((name.length * 7.5 + 55) / 20) * 20);
      return { id: id, raw: raw, old: old, name: name, type: raw.type, kind: kinds[id] || '', entry: entries[id],
        w: width, h: Math.max(30, outputs * 15), outputs: outputs,
        input: typeof meta.inputs === 'number' ? meta.inputs > 0 : ['inject', 'comment', 'http in', 'mqtt in', 'link in', 'catch', 'status', 'complete'].indexOf(raw.type) < 0,
        editorMerged: !!(live[id] && old && JSON.stringify(live[id]) !== JSON.stringify(old)),
        color: /^#[0-9a-f]{3,8}$/i.test(meta.color || '') ? meta.color : (Object.prototype.hasOwnProperty.call(visualColors, raw.type) ? visualColors[raw.type] : '#d6dadd'),
        x: Number(raw.x) || 100 + index * 180, y: Number(raw.y) || 100,
        moved: !!(kinds[id] && old && (old.x !== raw.x || old.y !== raw.y) && (typeof old.x === 'number' && typeof old.y === 'number')) };
    });
    var byId = Object.create(null);
    nodes.forEach(function (n) { byId[n.id] = n; });
    var edges = [], seen = Object.create(null);
    function wires(collection, previous) {
      Object.keys(collection).forEach(function (id) {
        (collection[id].wires || []).forEach(function (targets, port) {
          (targets || []).forEach(function (target) {
            if (!byId[id] || !byId[target]) return;
            var key = id + ':' + port + ':' + target;
            if (seen[key]) { if (!previous) seen[key].kind = ''; return; }
            var other = (before[id] && before[id].wires && before[id].wires[port]) || [];
            var edge = { from: id, to: target, port: port, kind: previous ? 'removed' : other.indexOf(target) < 0 ? 'added' : '' };
            seen[key] = edge; edges.push(edge);
          });
        });
      });
    }
    wires(after, false);
    // Old-only wires remain visible as dashed removals.
    Object.keys(before).forEach(function (id) {
      (before[id].wires || []).forEach(function (targets, port) { (targets || []).forEach(function (target) {
        var key = id + ':' + port + ':' + target;
        if (!seen[key] && byId[id] && byId[target]) { var edge = { from: id, to: target, port: port, kind: 'removed' }; seen[key] = edge; edges.push(edge); }
      }); });
    });
    // Show connected related nodes, omitting unrelated unchanged components.
    var related = Object.create(null), queue = nodes.filter(function (n) { return n.kind; }).map(function (n) { return n.id; });
    queue.forEach(function (id) { related[id] = true; });
    for (var q = 0; q < queue.length; q += 1) edges.forEach(function (e) {
      var next = e.from === queue[q] ? e.to : e.to === queue[q] ? e.from : '';
      if (next && !related[next]) { related[next] = true; queue.push(next); }
    });
    if (queue.length) { nodes = nodes.filter(function (n) { return related[n.id]; }); edges = edges.filter(function (e) { return related[e.from] && related[e.to]; }); }
    var incoming = Object.create(null), outgoing = Object.create(null);
    nodes.forEach(function (n) { incoming[n.id] = []; outgoing[n.id] = []; });
    edges.forEach(function (e) {
      if (outgoing[e.from].indexOf(e.to) < 0) outgoing[e.from].push(e.to);
      if (incoming[e.to].indexOf(e.from) < 0) incoming[e.to].push(e.from);
    });
    var assigned = Object.create(null), runs = [];
    function eligible(id) { return byId[id] && !byId[id].kind && incoming[id].length <= 1 && outgoing[id].length <= 1; }
    nodes.forEach(function (n) {
      if (!eligible(n.id) || assigned[n.id]) return;
      // Walk backward to the beginning of this unchanged chain, guarding cycles.
      var first = n.id, visited = Object.create(null);
      while (incoming[first].length === 1 && eligible(incoming[first][0]) && !visited[incoming[first][0]]) {
        visited[first] = true; first = incoming[first][0];
      }
      var ids = [], cursor = first;
      while (eligible(cursor) && !assigned[cursor]) {
        assigned[cursor] = true; ids.push(cursor);
        cursor = outgoing[cursor][0];
        if (!cursor) break;
      }
      if (ids.length >= 2) {
        runs.push({ id: 'run-' + first, ids: ids, left: incoming[ids[0]].length > 0, right: outgoing[ids[ids.length - 1]].length > 0 });
      }
    });
    return { nodes: nodes, byId: byId, edges: edges, runs: runs };
  }
  function visualVisible(graph, state) {
    var replacement = Object.create(null), nodes = [], byId = Object.create(null);
    graph.runs.forEach(function (run) {
      if (state.expanded[run.id] || state.layout === 'editor') return;
      run.ids.forEach(function (id) { replacement[id] = run.id; });
      var first = graph.byId[run.ids[0]];
      nodes.push({ id: run.id, name: '… ' + run.ids.length + ' nodes', run: run, w: 110, h: 30, x: first.x, y: first.y, outputs: 1 });
    });
    graph.nodes.forEach(function (n) { if (!replacement[n.id]) nodes.push(n); });
    nodes.sort(function (a, b) { return a.x - b.x || a.y - b.y || a.id.localeCompare(b.id); });
    nodes.forEach(function (n) { byId[n.id] = n; });
    var edges = [], seen = Object.create(null);
    graph.edges.forEach(function (e) {
      var from = replacement[e.from] || e.from, to = replacement[e.to] || e.to, key = from + ':' + to + ':' + e.port;
      if (from === to || seen[key]) return;
      seen[key] = true; edges.push({ from: from, to: to, port: e.port, kind: e.kind });
    });
    // Stable compact ranks with a bounded cycle fallback. Branches get separate lanes.
    var rank = Object.create(null), indegree = Object.create(null), queue = [];
    nodes.forEach(function (n) { rank[n.id] = 0; indegree[n.id] = 0; });
    edges.forEach(function (e) { indegree[e.to] += 1; });
    nodes.forEach(function (n) { if (!indegree[n.id]) queue.push(n.id); });
    for (var i = 0; i < queue.length; i += 1) edges.forEach(function (e) {
      if (e.from !== queue[i]) return;
      rank[e.to] = Math.max(rank[e.to], rank[e.from] + 1);
      indegree[e.to] -= 1;
      if (!indegree[e.to]) queue.push(e.to);
    });
    var widths = Object.create(null), offsets = [80], lanes = Object.create(null);
    nodes.forEach(function (n) { widths[rank[n.id]] = Math.max(widths[rank[n.id]] || 0, n.w); });
    for (var r = 1; r <= nodes.length; r += 1) offsets[r] = offsets[r - 1] + (widths[r - 1] || 100) / 2 + 65 + (widths[r] || 100) / 2;
    nodes.forEach(function (n) {
      var pos = state.positions[n.id], level = rank[n.id];
      lanes[level] = (lanes[level] || 0) + 1;
      n.px = state.layout === 'editor' ? n.x : pos ? pos.x : offsets[level];
      n.py = state.layout === 'editor' ? n.y : pos ? pos.y : 110 + (lanes[level] - 1) * 85;
    });
    return { nodes: nodes, edges: edges, byId: byId };
  }
`;
}

function pageClientVisualRenderScript(): string {
  return `
  function visualIcon(type) {
    var paths = {
      inject: '<path d="M18 5v12H7v9h15v-7l6 11-6 12v-8H7v9h11v12l14-25z" fill="#fff"/>',
      function: '<path d="M31 31v-3h-7l1-14q1-6 5-2l5-1q-3-10-12-4q-4 3-5 21h-8v3h8l-2 15q-1 6-5 2l-5 1q3 10 12 4q4-3 5-22z" fill="#fff"/>',
      debug: '<path d="M10 14h20M10 22h20M10 30h20M10 38h20M10 46h20" stroke="#fff" stroke-width="3"/>',
      change: '<path d="M5 15h22v-8l9 11-9 11v-8H5zM35 45H13v8L4 42l9-11v8h22z" fill="#fff"/>',
      switch: '<path d="M5 27h10l8-14h5V5l8 11-8 11v-8h-2l-6 11 6 12h2v-8l8 11-8 11v-8h-5l-8-15H5z" fill="#fff"/>'
    };
    return paths[type] || '<circle cx="20" cy="30" r="13" fill="none" stroke="#fff" stroke-width="3"/><path d="M7 30h26M20 17v26" stroke="#fff" stroke-width="2"/>';
  }
  function visualNodeSvg(n, state, oldPosition) {
    var ghost = !!oldPosition, context = !n.kind, right = n.type === 'debug', width = n.w, height = n.h;
    var color = ghost || !context ? n.color : '#d6dadd';
    var x = ghost ? Number(n.old.x) : n.px, y = ghost ? Number(n.old.y) : n.py;
    var outline = n.kind ? visualStatusColors[n.kind] : '#999';
    var interactive = !ghost && n.kind;
    var svg = '<g class="visual-node' + (context ? ' context-node' : ' changed') + (ghost ? ' move-ghost' : '') + '"' +
      (ghost ? ' pointer-events="none"' : interactive ? ' role="button" tabindex="0" data-visual-node="' + esc(n.id) + '" aria-label="' + esc(n.kind + ': ' + n.name) + '"' : '') +
      ' transform="translate(' + (x - width / 2) + ',' + (y - height / 2) + ')">';
    if (n.type === 'inject' || right) svg += '<g transform="translate(' + (right ? width - 6 : -25) + ',2)"><rect width="32" height="26" rx="5" fill="#eee" stroke="#999"/><rect x="' + (right ? 11 : 5) + '" y="4" width="16" height="18" rx="4" fill="' + color + '" stroke="#999"' + (ghost ? ' fill-opacity=".6"' : '') + '/></g>';
    if (!ghost && n.kind) svg += '<rect class="change-outline" x="-4" y="-4" width="' + (width + 8) + '" height="' + (height + 8) + '" rx="7" fill="none" stroke="' + outline + '" stroke-width="' + (state.selected === n.id ? 3 : 2) + '"' + (n.kind === 'conflict' ? ' stroke-dasharray="6,4"' : '') + '/>';
    svg += '<rect class="node-body" width="' + width + '" height="' + height + '" rx="5" fill="' + color + '" stroke="#999"' + (ghost ? ' stroke-dasharray="8,3" fill-opacity=".6"' : '') + '/>' +
      '<rect x="' + (right ? width - 30 : 0) + '" width="30" height="' + height + '" rx="5" fill="#000" opacity=".05"/>' +
      '<path d="M' + (right ? width - 30 : 30) + ' 1v' + (height - 2) + '" stroke="#000" opacity=".1"/>' +
      '<svg x="' + (right ? width - 30 : 0) + '" y="' + ((height - 30) / 2) + '" width="30" height="30" viewBox="0 0 40 60">' + visualIcon(n.type) + '</svg>' +
      '<text x="' + (right ? width - 38 : 38) + '" y="' + height / 2 + '" dominant-baseline="central" text-anchor="' + (right ? 'end' : 'start') + '" font-size="14" fill="#333"' +
      (n.raw.name ? ' font-style="italic"' : '') + '>' + esc(n.name) + '</text>';
    function port(px, py) { return '<rect x="' + px + '" y="' + py + '" width="10" height="10" rx="3" fill="#d9d9d9" stroke="#999" fill-opacity="1" stroke-dasharray="none"/>'; }
    if (n.input) svg += port(-5, height / 2 - 5);
    for (var i = 0; i < n.outputs; i += 1) svg += port(width - 5, height / 2 - (n.outputs - 1) * 6.5 + i * 13 - 5);
    if (!ghost && n.kind) svg += '<circle cx="' + (width - 2) + '" cy="-6" r="8" fill="' + outline + '"/><text x="' + (width - 2) + '" y="-6" dominant-baseline="central" text-anchor="middle" fill="#fff" font-size="11" font-weight="700">' + visualBadges[n.kind] + '</text>';
    return svg + '</g>';
  }
  function visualPill(id, label, x, y, collapse) {
    return '<g class="' + (collapse ? 'visual-collapse' : 'visual-run') + '" role="button" tabindex="0" data-visual-run="' + esc(id) + '" aria-label="' + esc(label) + '" transform="translate(' + (x - 55) + ',' + (y - 15) + ')"><rect width="110" height="30" rx="15" fill="#f1f3f4" stroke="#999" stroke-dasharray="5,4"/><text x="55" y="15" text-anchor="middle" dominant-baseline="central" font-size="13" fill="#53616c">' + esc(label) + '</text></g>';
  }
  function visualMarkup(p, diff) {
    var counts = Object.assign({}, diff.summary, { conflict: ((diff.rebase && diff.rebase.conflicts) || []).map(function (c) { return c.nodeId; }).filter(function (id, i, ids) { return ids.indexOf(id) === i; }).length });
    return '<div class="visual-summary"><div class="visual-detail-counts">' + ['added', 'removed', 'modified', 'conflict'].filter(function (kind) { return counts[kind]; }).map(function (kind) { return '<span>' + counts[kind] + ' ' + kind + '</span>'; }).join('') + '</div>' + '<div class="visual-legend">' + ['added', 'removed', 'modified', 'conflict'].map(function (kind) {
      return '<span><i style="background:' + visualStatusColors[kind] + '">' + visualBadges[kind] + '</i>' + kind + '</span>';
    }).join('') + '<span><i class="context-dot"></i>Related nodes</span><span><i class="editor-merged-dot">•</i>Editor-merged</span></div></div>' +
      '<section class="visual-workspace" aria-label="Visual View"><div class="visual-workhead"><strong>Flow preview <span>/ ' + esc(flowLabelOf(p)) + '</span></strong><span>Changed nodes + related nodes</span></div>' +
      '<div class="visual-body"><div class="visual-canvas-wrap"><svg class="visual-canvas" aria-label="Node-RED proposal flow"><defs><pattern id="visual-grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" stroke="#eee"/></pattern><marker id="visual-move-tip" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10" fill="none" stroke="#909aa2"/></marker></defs><rect width="100%" height="100%" fill="url(#visual-grid)"/><g class="visual-viewport"></g></svg>' +
      '<div class="visual-layout" role="group" aria-label="Layout mode"><button type="button" data-visual-layout="compact">Compact</button><button type="button" data-visual-layout="editor">Editor positions</button></div><div class="visual-canvas-note">READ-ONLY PREVIEW<br>Proposed flow · changes highlighted</div>' +
      '<span class="visual-pan-hint">Drag to pan · Scroll to zoom</span><div class="visual-tools"><span class="visual-zoom"></span><button type="button" data-visual-zoom="out" aria-label="Zoom out">−</button><button type="button" data-visual-zoom="in" aria-label="Zoom in">+</button><button type="button" data-visual-zoom="fit">⌗ Fit</button></div></div>' +
      '<aside class="visual-changed-list"><div class="visual-list-head"><strong>Changed nodes <span class="visual-list-count"></span></strong></div><div class="visual-node-list"></div><p>Related nodes are shown only on the canvas</p></aside></div></section>';
  }
`;
}

function pageClientVisualInteractionScript(): string {
  return `
  function mountProposalVisual(p, diff) {
    var host = document.querySelector('[data-visual-for="' + p.id + '"]');
    if (!host) return;
    var state = visualStates[p.id];
    if (!state) {
      var layout = 'compact';
      try { if (localStorage.getItem('ai-access.visual-view-layout') === 'editor') layout = 'editor'; } catch (e) {}
      state = visualStates[p.id] = { layout: layout, expanded: Object.create(null), positions: Object.create(null), displacements: Object.create(null), anchors: Object.create(null), view: { x: 0, y: 0, k: 1 }, selected: '', fitted: false };
    }
    if (state.resizeObserver) state.resizeObserver.disconnect();
    host.innerHTML = visualMarkup(p, diff);
    var graph = visualGraph(p, diff), visible;
    var svg = host.querySelector('.visual-canvas'), viewport = host.querySelector('.visual-viewport'), wrap = host.querySelector('.visual-canvas-wrap');
    function transform() {
      viewport.setAttribute('transform', 'translate(' + state.view.x + ',' + state.view.y + ') scale(' + state.view.k + ')');
      host.querySelector('.visual-zoom').textContent = Math.round(state.view.k * 100) + '%';
    }
    function paint() {
      visible = visualVisible(graph, state);
      var html = '';
      if (state.layout === 'editor') graph.nodes.forEach(function (n) {
        if (!n.moved) return;
        var distance = Math.sqrt(Math.pow(n.x - n.old.x, 2) + Math.pow(n.y - n.old.y, 2));
        if (distance > 120) html += '<path pointer-events="none" class="move-arrow" d="M' + n.old.x + ' ' + (n.old.y - n.h / 2 - 4) + 'L' + n.px + ' ' + (n.py + n.h / 2 + 8) + '" fill="none" stroke="#909aa2" stroke-width="1.5" stroke-dasharray="6,5" marker-end="url(#visual-move-tip)"/>';
        html += visualNodeSvg(n, state, true);
      });
      visible.edges.forEach(function (e) {
        var from = visible.byId[e.from], to = visible.byId[e.to], x = from.px + from.w / 2, y = from.py + (e.port - ((from.outputs || 1) - 1) / 2) * 13, end = to.px - to.w / 2;
        var curve = Math.max(45, Math.abs(end - x) * .55);
        html += '<path d="M' + x + ' ' + y + 'C' + (x + curve) + ' ' + y + ',' + (end - curve) + ' ' + to.py + ',' + end + ' ' + to.py + '" fill="none" stroke="' + (visualStatusColors[e.kind] || '#999') + '" stroke-width="3"' + (e.kind === 'removed' ? ' stroke-dasharray="7,5"' : '') + '/>';
      });
      visible.nodes.forEach(function (n) { html += n.run ? visualPill(n.id, n.name, n.px, n.py, false) : visualNodeSvg(n, state, false); });
      if (state.layout === 'compact') graph.runs.forEach(function (run) {
        if (!state.expanded[run.id]) return;
        var anchor = state.anchors[run.id];
        html += visualPill(run.id, 'Collapse', anchor.x, anchor.y + 53, true);
      });
      viewport.innerHTML = html;
      host.querySelectorAll('[data-visual-layout]').forEach(function (btn) { btn.setAttribute('aria-pressed', btn.getAttribute('data-visual-layout') === state.layout ? 'true' : 'false'); });
      var changed = graph.nodes.filter(function (n) { return n.kind; });
      host.querySelector('.visual-list-count').textContent = '(' + changed.length + ')';
      host.querySelector('.visual-node-list').innerHTML = changed.map(function (n) {
        var resolved = p.conflictChoice && p.conflictChoice.nodeId === n.id && n.kind !== 'conflict';
        return '<button type="button" class="visual-change-row' + (state.selected === n.id ? ' selected' : '') + '" data-visual-node="' + esc(n.id) + '"><i style="background:' + visualStatusColors[n.kind] + '">' + visualBadges[n.kind] + '</i><span class="visual-node-type">' + esc(n.type) + '</span><strong>' + esc(n.name) + '</strong><span class="visual-node-summary">' + (resolved ? '<b class="resolved-marker">Resolved · </b>' : '') + (n.editorMerged ? '<span class="editor-merged-marker" title="Also changed in the editor">• </span>' : '') + esc(n.entry && (n.entry.changes || []).map(function (ch) { return ch.key; }).join(' · ') || n.kind + ' node') + '</span><span class="visual-node-arrow">↗</span></button>';
      }).join('') || '<p class="muted">Only flow settings changed.</p>';
      transform();
    }
    function fit() {
      var boxes = visible.nodes.map(function (n) { return { x: n.px, y: n.py, w: n.w, h: n.h }; });
      if (state.layout === 'editor') graph.nodes.forEach(function (n) { if (n.moved) boxes.push({ x: n.old.x, y: n.old.y, w: n.w, h: n.h }); });
      if (!boxes.length) return;
      var minX = Math.min.apply(null, boxes.map(function (b) { return b.x - b.w / 2; })) - 35;
      var maxX = Math.max.apply(null, boxes.map(function (b) { return b.x + b.w / 2; })) + 35;
      var minY = Math.min.apply(null, boxes.map(function (b) { return b.y - b.h / 2; })) - 55;
      var maxY = Math.max.apply(null, boxes.map(function (b) { return b.y + b.h / 2; })) + 65;
      var w = wrap.clientWidth || 600, h = wrap.clientHeight || 350;
      state.view.k = Math.min(1.2, (w - 24) / (maxX - minX), (h - 65) / (maxY - minY));
      state.view.x = w / 2 - (minX + maxX) / 2 * state.view.k;
      state.view.y = (h - 30) / 2 - (minY + maxY) / 2 * state.view.k;
      state.fitted = true;
      transform();
    }
    function zoom(factor, x, y) {
      var old = state.view.k, next = Math.max(.08, Math.min(3, old * factor));
      state.view.x = x - (x - state.view.x) * next / old;
      state.view.y = y - (y - state.view.y) * next / old;
      state.view.k = next;
      transform();
    }
    function toggleRun(id) { visualToggleRun(graph, state, visible, id); paint(); }
    function showAllDiff() {
      state.selected = ''; state.showAll = true; paint();
      var allHost = document.querySelector('[data-diff-for="' + p.id + '"]');
      if (allHost) { allHost.innerHTML = renderHumanDiff(diff); bindDiffModeToggle(allHost, diff); bindPresencePreviewToggles(allHost); }
    }
    function selectNode(id) {
      var n = graph.byId[id];
      if (!n || !n.kind) return;
      state.selected = id; state.showAll = false;
      paint();
      var diffHost = document.querySelector('[data-diff-for="' + p.id + '"]');
      if (!diffHost) return;
      var selectedDiff = Object.assign({}, diff);
      ['added', 'removed', 'modified'].forEach(function (kind) { selectedDiff[kind] = (diff[kind] || []).filter(function (entry) { return entry.id === id; }); });
      selectedDiff.tabProperties = [];
      selectedDiff.summary = Object.assign({}, diff.summary, { tabChanges: [] });
      delete selectedDiff.liveChanges; delete selectedDiff.vsCurrent;
      diffHost.innerHTML = '<div class="visual-diff-heading"><strong>' + esc(n.name) + '</strong><span class="muted">' + esc(n.type) + '</span><button type="button" class="visual-show-all">Show all changes</button></div>' + '<div class="visual-node-diff">' + renderHumanDiff(selectedDiff) + '</div>';
      bindDiffModeToggle(diffHost.querySelector('.visual-node-diff'), selectedDiff);
      bindPresencePreviewToggles(diffHost);
      diffHost.querySelector('.visual-show-all').onclick = showAllDiff;
    }
`;
}

function pageClientVisualEventsScript(): string {
  return `
    var drag = null, suppressClick = false;
    svg.addEventListener('pointerdown', function (ev) {
      if (ev.button && ev.button !== 0) return;
      suppressClick = false;
      drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, vx: state.view.x, vy: state.view.y };
      // Keep real clicks targeted at the node; capture after the drag threshold.
      if (!ev.target.closest('[data-visual-node], [data-visual-run]')) svg.setPointerCapture(ev.pointerId);
    });
    svg.addEventListener('pointermove', function (ev) {
      if (!drag || drag.id !== ev.pointerId) return;
      if (visualPointerMoved(drag, { x: ev.clientX, y: ev.clientY })) {
        suppressClick = true;
        if (!svg.hasPointerCapture(ev.pointerId)) svg.setPointerCapture(ev.pointerId);
      }
      if (!suppressClick) return;
      state.view.x = drag.vx + ev.clientX - drag.x;
      state.view.y = drag.vy + ev.clientY - drag.y;
      transform();
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (event) { svg.addEventListener(event, function () { drag = null; }); });
    svg.addEventListener('wheel', function (ev) {
      ev.preventDefault(); var rect = svg.getBoundingClientRect(); zoom(Math.exp(-ev.deltaY * .001), ev.clientX - rect.left, ev.clientY - rect.top);
    }, { passive: false });
    host.onclick = function (ev) {
      if (suppressClick && ev.detail !== 0 && ev.target.closest('.visual-canvas')) { suppressClick = false; return; }
      suppressClick = false;
      var run = ev.target.closest('[data-visual-run]');
      if (run) { toggleRun(run.getAttribute('data-visual-run')); return; }
      var node = ev.target.closest('[data-visual-node]');
      if (node) { selectNode(node.getAttribute('data-visual-node')); return; }
      var layout = ev.target.closest('[data-visual-layout]');
      if (layout) {
        var selectedNode = state.selected && visible.byId[state.selected];
        var anchor = selectedNode ? { x: selectedNode.px * state.view.k + state.view.x, y: selectedNode.py * state.view.k + state.view.y } : null;
        state.layout = layout.getAttribute('data-visual-layout'); state.positions = Object.create(null); state.expanded = Object.create(null); state.displacements = Object.create(null); state.anchors = Object.create(null);
        try { localStorage.setItem('ai-access.visual-view-layout', state.layout); } catch (e) {}
        paint();
        if (anchor && visible.byId[state.selected]) { var nextNode = visible.byId[state.selected]; state.view.x = anchor.x - nextNode.px * state.view.k; state.view.y = anchor.y - nextNode.py * state.view.k; transform(); } else fit();
        return;
      }
      var tool = ev.target.closest('[data-visual-zoom]');
      if (tool) { var action = tool.getAttribute('data-visual-zoom'); if (action === 'fit') fit(); else zoom(action === 'in' ? 1.2 : 1 / 1.2, wrap.clientWidth / 2, wrap.clientHeight / 2); }
    };
    host.onkeydown = function (ev) {
      var target = ev.target.closest('g[role="button"]');
      if (target && (ev.key === 'Enter' || ev.key === ' ')) {
        ev.preventDefault();
        if (target.hasAttribute('data-visual-run')) toggleRun(target.getAttribute('data-visual-run'));
        else selectNode(target.getAttribute('data-visual-node'));
      }
    };
    paint();
    if (!state.fitted) fit();
    if (typeof ResizeObserver !== 'undefined') {
      var lastWidth = wrap.clientWidth;
      state.resizeObserver = new ResizeObserver(function () {
        if (wrap.clientWidth && wrap.clientWidth !== lastWidth) { lastWidth = wrap.clientWidth; fit(); }
      });
      state.resizeObserver.observe(wrap);
    }
    if (state.selected && graph.byId[state.selected]) selectNode(state.selected);
    else if (state.showAll || proposalHasNoNetChange(diff)) showAllDiff();
    else {
      var diffHost = document.querySelector('[data-diff-for="' + p.id + '"]');
      if (diffHost) { diffHost.innerHTML = '<div class="visual-diff-placeholder">Click a highlighted node to review its changes <button type="button" class="visual-show-all">Show all changes</button></div>'; diffHost.querySelector('.visual-show-all').onclick = showAllDiff; }
    }
    // Palette details enrich ports and colours; failures retain a readable fallback.
    var missingTypes = graph.nodes.map(function (n) { return n.type; }).filter(function (type, i, types) { return types.indexOf(type) === i && !Object.prototype.hasOwnProperty.call(visualTypeMetadata, type); });
    missingTypes.forEach(function (type) {
      visualTypeMetadata[type] = {};
      api('/node-types/' + encodeURIComponent(type) + '?help=0').then(function (meta) {
        visualTypeMetadata[type] = meta;
        if (!host.isConnected || readProposalHashId() !== p.id) return;
        graph = visualGraph(p, diff); paint();
      }).catch(function () {});
    });
  }
`;
}

export function pageClientVisualScript(): string {
  return (
    pageClientVisualGeometryScript() +
    pageClientVisualGraphScript() +
    pageClientVisualRenderScript() +
    pageClientVisualInteractionScript() +
    pageClientVisualEventsScript()
  );
}
