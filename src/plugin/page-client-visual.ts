/** ES5 browser helpers for the proposal canvas. Kept separate from dashboard orchestration. */
export function pageClientVisualGeometryScript(): string {
  return `

  function visualFitView(boxes, w, h, topInset) {
    if (topInset === undefined) topInset = 48;
    var minX = Math.min.apply(null, boxes.map(function (b) { return b.x - b.w / 2; })) - 35;
    var maxX = Math.max.apply(null, boxes.map(function (b) { return b.x + b.w / 2; })) + 35;
    var minY = Math.min.apply(null, boxes.map(function (b) { return b.y - b.h / 2; })) - 8;
    var maxY = Math.max.apply(null, boxes.map(function (b) { return b.y + b.h / 2; })) + 8;
    var k = Math.min(1.2, (w - 24) / (maxX - minX));
    var scaledHeight = (maxY - minY) * k;
    var top = scaledHeight + topInset + 20 <= h ? Math.max(topInset, (h - scaledHeight) / 2) : topInset;
    return { k: k, x: w / 2 - (minX + maxX) / 2 * k, y: top - minY * k };
  }

  // Node-RED editor path-shaping constants, independent of displayed node sizes.
  var lineCurveScale = 0.75, node_width = 100, node_height = 30;
    function visualLinkPath(origX,origY, destX, destY, sc, hasStatus) {
        var dy = destY-origY;
        var dx = destX-origX;
        var delta = Math.sqrt(dy*dy+dx*dx);
        var scale = lineCurveScale;
        var scaleY = 0;
        if (dx*sc > 0) {
            if (delta < node_width) {
                scale = 0.75-0.75*((node_width-delta)/node_width);
            }
        } else {
            scale = 0.4-0.2*(Math.max(0,(node_width-Math.min(Math.abs(dx),Math.abs(dy)))/node_width));
        }
        if (dx*sc > 0) {
            var cp = [
                [(origX+sc*(node_width*scale)), (origY+scaleY*node_height)],
                [(destX-sc*(scale)*node_width), (destY-scaleY*node_height)]
            ]
            return \`M \${origX} \${origY} C \${cp[0][0]} \${cp[0][1]} \${cp[1][0]} \${cp[1][1]} \${destX} \${destY}\`
        } else {
            var topX, topY, bottomX, bottomY
            var cp
            var midX = Math.floor(destX-dx/2);
            var midY = Math.floor(destY-dy/2);
            if (Math.abs(dy) < 10) {
                bottomY = Math.max(origY, destY) + (hasStatus?35:25)
                var startCurveHeight = bottomY - origY
                var endCurveHeight = bottomY - destY
                cp = [
                    [ origX + sc*15 , origY ],
                    [ origX + sc*25 , origY + 5 ],
                    [ origX + sc*25 , origY + startCurveHeight/2 ],

                    [ origX + sc*25 , origY + startCurveHeight - 5 ],
                    [ origX + sc*15 , origY + startCurveHeight ],
                    [ origX , origY + startCurveHeight ],

                    [ destX - sc*15, origY + startCurveHeight ],
                    [ destX - sc*25, origY + startCurveHeight - 5 ],
                    [ destX - sc*25, destY + endCurveHeight/2 ],

                    [ destX - sc*25, destY + 5 ],
                    [ destX - sc*15, destY ],
                    [ destX, destY ],
                ]

                return "M "+origX+" "+origY+
                    " C "+
                    cp[0][0]+" "+cp[0][1]+" "+
                    cp[1][0]+" "+cp[1][1]+" "+
                    cp[2][0]+" "+cp[2][1]+" "+
                    " C " +
                    cp[3][0]+" "+cp[3][1]+" "+
                    cp[4][0]+" "+cp[4][1]+" "+
                    cp[5][0]+" "+cp[5][1]+" "+
                    " h "+dx+
                    " C "+
                    cp[6][0]+" "+cp[6][1]+" "+
                    cp[7][0]+" "+cp[7][1]+" "+
                    cp[8][0]+" "+cp[8][1]+" "+
                    " C " +
                    cp[9][0]+" "+cp[9][1]+" "+
                    cp[10][0]+" "+cp[10][1]+" "+
                    cp[11][0]+" "+cp[11][1]+" "
            } else {
                var cp_height = node_height/2;
                var y1 = (destY + midY)/2
                topX = origX + sc*node_width*scale;
                topY = dy>0?Math.min(y1 - dy/2 , origY+cp_height):Math.max(y1 - dy/2 , origY-cp_height);
                bottomX = destX - sc*node_width*scale;
                bottomY = dy>0?Math.max(y1, destY-cp_height):Math.min(y1, destY+cp_height);
                var x1 = (origX+topX)/2;
                var scy = dy>0?1:-1;
                cp = [
                    [x1,origY],
                    [topX,dy>0?Math.max(origY, topY-cp_height):Math.min(origY, topY+cp_height)],
                    [x1,dy>0?Math.min(midY, topY+cp_height):Math.max(midY, topY-cp_height)],
                    [bottomX,dy>0?Math.max(midY, bottomY-cp_height):Math.min(midY, bottomY+cp_height)],
                    [(destX+bottomX)/2,destY]
                ];
                if (cp[2][1] === topY+scy*cp_height) {
                    if (Math.abs(dy) < cp_height*10) {
                        cp[1][1] = topY-scy*cp_height/2;
                        cp[3][1] = bottomY-scy*cp_height/2;
                    }
                    cp[2][0] = topX;
                }
                return "M "+origX+" "+origY+
                    " C "+
                    cp[0][0]+" "+cp[0][1]+" "+
                    cp[1][0]+" "+cp[1][1]+" "+
                    topX+" "+topY+
                    " S "+
                    cp[2][0]+" "+cp[2][1]+" "+
                    midX+" "+midY+
                " S "+
                    cp[3][0]+" "+cp[3][1]+" "+
                    bottomX+" "+bottomY+
                    " S "+
                        cp[4][0]+" "+cp[4][1]+" "+
                        destX+" "+destY

            }
        }
    }

  // Flatten the emitted cubic segments adaptively, then walk half their length.
  function visualLinkPathMidpoint(d) {
    var tokens = d.match(/[MCS h]|[-+]?(?:\\d*\\.)?\\d+(?:e[-+]?\\d+)?/gi).filter(function (t) { return t !== ' '; });
    var i = 0, current = { x: 0, y: 0 }, previous = null, points = [], total = 0;
    function distance(a, b) { var x = b.x - a.x, y = b.y - a.y; return Math.sqrt(x*x + y*y); }
    function add(p) { if (points.length) total += distance(points[points.length - 1], p); points.push(p); }
    function middle(a, b) { return { x: (a.x+b.x)/2, y: (a.y+b.y)/2 }; }
    function flatten(a, b, c, end, depth) {
      if (depth >= 18 || distance(a,b) + distance(b,c) + distance(c,end) - distance(a,end) < 0.0001) { add(end); return; }
      var ab = middle(a,b), bc = middle(b,c), ce = middle(c,end), abc = middle(ab,bc), bce = middle(bc,ce), m = middle(abc,bce);
      flatten(a,ab,abc,m,depth+1); flatten(m,bce,ce,end,depth+1);
    }
    function point() { return { x: Number(tokens[i++]), y: Number(tokens[i++]) }; }
    while (i < tokens.length) {
      var command = tokens[i++], a, b, end;
      if (command === 'M') { current = point(); add(current); previous = null; }
      else if (command === 'h') { current = { x: current.x + Number(tokens[i++]), y: current.y }; add(current); previous = null; }
      else {
        a = command === 'S' ? (previous ? { x: 2*current.x-previous.x, y: 2*current.y-previous.y } : current) : point();
        b = point(); end = point(); flatten(current, a, b, end, 0); current = end; previous = b;
      }
    }
    var target = total / 2, travelled = 0;
    for (var j = 1; j < points.length; j++) {
      var length = distance(points[j-1], points[j]);
      if (travelled + length >= target && length) {
        var ratio = (target - travelled) / length;
        return { x: points[j-1].x + (points[j].x-points[j-1].x)*ratio, y: points[j-1].y + (points[j].y-points[j-1].y)*ratio };
      }
      travelled += length;
    }
    return current;
  }

  var visualMeasureContext;
  // Arial-compatible advances and kerning (2048 units/em, Liberation Sans).
  // Used only without Canvas, including Node tests; browsers measure the actual font.
  var visualArialWidths = [569, 569, 727, 1139, 1139, 1821, 1366, 391, 682, 682, 797, 1196, 569, 682, 569, 569, 1139, 1139, 1139, 1139, 1139, 1139, 1139, 1139, 1139, 1139, 569, 569, 1196, 1196, 1196, 1139, 2079, 1366, 1366, 1479, 1479, 1366, 1251, 1593, 1479, 569, 1024, 1366, 1139, 1706, 1479, 1593, 1366, 1593, 1479, 1366, 1251, 1479, 1366, 1933, 1366, 1366, 1251, 569, 569, 569, 961, 1139, 682, 1139, 1139, 1024, 1139, 1139, 569, 1139, 1139, 455, 455, 1024, 455, 1706, 1139, 1139, 1139, 1139, 682, 1024, 569, 1139, 1024, 1479, 1024, 1024, 1024, 684, 532, 684, 1196];
  var visualArialKerning = {" A": -113, " T": -37, " Y": -37, "11": -152, "A ": -113, "AT": -152, "AV": -152, "AW": -76, "AY": -152, "Av": -37, "Aw": -37, "Ay": -37, "F,": -227, "F.": -227, "FA": -113, "L ": -76, "LT": -152, "LV": -152, "LW": -152, "LY": -152, "Ly": -76, "P ": -37, "P,": -264, "P.": -264, "PA": -152, "RT": -37, "RV": -37, "RW": -37, "RY": -37, "T ": -37, "T,": -227, "T-": -113, "T.": -227, "T:": -227, "T;": -227, "TA": -152, "TO": -37, "Ta": -227, "Tc": -227, "Te": -227, "Ti": -76, "To": -227, "Tr": -76, "Ts": -227, "Tu": -76, "Tw": -113, "Ty": -113, "V,": -188, "V-": -113, "V.": -188, "V:": -76, "V;": -76, "VA": -152, "Va": -152, "Ve": -113, "Vi": -37, "Vo": -113, "Vr": -76, "Vu": -76, "Vy": -76, "W,": -113, "W-": -37, "W.": -113, "W:": -37, "W;": -37, "WA": -76, "Wa": -76, "We": -37, "Wo": -37, "Wr": -37, "Wu": -37, "Wy": -18, "Y ": -37, "Y,": -264, "Y-": -188, "Y.": -264, "Y:": -113, "Y;": -133, "YA": -152, "Ya": -152, "Ye": -188, "Yi": -76, "Yo": -188, "Yp": -152, "Yq": -188, "Yu": -113, "Yv": -113, "ff": -37, "r,": -113, "r.": -113, "v,": -152, "v.": -152, "w,": -113, "w.": -113, "y,": -152, "y.": -152};
  function visualTextWidth(label) {
    label = label.replace(/[\\t\\n\\r\\f]/g, ' ');
    if (visualMeasureContext === undefined) {
      visualMeasureContext = null;
      try { visualMeasureContext = document.createElement('canvas').getContext('2d'); } catch (e) {}
    }
    if (visualMeasureContext) {
      visualMeasureContext.font = '14px Arial';
      return visualMeasureContext.measureText(label).width;
    }
    var units = 0;
    for (var i = 0; i < label.length; i += 1) {
      var code = label.charCodeAt(i);
      units += code >= 32 && code <= 126 ? visualArialWidths[code - 32] : code >= 0x2e80 ? 2048 : 1139;
      if (i) units += visualArialKerning[label.slice(i - 1, i + 1)] || 0;
    }
    return units * 14 / 2048;
  }
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
  var visualOutlineOffset = 4;
  function visualOutlineStrokeWidth(selected) { return selected ? 3.75 : 2; }
  function visualMoveOutlinePad(selected) { return visualOutlineOffset + visualOutlineStrokeWidth(selected) / 2; }
  function visualMoveGeometry(old, next, width, height, pad) {
    pad = pad == null ? visualMoveOutlinePad(false) : pad;
    var dx = next.x - old.x, dy = next.y - old.y;
    // The ghost body must clear the destination outline before an arrow can fit.
    if (Math.abs(dx) <= width + pad && Math.abs(dy) <= height + pad) return null;
    var distance = Math.sqrt(dx * dx + dy * dy);
    var ghostScale = Math.min(dx ? width / 2 / Math.abs(dx) : Infinity, dy ? height / 2 / Math.abs(dy) : Infinity);
    var scale = Math.min(dx ? (width / 2 + pad) / Math.abs(dx) : Infinity, dy ? (height / 2 + pad) / Math.abs(dy) : Infinity);
    var gap = distance - distance * ghostScale - distance * scale, tipLength = 12, halfHead = 6;
    // The shaft starts at the ghost centre, so only the tip needs landing room.
    if (distance * (1 - scale) < tipLength) return null;
    var ux = dx / distance, uy = dy / distance;
    var start = { x: old.x, y: old.y };
    var end = { x: next.x - dx * scale, y: next.y - dy * scale };
    var shaftEnd = { x: end.x - ux * tipLength, y: end.y - uy * tipLength };
    return { start: start, end: end, shaftEnd: shaftEnd, gap: gap,
      headLeft: { x: shaftEnd.x - uy * halfHead, y: shaftEnd.y + ux * halfHead },
      headRight: { x: shaftEnd.x + uy * halfHead, y: shaftEnd.y - ux * halfHead } };
  }
`;
}

function pageClientVisualGraphScript(): string {
  return `
  function visualDetailsEscape(ev) {
    if (ev.key !== 'Escape' || ev.defaultPrevented) return;
    if (document.querySelector('dialog[open], #mobile-menu:not([hidden]), #approve-menu:not([hidden])')) return;
    var state = visualStates[readProposalHashId()];
    if (state && (state.selected || state.showAll) && state.closeDetails) { ev.preventDefault(); state.closeDetails(); }
  }
  document.addEventListener('keydown', visualDetailsEscape, true);
  var visualStates = {};
  var visualTypeMetadata = {};
  var visualColors = { inject: '#a6bbcf', function: '#fdd0a2', template: '#f3b567', debug: '#87a980', change: '#E2D96E', switch: '#E2D96E', 'http in': '#e7e7ae', 'http response': '#e7e7ae', comment: '#fff' };
  var visualStatusColors = { added: '#2a9d4a', removed: '#c65353', modified: '#2f6fed', moved: '#7a6fb0', conflict: '#dc9419' };
  function visualEditorType(raw) {
    try {
      var red = window.RED || window.parent && window.parent.RED;
      var definition = red && red.nodes && red.nodes.getType(raw.type);
      if (definition) return { red: red, definition: definition, node: Object.assign({}, raw, { _def: definition, _: definition._ }) };
    } catch (e) {}
    return null;
  }
  function visualSafeText(value) {
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
  }
  function visualNodeLabel(raw, editor) {
    if (editor) {
      try { return editor.red.utils.getNodeLabel(editor.node, raw.type); } catch (e) {}
    }
    var repeat = visualSafeText(raw.repeat || ''), crontab = visualSafeText(raw.crontab || ''), once = visualSafeText(raw.once || '');
    var suffix = raw.type === 'inject' ? (repeat && repeat != 0 || crontab ? '\\t↻' : once ? ' ¹' : '') : raw.type === 'debug' && (raw.console === true || raw.console === 'true') ? '\\t⇲' : '';
    var name = visualSafeText(raw.name), label = visualSafeText(raw.label);
    if (name) return name + suffix;
    if (label) return label;
    if (raw.type === 'debug') {
      var complete = visualSafeText(raw.complete || '');
      return (raw.targetType === 'jsonata' ? 'JSONata' : complete === 'true' ? 'msg' : 'msg.' + (!complete || complete === 'false' ? 'payload' : complete)) + suffix;
    }
    if (raw.type === 'http response') {
      var statusCode = visualSafeText(raw.statusCode);
      return 'http' + (statusCode ? ' (' + statusCode + ')' : '');
    }
    if (raw.type === 'http in') {
      var url = visualSafeText(raw.url), method = visualSafeText(raw.method) || 'get';
      return url ? '[' + method + '] ' + (url.charAt(0) === '/' ? url : '/' + url) : 'http';
    }
    if (raw.type === 'inject') {
      var payload = visualSafeText(raw.payload), topic = visualSafeText(raw.topic), payloadType = visualSafeText(raw.payloadType) || 'str';
      if (['string', 'str', 'num', 'bool', 'json'].indexOf(payloadType) >= 0) {
        if (topic && topic.length + payload.length <= 32) return topic + ':' + payload + suffix;
        return (payload && payload.length < 24 ? payload : 'inject') + suffix;
      }
      if (['date', 'bin', 'env'].indexOf(payloadType) >= 0) return (topic && topic.length <= 16 ? topic + ':' : '') + ({ date: 'timestamp', bin: 'buffer', env: 'env variable' }[payloadType]) + suffix;
      if (payloadType === 'flow' || payloadType === 'global') return payloadType + '.' + payload + suffix;
      return 'inject' + suffix;
    }
    if (raw.type === 'change') {
      var rules = Array.isArray(raw.rules) ? raw.rules : null;
      var rule = rules && rules.length === 1 ? rules[0] : !raw.rules ? { t: visualSafeText(raw.action) || 'delete', p: raw.property, pt: 'msg' } : null;
      if (rule && typeof rule === 'object' && !Array.isArray(rule)) {
        var action = visualSafeText(rule.t);
        return (['set', 'change', 'move', 'delete'].indexOf(action) >= 0 ? action : 'change') + ' ' + (visualSafeText(rule.pt) || 'msg') + '.' + (visualSafeText(rule.p) || 'payload');
      }
      return rules && rules.length !== 1 ? 'change: ' + rules.length + ' rules' : 'change';
    }
    if (raw.type === 'link in') return 'link in';
    if (raw.type === 'link out') return raw.mode === 'return' ? 'link return' : 'link out';
    if (raw.type === 'catch') return 'catch: ' + (raw.scope === 'group' ? 'group' : Array.isArray(raw.scope) ? raw.scope.length : visualSafeText(raw.uncaught || '') ? 'uncaught' : 'all');
    if (raw.type === 'complete') return 'complete: ' + (Array.isArray(raw.scope) ? raw.scope.length : 0);
    return visualSafeText(raw.type) || 'node';
  }
  function visualCollect(flow) {
    var result = Object.create(null);
    ((flow && flow.nodes) || []).concat((flow && flow.configs) || []).forEach(function (n) { result[n.id] = n; });
    return result;
  }
  function visualPortCount(raw, meta, key) {
    var value = typeof raw[key] === 'number' && isFinite(raw[key]) ? raw[key] : meta[key];
    if (typeof value !== 'number' || !isFinite(value)) {
      if (key === 'inputs') value = ['inject', 'comment', 'http in', 'mqtt in', 'link in', 'catch', 'status', 'complete'].indexOf(raw.type) >= 0 ? 0 : 1;
      else value = ['debug', 'link out', 'http response', 'comment'].indexOf(raw.type) >= 0 ? 0 : Array.isArray(raw.wires) ? raw.wires.length : 1;
    }
    return Math.max(0, Math.floor(value));
  }
  function visualFinite(value) { return typeof value === 'number' && isFinite(value); }
  function visualMedian(values) {
    values.sort(function (a, b) { return a - b; });
    var middle = Math.floor(values.length / 2);
    return values.length ? values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2 : 0;
  }
  function visualEditorPositions(base, proposed, live) {
    var reference = base || proposed, offsets = {}, neighbours = Object.create(null);
    ['x', 'y'].forEach(function (axis) {
      var values = [];
      Object.keys(reference).forEach(function (id) {
        if (live[id] && visualFinite(live[id][axis]) && visualFinite(reference[id][axis])) values.push(live[id][axis] - reference[id][axis]);
      });
      offsets[axis] = visualMedian(values);
    });
    Object.keys(proposed).forEach(function (id) { neighbours[id] = []; });
    Object.keys(proposed).forEach(function (id) {
      (proposed[id].wires || []).forEach(function (targets) { (targets || []).forEach(function (target) {
        if (neighbours[target]) { neighbours[id].push(target); neighbours[target].push(id); }
      }); });
    });
    function centre(id, axis) {
      return proposed[id] && visualFinite(proposed[id][axis]) ? proposed[id][axis] : base && base[id] && base[id][axis];
    }
    return function (id, axis, fallback) {
      if (live[id]) return visualFinite(live[id][axis]) ? live[id][axis] : fallback;
      // Removed nodes retain their base centre. Only proposed additions are translated.
      if (!proposed[id]) return fallback;
      var offset = offsets[axis], nearest = Infinity;
      if (base) (neighbours[id] || []).forEach(function (other) {
        if (!base[other] || !live[other] || !visualFinite(base[other][axis]) || !visualFinite(live[other][axis])) return;
        var x = centre(id, 'x'), y = centre(id, 'y'), ox = centre(other, 'x'), oy = centre(other, 'y');
        if (![x, y, ox, oy].every(visualFinite)) return;
        var distance = Math.pow(x - ox, 2) + Math.pow(y - oy, 2);
        if (distance < nearest) { nearest = distance; offset = live[other][axis] - base[other][axis]; }
      });
      return fallback + offset;
    };
  }
  function visualGraph(p, diff) {
    var before = visualCollect(p.baseFlow || p.visualLiveFlow), after = visualCollect(p.payload && p.payload.flow), live = visualCollect(p.visualLiveFlow), kinds = Object.create(null), entries = Object.create(null);
    // Capture proposal centres and wires before the unchanged-live overlay below.
    var editorPosition = p.visualLiveFlow ? visualEditorPositions(p.baseFlow ? visualCollect(p.baseFlow) : null, Object.assign(Object.create(null), after), live) : null;
    ['added', 'removed', 'modified', 'moved'].forEach(function (kind) {
      (diff[kind] || []).forEach(function (n) { kinds[n.id] = kind; entries[n.id] = n; });
    });
    (p.conflictChoices || (p.conflictChoice ? [p.conflictChoice] : [])).forEach(function (c) { kinds[c.nodeId] = 'conflict'; });
    ((diff.rebase && diff.rebase.conflicts) || []).forEach(function (c) { if (c.nodeId) kinds[c.nodeId] = 'conflict'; });
    Object.keys(live).forEach(function (id) {
      if (!kinds[id]) {
        // A deleted base node is a proposed removal, not unchanged live context.
        if (!before[id] || after[id]) after[id] = live[id];
      }
    });
    var ids = Object.keys(after).concat(Object.keys(before).filter(function (id) { return !after[id]; }));
    var groups = ids.map(function (id) { return after[id] || before[id]; }).filter(function (raw) { return raw.type === 'group'; });
    var nodes = ids.filter(function (id) { return (after[id] || before[id]).type !== 'group'; }).map(function (id, index) {
      var raw = after[id] || before[id], old = before[id], meta = visualTypeMetadata[raw.type] || {};
      var editor = visualEditorType(raw), name = visualNodeLabel(raw, editor);
      var outputs = visualPortCount(raw, meta, 'outputs');
      var renderedOutputs = Math.min(32, outputs);
      var input = visualPortCount(raw, meta, 'inputs') > 0;
      var width = Math.max(100, 20 * Math.ceil((visualTextWidth(name) + 50 + (input ? 7 : 0)) / 20));
      var icon = raw.icon || meta.icon, align = meta.align;
      if (editor) {
        try { icon = editor.red.utils.getNodeIcon(editor.definition, editor.node); align = editor.definition.align; } catch (e) {}
      } else if (raw.type === 'link out' && raw.mode === 'return' && icon === 'link-out.svg') icon = 'link-return.svg';
      var x = visualFinite(raw.x) ? raw.x : 100 + index * 180, y = visualFinite(raw.y) ? raw.y : 100;
      return { id: id, raw: raw, old: old, name: name, type: raw.type, kind: kinds[id] || '', entry: entries[id],
        w: width, h: Math.max(30, renderedOutputs * 15), outputs: renderedOutputs, hiddenOutputs: outputs - renderedOutputs,
        input: input, icon: icon, module: meta.module, align: align,
        editorMerged: !!(live[id] && old && JSON.stringify(live[id]) !== JSON.stringify(old)),
        color: /^#[0-9a-f]{3,8}$/i.test(meta.color || '') ? meta.color : (Object.prototype.hasOwnProperty.call(visualColors, raw.type) ? visualColors[raw.type] : '#d6dadd'),
        compactX: x, compactY: y,
        x: editorPosition ? editorPosition(id, 'x', x) : x,
        y: editorPosition ? editorPosition(id, 'y', y) : y,
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
    return { nodes: nodes, byId: byId, edges: edges, runs: runs, groups: groups };
  }
  // Give each ordered source-to-sink path a row. A node spanning several paths
  // sits midway between its first and last row, including nested diamonds.
  function visualCompactLanes(component, edges, rank, queue, byId, liveOrder) {
    var forward = Object.create(null), parents = Object.create(null), finished = Object.create(null);
    var bounds = Object.create(null), lanes = Object.create(null), row = 0;
    component.forEach(function (n) { forward[n.id] = []; parents[n.id] = 0; });
    queue.forEach(function (id) { finished[id] = true; });
    edges.forEach(function (e) {
      if (!forward[e.from] || !forward[e.to] || !finished[e.from] || !finished[e.to] || rank[e.to] <= rank[e.from]) return;
      forward[e.from].push(e); parents[e.to] += 1;
    });
    component.forEach(function (n) {
      function kindOrder(e) { return e.kind === 'removed' ? 0 : e.kind === 'added' ? 2 : 1; }
      forward[n.id].sort(function (a, b) { return kindOrder(a) - kindOrder(b) || a.port - b.port || liveOrder(byId[a.to], byId[b.to]); });
    });
    function visit(id, path) {
      var next = path.concat(id);
      if (forward[id].length && row < 4096) {
        forward[id].forEach(function (e) { visit(e.to, next); });
      } else {
        next.forEach(function (item) {
          if (!bounds[item]) bounds[item] = [row, row];
          bounds[item][1] = row;
        });
        row += 1;
      }
    }
    component.filter(function (n) { return !parents[n.id]; }).forEach(function (n) { visit(n.id, []); });
    // A path limit prevents exponential work in heavily cross-connected flows.
    component.forEach(function (n) { if (!bounds[n.id]) visit(n.id, []); });
    component.forEach(function (n) { lanes[n.id] = (bounds[n.id][0] + bounds[n.id][1]) / 2; });
    // Cross-connected paths can have coincident centres at one rank. Pack those
    // nodes in their existing order without allowing their boxes to overlap.
    var levels = Object.create(null);
    component.forEach(function (n) { (levels[rank[n.id]] = levels[rank[n.id]] || []).push(n); });
    Object.keys(levels).forEach(function (level) {
      levels[level].sort(function (a, b) { return lanes[a.id] - lanes[b.id] || liveOrder(a, b); });
      levels[level].forEach(function (n, i, nodes) {
        if (i) lanes[n.id] = Math.max(lanes[n.id], lanes[nodes[i - 1].id] + 1);
      });
    });
    return lanes;
  }
  function visualVisible(graph, state) {
    var replacement = Object.create(null), nodes = [], byId = Object.create(null);
    graph.runs.forEach(function (run) {
      if (state.expanded[run.id] || state.layout === 'editor') return;
      run.ids.forEach(function (id) { replacement[id] = run.id; });
      var first = graph.byId[run.ids[0]];
      nodes.push({ id: run.id, name: '… ' + run.ids.length + ' nodes', run: run, w: 110, h: 30, x: first.x, y: first.y, compactX: first.compactX, compactY: first.compactY, outputs: 1 });
    });
    graph.nodes.forEach(function (n) { if (!replacement[n.id]) nodes.push(n); });
    nodes.sort(function (a, b) {
      return (state.layout === 'editor' ? a.x - b.x || a.y - b.y : a.compactX - b.compactX || a.compactY - b.compactY) || a.id.localeCompare(b.id);
    });
    nodes.forEach(function (n) { byId[n.id] = n; });
    var edges = [], seen = Object.create(null);
    graph.edges.forEach(function (e) {
      var from = replacement[e.from] || e.from, to = replacement[e.to] || e.to, key = from + ':' + to + ':' + e.port;
      if (from === to || seen[key]) return;
      seen[key] = true; edges.push({ from: from, to: to, port: e.port, kind: e.kind });
    });
    if (state.layout === 'editor') {
      nodes.forEach(function (n) { n.px = n.x; n.py = n.y; });
    } else {
      var adjacent = Object.create(null), outgoing = Object.create(null), incoming = Object.create(null);
      nodes.forEach(function (n) { adjacent[n.id] = []; outgoing[n.id] = []; incoming[n.id] = 0; });
      edges.forEach(function (e) {
        adjacent[e.from].push(e.to); adjacent[e.to].push(e.from);
        outgoing[e.from].push(e.to); incoming[e.to] += 1;
      });
      function liveOrder(a, b) { return a.y - b.y || a.x - b.x || a.id.localeCompare(b.id); }
      var visited = Object.create(null), components = [];
      nodes.forEach(function (n) {
        if (visited[n.id]) return;
        var ids = [n.id], component = [];
        visited[n.id] = true;
        for (var i = 0; i < ids.length; i += 1) {
          component.push(byId[ids[i]]);
          adjacent[ids[i]].forEach(function (id) { if (!visited[id]) { visited[id] = true; ids.push(id); } });
        }
        component.sort(liveOrder);
        components.push(component);
      });
      components.sort(function (a, b) {
        var ay = Math.min.apply(null, a.map(function (n) { return n.y; })), by = Math.min.apply(null, b.map(function (n) { return n.y; }));
        var ax = Math.min.apply(null, a.map(function (n) { return n.x; })), bx = Math.min.apply(null, b.map(function (n) { return n.x; }));
        var aid = a.map(function (n) { return n.id; }).sort()[0], bid = b.map(function (n) { return n.id; }).sort()[0];
        return ay - by || ax - bx || aid.localeCompare(bid);
      });
      var top = 110;
      components.forEach(function (component) {
        var rank = Object.create(null), degree = Object.create(null), queued = Object.create(null), queue = [], widths = Object.create(null), offsets = [80];
        function enqueue(id) { queued[id] = true; queue.push(id); }
        component.forEach(function (n) { rank[n.id] = 0; degree[n.id] = incoming[n.id]; if (!degree[n.id]) enqueue(n.id); });
        for (var i = 0; i < component.length; i += 1) {
          if (i === queue.length) {
            var remaining = component.filter(function (n) { return !queued[n.id]; });
            remaining.sort(function (a, b) { return rank[b.id] - rank[a.id] || liveOrder(a, b); });
            enqueue(remaining[0].id);
          }
          outgoing[queue[i]].forEach(function (id) {
            if (queued[id]) return;
            rank[id] = Math.max(rank[id], rank[queue[i]] + 1);
            degree[id] -= 1; if (!degree[id]) enqueue(id);
          });
        }
        component.forEach(function (n) { widths[rank[n.id]] = Math.max(widths[rank[n.id]] || 0, n.w); });
        for (var r = 1; r <= component.length; r += 1) offsets[r] = offsets[r - 1] + (widths[r - 1] || 100) / 2 + 65 + (widths[r] || 100) / 2;
        var lane = visualCompactLanes(component, edges, rank, queue, byId, liveOrder);
        var values = component.map(function (n) { return lane[n.id]; });
        var minLane = Math.min.apply(null, values), maxLane = Math.max.apply(null, values);
        component.forEach(function (n) {
          var pos = state.positions[n.id];
          n.px = pos ? pos.x : offsets[rank[n.id]];
          n.py = pos ? pos.y : top + (lane[n.id] - minLane) * 85;
        });
        top += (maxLane - minLane + 1) * 85;
      });
    }
    return { nodes: nodes, edges: edges, byId: byId };
  }
`;
}

function pageClientVisualRenderScript(): string {
  return `
  function visualGroupBoxes(visible, groups) {
    var byId = Object.create(null);
    groups.forEach(function (group) { byId[group.id] = group; });
    return groups.map(function (group) {
      var members = Object.create(null), visited = Object.create(null);
      function collect(item) {
        if (visited[item.id]) return;
        visited[item.id] = true;
        (Array.isArray(item.nodes) ? item.nodes : []).forEach(function (id) {
          if (byId[id]) collect(byId[id]); else members[id] = true;
        });
      }
      collect(group);
      var nodes = visible.nodes.filter(function (node) {
        return members[node.id] || (node.run && node.run.ids.some(function (id) { return members[id]; }));
      });
      if (!nodes.length) return null;
      var left = Math.min.apply(null, nodes.map(function (n) { return n.px - n.w / 2; })) - 18;
      var right = Math.max.apply(null, nodes.map(function (n) { return n.px + n.w / 2; })) + 18;
      var top = Math.min.apply(null, nodes.map(function (n) { return n.py - n.h / 2; })) - (group.name ? 32 : 18);
      var bottom = Math.max.apply(null, nodes.map(function (n) { return n.py + n.h / 2; })) + 18;
      return { group: group, x: (left + right) / 2, y: (top + bottom) / 2, w: right - left, h: bottom - top };
    }).filter(function (box) { return box; });
  }
  function visualGroupMarkup(box) {
    var group = box.group, style = group.style || {}, left = box.x - box.w / 2, top = box.y - box.h / 2;
    var opacity = style['fill-opacity'] == null ? 0.5 : style['fill-opacity'];
    return '<g class="visual-group" pointer-events="none"><rect x="' + left + '" y="' + top + '" width="' + box.w + '" height="' + box.h + '" rx="4" ry="4" stroke="' + esc(style.stroke || '#a4a4a4') + '" fill="' + esc(style.fill || '#ffffff') + '" fill-opacity="' + esc(opacity) + '"/>' +
      (group.name ? '<text x="' + (left + 8) + '" y="' + (top + 18) + '" fill="' + esc(style.color || '#555') + '">' + esc(group.name) + '</text>' : '') + '</g>';
  }
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
  function visualIconUrls(n) {
    var icon = n.icon;
    if (typeof icon !== 'string' || !icon || /^(?:font-awesome\\/|fa[ -])/.test(icon)) return [];
    var root = editorRoot.replace(/\\/$/, '') + '/';
    if (icon.indexOf(root + 'icons/') === 0) icon = icon.slice((root + 'icons/').length);
    else if (icon.indexOf('/icons/') === 0) icon = icon.slice(7);
    // Palette identifiers only: never load remote URLs or arbitrary dashboard paths.
    if (!/^[a-z0-9_@./ -]+\\.(?:svg|png|gif|jpe?g|webp)$/i.test(icon) || icon.split('/').some(function (part) { return !part || part === '.' || part === '..'; })) return [];
    var file = icon.slice(icon.lastIndexOf('/') + 1);
    var path = icon.indexOf('/') >= 0 ? icon : (n.module || 'node-red') + '/' + icon;
    var paths = [path];
    if (/\\.png$/i.test(path)) paths.push(path.replace(/\\.png$/i, '.svg'));
    if (path !== 'node-red/' + file) {
      paths.push('node-red/' + file);
      if (/\\.png$/i.test(file)) paths.push('node-red/' + file.replace(/\\.png$/i, '.svg'));
    }
    return paths.map(function (p) { return root + 'icons/' + p.split('/').map(encodeURIComponent).join('/'); });
  }
  function visualPaletteIcon(n, x, y) {
    var urls = visualIconUrls(n);
    var fallback = '<svg class="visual-icon-fallback" x="' + x + '" y="' + y + '" width="30" height="30" viewBox="0 0 40 60">' + visualIcon(n.type) + '</svg>';
    return '<g class="visual-palette-icon" pointer-events="none">' + fallback + (urls.length ? '<image class="visual-icon-image" x="' + x + '" y="' + y + '" width="30" height="30" href="' + esc(urls[0]) + '" visibility="hidden" data-icon-urls="' + esc(JSON.stringify(urls)) + '" data-icon-index="0"/>' : '') + '</g>';
  }
  function visualIconEvent(ev) {
    var target = ev.target;
    if (!target || !target.classList || !target.classList.contains('visual-icon-image')) return;
    if (ev.type === 'load') {
      target.parentNode.querySelector('.visual-icon-fallback').setAttribute('visibility', 'hidden');
      target.removeAttribute('visibility');
    } else {
      var urls = JSON.parse(target.getAttribute('data-icon-urls') || '[]');
      var next = Number(target.getAttribute('data-icon-index')) + 1;
      if (next < urls.length) {
        target.setAttribute('data-icon-index', next);
        target.setAttribute('href', urls[next]);
      }
    }
  }
  function visualNodeSvg(n, state, oldPosition) {
    var ghost = !!oldPosition, context = !n.kind, right = n.align === 'right' || !n.align && n.type === 'debug', width = n.w, height = n.h;
    var color = ghost || !context ? n.color : '#d6dadd';
    var x = ghost ? Number(n.old.x) : n.px, y = ghost ? Number(n.old.y) : n.py;
    var outline = n.kind ? visualStatusColors[n.kind] : '#999';
    var interactive = !ghost && n.kind;
    var selected = state.selected === n.id;
    var ghostStyle = ghost ? ' stroke-dasharray="8,3" fill-opacity=".6"' : '';
    var svg = '<g class="visual-node' + (context ? ' context-node' : ' changed') + (ghost ? ' move-ghost' : '') + '"' +
      (ghost ? ' pointer-events="none"' : interactive ? ' role="button" tabindex="0" data-visual-node="' + esc(n.id) + '" aria-label="' + esc(n.kind + ': ' + n.name) + '"' : '') +
      ' transform="translate(' + (x - width / 2) + ',' + (y - height / 2) + ')">';
    if (interactive && selected) svg += '<rect class="selection-glow" x="' + -visualOutlineOffset + '" y="' + -visualOutlineOffset + '" width="' + (width + 2 * visualOutlineOffset) + '" height="' + (height + 2 * visualOutlineOffset) + '" rx="7" fill="none" stroke="' + outline + '" stroke-width="' + visualOutlineStrokeWidth(selected) + '" filter="url(#halo-' + n.kind + ')" pointer-events="none"/>';
    if (n.type === 'inject' || n.type === 'debug') svg += '<g transform="translate(' + (right ? width - 6 : -25) + ',2)"><rect width="32" height="26" rx="5" fill="#eee" stroke="#999"' + ghostStyle + '/><rect x="' + (right ? 11 : 5) + '" y="4" width="16" height="18" rx="4" fill="' + color + '" stroke="#999"' + ghostStyle + '/></g>';
    svg += '<rect class="node-body" width="' + width + '" height="' + height + '" rx="5" fill="' + color + '" stroke="#999"' + ghostStyle + '/>' +
      '<rect x="' + (right ? width - 30 : 0) + '" width="30" height="' + height + '" rx="5" fill="#000" opacity=".05"/>' +
      '<path d="M' + (right ? width - 30 : 30) + ' 1v' + (height - 2) + '" stroke="#000" opacity=".1"/>' +
      visualPaletteIcon(n, right ? width - 30 : 0, (height - 30) / 2) +
      '<text x="' + (right ? width - 38 : 38) + '" y="' + height / 2 + '" dominant-baseline="central" text-anchor="' + (right ? 'end' : 'start') + '" font-size="14" fill="#333"' +
      ' font-family="Arial, Helvetica, sans-serif"' + (n.raw.name ? ' font-style="italic"' : '') + '>' + esc(n.name) + '</text>';
    function port(px, py) { return '<rect x="' + px + '" y="' + py + '" width="10" height="10" rx="3" fill="#d9d9d9" stroke="#999" fill-opacity="1" stroke-dasharray="none"/>'; }
    if (n.input) svg += port(-5, height / 2 - 5);
    for (var i = 0; i < n.outputs; i += 1) svg += port(width - 5, height / 2 - (n.outputs - 1) * 6.5 + i * 13 - 5);
    if (n.hiddenOutputs) svg += '<text x="' + (width - 10) + '" y="' + (height - 4) + '" text-anchor="end" font-size="11" fill="#333">+' + esc(n.hiddenOutputs) + '</text>';
    if (!ghost && n.kind) svg += '<rect class="change-outline" x="' + -visualOutlineOffset + '" y="' + -visualOutlineOffset + '" width="' + (width + 2 * visualOutlineOffset) + '" height="' + (height + 2 * visualOutlineOffset) + '" rx="7" fill="none" stroke="' + outline + '" stroke-width="' + visualOutlineStrokeWidth(selected) + '"' + (!selected && (n.kind === 'conflict' || n.kind === 'removed') ? ' stroke-dasharray="6,4"' : '') + '/>';
    if (!ghost && n.kind) svg += '<circle cx="' + (width - 2) + '" cy="-6" r="8" fill="' + outline + '"/>' + statusIcon(n.kind, { x: width - 8, y: -12, size: 12, color: '#fff' });
    return svg + '</g>';
  }
  function visualPill(id, label, x, y, collapse) {
    return '<g class="' + (collapse ? 'visual-collapse' : 'visual-run') + '" role="button" tabindex="0" data-visual-run="' + esc(id) + '" aria-label="' + esc(label) + '" transform="translate(' + (x - 55) + ',' + (y - 15) + ')"><rect width="110" height="30" rx="15" fill="#f1f3f4" stroke="#999" stroke-dasharray="5,4"/><text x="55" y="15" text-anchor="middle" dominant-baseline="central" font-size="13" fill="#53616c">' + esc(label) + '</text></g>';
  }
  function visualDrawer(eyebrow, title, subtitle, body) {
    return '<section class="drawer" aria-label="Node change details"><div class="drawerhead"><div>' +
      '<div class="visual-eyebrow">' + esc(eyebrow) + '</div><h2>' + esc(title) + '</h2>' +
      '<span class="drawer-subtitle">' + esc(subtitle) + '</span></div>' +
      '<button type="button" class="drawer-close" aria-label="Close details">×</button></div>' +
      '<div class="drawercontent">' + body + '</div></section>';
  }
  function renderVisualNodeDrawer(n, p, diff) {
    var selectedDiff = Object.assign({}, diff);
    ['added', 'removed', 'modified', 'moved'].forEach(function (kind) {
      selectedDiff[kind] = (diff[kind] || []).filter(function (entry) { return entry.id === n.id; });
    });
    selectedDiff.tabProperties = [];
    selectedDiff.summary = Object.assign({}, diff.summary, { tabChanges: [] });
    var resolved = (p.conflictChoices || (p.conflictChoice ? [p.conflictChoice] : [])).some(function (entry) { return entry.nodeId === n.id; });
    var savedValues = diff.conflictValues && diff.conflictValues.length ? diff.conflictValues : proposalConflictValues[p.id] || [];
    var conflict = n.kind === 'conflict' || (resolved && savedValues.some(function (entry) { return entry.nodeId === n.id; }));
    var fields = ((diff.rebase && diff.rebase.conflicts) || p.rebase && p.rebase.conflicts || []).filter(function (c) { return c.nodeId === n.id; }).map(function (c) { return (c.fields || []).join(' / '); }).join(' / ');
    if (!fields && resolved) fields = savedValues.filter(function (entry) { return entry.nodeId === n.id; }).map(function (entry) { return entry.fields.map(function (v) { return v.field; }).filter(Boolean).join(' / '); }).join(' / ');
    var eyebrow = conflict ? 'CONFLICT / ' + (fields || n.type || 'node').toUpperCase() : (n.kind || 'modified').toUpperCase() + ' NODE';
    var conflictBody = renderConflictPanel(p, diff, n.id);
    var body = (diff.baseSnapshotMissing ? '<p class="muted">No starting snapshot was saved with this proposal, so changes are compared with the live flow.</p>' : '') +
      (conflict ? conflictBody : renderDiffSections(selectedDiff, getDiffMode(), 'Nothing changes.', true));
    if (!conflict && conflictBody) body = conflictBody + body;
    if (n.kind === 'added' || n.kind === 'removed') body = '<div class="drawer-notice">This node will be ' + (n.kind === 'added' ? 'added.' : 'deleted.') + '</div>' + body;
    if (n.kind !== 'added') body += '<div class="drawer-editor-link">' + editorJumpLink('node', n.id, 'Show in editor', 'editor-jump-small') + '</div>';
    body += '<button type="button" class="visual-show-all">Show all changes</button>';
    return visualDrawer(eyebrow, n.name, (n.type || 'node') + ' · ' + n.id, body);
  }
  function visualEmptyDetail() {
    return '<div class="visual-diff-placeholder">Click a highlighted node to review its changes <button type="button" class="visual-show-all">Show all changes</button></div>';
  }
  function visualMarkup(p, diff) {
    var touchHint = window.matchMedia && window.matchMedia('(pointer: coarse), (max-width: 760px)').matches;
    var counts = Object.assign({}, diff.summary, { conflict: ((diff.rebase && diff.rebase.conflicts) || []).map(function (c) { return c.nodeId; }).filter(function (id, i, ids) { return ids.indexOf(id) === i; }).length });
    return '<div class="visual-summary"><div class="visual-detail-counts">' + ['added', 'removed', 'modified', 'moved', 'conflict'].filter(function (kind) { return counts[kind]; }).map(function (kind) { return '<span>' + counts[kind] + ' ' + kind + '</span>'; }).join('') + '</div>' + '<div class="visual-legend">' + ['added', 'removed', 'modified', 'moved', 'conflict'].map(function (kind) {
      return '<span><i style="background:' + visualStatusColors[kind] + '">' + statusIcon(kind) + '</i>' + kind + '</span>';
    }).join('') + '<span><i class="context-dot"></i>Related nodes</span><span><i class="editor-merged-dot">' + statusIcon('editor-merged') + '</i>Editor-merged</span></div></div>' +
      '<section class="visual-workspace" aria-label="Visual View"><div class="visual-workhead"><strong>Flow preview <span>/ ' + esc(flowLabelOf(p)) + '</span></strong><span>Changed nodes + related nodes</span></div>' +
      '<div class="visual-body"><div class="visual-canvas-wrap"><svg class="visual-canvas" aria-label="Node-RED proposal flow"><defs>' + ['conflict', 'modified', 'moved', 'added', 'removed'].map(function (kind) {
        return '<filter id="halo-' + kind + '" x="-50%" y="-150%" width="200%" height="400%"><feDropShadow dx="0" dy="0" stdDeviation="4" flood-color="' + visualStatusColors[kind] + '" flood-opacity="1"/></filter>';
      }).join('') + '<pattern id="visual-grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" stroke="#eee"/></pattern></defs><rect width="100%" height="100%" fill="url(#visual-grid)"/><g class="visual-viewport"></g></svg>' +
      '<div class="visual-layout" role="group" aria-label="Layout mode"><button type="button" data-visual-layout="compact">Compact</button><button type="button" data-visual-layout="editor">Editor positions</button></div><div class="visual-canvas-note">READ-ONLY PREVIEW<br>Proposed flow · changes highlighted</div>' +
      '<span class="visual-pan-hint">Drag to pan' + (touchHint ? '' : ' · Ctrl / ⌘ + scroll to zoom') + '</span><div class="visual-tools"><span class="visual-zoom"></span><button type="button" data-visual-zoom="out" aria-label="Zoom out">−</button><button type="button" data-visual-zoom="in" aria-label="Zoom in">+</button><button type="button" data-visual-zoom="fit">⌗ Fit</button></div></div>' +
      '<aside class="visual-changed-list"><div class="visual-list-head"><strong>Changed nodes <span class="visual-list-count"></span></strong></div><div class="visual-node-list"></div><p>Related nodes are shown only on the canvas</p></aside></div><div class="detailregion proposal-diff" data-diff-for="' + esc(p.id) + '">' + visualEmptyDetail() + '</div></section>';
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
      var html = visualGroupBoxes(visible, graph.groups).map(visualGroupMarkup).join('');
      if (state.layout === 'editor') {
        graph.nodes.forEach(function (n) { if (n.moved) html += visualNodeSvg(n, state, true); });
        graph.nodes.forEach(function (n) {
          if (!n.moved) return;
          var arrow = visualMoveGeometry(n.old, { x: n.px, y: n.py }, n.w, n.h, visualMoveOutlinePad(state.selected === n.id));
          if (!arrow) return;
          html += '<g class="move-arrow" pointer-events="none"><path d="M' + arrow.start.x + ' ' + arrow.start.y + 'L' + arrow.shaftEnd.x + ' ' + arrow.shaftEnd.y + '" fill="none" stroke="#7a6fb0" stroke-width="2" stroke-dasharray="6,5"/>' +
            '<path class="move-arrowhead" d="M' + arrow.end.x + ' ' + arrow.end.y + 'L' + arrow.headLeft.x + ' ' + arrow.headLeft.y + 'L' + arrow.headRight.x + ' ' + arrow.headRight.y + 'Z" fill="#7a6fb0"/></g>';
        });
      }
      visible.edges.forEach(function (e) {
        var from = visible.byId[e.from], to = visible.byId[e.to], x = from.px + from.w / 2, y = from.py + (e.port - ((from.outputs || 1) - 1) / 2) * 13, end = to.px - to.w / 2;
        var d = visualLinkPath(x, y, end, to.py, 1, false);
        html += '<path d="' + d + '" fill="none" stroke="' + (visualStatusColors[e.kind] || '#999') + '" stroke-width="3"' + (e.kind === 'removed' ? ' stroke-dasharray="7,5"' : '') + '/>';
        if (e.kind === 'removed') {
          var midpoint = visualLinkPathMidpoint(d);
          html += '<g class="visual-removed-wire-mark" pointer-events="none" transform="translate(' + midpoint.x + ',' + midpoint.y + ')"><circle r="8" fill="#fff"/><path d="M-4 -4 L4 4 M4 -4 L-4 4" fill="none" stroke="#c65353" stroke-width="2.5"/></g>';
        }
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
        var resolved = (p.conflictChoices || (p.conflictChoice ? [p.conflictChoice] : [])).some(function (entry) { return entry.nodeId === n.id; }) && !((diff.rebase && diff.rebase.conflicts) || []).some(function (c) { return c.nodeId === n.id; });
        return '<button type="button" class="visual-change-row ' + n.kind + (state.selected === n.id ? ' selected' : '') + '" data-visual-node="' + esc(n.id) + '"><i style="background:' + visualStatusColors[n.kind] + '">' + statusIcon(n.kind) + '</i><span class="visual-node-type">' + esc(n.type) + '</span><strong>' + esc(n.name) + '</strong><span class="visual-node-summary">' + (resolved ? '<b class="resolved-marker">' + statusIcon('resolved') + ' Resolved · </b>' : '') + (n.editorMerged ? '<span class="editor-merged-marker" title="Also changed in the editor">' + statusIcon('editor-merged') + ' </span>' : '') + esc(n.entry && (n.entry.changes || []).map(function (ch) { return ch.key; }).join(' · ') || n.kind + ' node') + '</span><span class="visual-node-arrow">↗</span></button>';
      }).join('') || '<p class="muted">Only flow settings changed.</p>';
      transform();
    }
    function fit() {
      var boxes = visible.nodes.map(function (n) { return { x: n.px, y: n.py, w: n.w, h: n.h }; });
      boxes = boxes.concat(visualGroupBoxes(visible, graph.groups));
      if (state.layout === 'editor') graph.nodes.forEach(function (n) { if (n.moved) boxes.push({ x: n.old.x, y: n.old.y, w: n.w, h: n.h }); });
      if (!boxes.length) return;
      var w = wrap.clientWidth || 600, h = wrap.clientHeight || Math.round((typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 500) * 0.7);
      state.view = visualFitView(boxes, w, h);
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
    function detailHost() { return document.querySelector('[data-diff-for="' + p.id + '"]'); }
    function closeDetails() {
      state.selected = ''; state.showAll = false; paint();
      var details = detailHost();
      if (details) { details.innerHTML = visualEmptyDetail(); bindDetails(details); }
    }
    function bindDetails(details) {
      details.onclick = function (ev) {
        if (ev.target.closest('.drawer-close')) { closeDetails(); return; }
        if (ev.target.closest('.visual-show-all')) { showAllDiff(); return; }
        var mode = ev.target.closest('[data-diff-mode], [data-conflict-diff-mode]');
        if (mode) {
          setDiffMode(mode.getAttribute('data-diff-mode') || mode.getAttribute('data-conflict-diff-mode'));
          if (state.selected) selectNode(state.selected); else showAllDiff();
        }
      };
      bindPresencePreviewToggles(details);
      bindProposalActions(details);
    }
    function showAllDiff() {
      state.selected = ''; state.showAll = true; paint();
      var details = detailHost();
      if (details) {
        details.innerHTML = visualDrawer('PROPOSAL CHANGES', 'All changes', flowLabelOf(p), renderConflictPanel(p, diff) + renderHumanDiff(diff));
        bindDetails(details);
      }
    }
    function selectNode(id, bringIntoView) {
      var n = graph.byId[id];
      if (!n || !n.kind) return;
      state.selected = id; state.showAll = false; paint();
      if (bringIntoView) {
        var w = wrap.clientWidth || 600, h = wrap.clientHeight || Math.round((typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 500) * 0.7), k = state.view.k;
        var x = n.px * k + state.view.x, y = n.py * k + state.view.y;
        // Leave nodes that are comfortably visible in place; centre clipped or distant nodes.
        if (x - n.w * k / 2 < 48 || x + n.w * k / 2 > w - 48 || y - n.h * k / 2 < 48 || y + n.h * k / 2 > h - 48) {
          state.view.x = w / 2 - n.px * k;
          state.view.y = h / 2 - n.py * k;
          transform();
        }
      }
      var details = detailHost();
      if (details) { details.innerHTML = renderVisualNodeDrawer(n, p, diff); bindDetails(details); }
    }
    state.closeDetails = closeDetails;

`;
}

function pageClientVisualEventsScript(): string {
  return `
    // SVG image load/error events do not bubble; capture before the first paint.
    svg.addEventListener('load', visualIconEvent, true);
    svg.addEventListener('error', visualIconEvent, true);
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
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault(); var rect = svg.getBoundingClientRect(); zoom(Math.exp(-ev.deltaY * .001), ev.clientX - rect.left, ev.clientY - rect.top);
    }, { passive: false });
    host.onclick = function (ev) {
      if (suppressClick && ev.detail !== 0 && ev.target.closest('.visual-canvas')) { suppressClick = false; return; }
      suppressClick = false;
      var run = ev.target.closest('[data-visual-run]');
      if (run) { toggleRun(run.getAttribute('data-visual-run')); return; }
      var node = ev.target.closest('[data-visual-node]');
      if (node) { selectNode(node.getAttribute('data-visual-node'), true); return; }
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
        else selectNode(target.getAttribute('data-visual-node'), true);
      }
    };
    paint();
    if (!state.fitted) fit();
    if (typeof ResizeObserver !== 'undefined') {
      var lastWidth = wrap.clientWidth, lastDiffNarrow = window.innerWidth < 700;
      state.resizeObserver = new ResizeObserver(function () {
        if (wrap.clientWidth && wrap.clientWidth !== lastWidth) { lastWidth = wrap.clientWidth; fit(); }
        var narrow = window.innerWidth < 700;
        if (narrow !== lastDiffNarrow) {
          lastDiffNarrow = narrow;
          if (state.selected) selectNode(state.selected); else if (state.showAll) showAllDiff();
        }
      });
      state.resizeObserver.observe(wrap);
    }
    if (state.selected && graph.byId[state.selected]) selectNode(state.selected);
    else if (state.showAll || proposalHasNoNetChange(diff)) showAllDiff();
    else closeDetails();
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
