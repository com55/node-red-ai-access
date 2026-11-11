/** Proposal detail routing and deploy controls, concatenated inside the dashboard IIFE. */
export function pageClientReviewScript(): string {
  return `
  function closeDashboardMenu(restore) {
    var drawer = $('mobile-menu');
    if (!drawer) return;
    drawer.hidden = true;
    $('menu-scrim').hidden = true;
    $('menu-toggle').setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
    if (restore) $('menu-toggle').focus();
  }
  function setupDashboardMenu() {
    $('menu-toggle').onclick = function () {
      $('mobile-menu').hidden = false;
      $('menu-scrim').hidden = false;
      $('menu-toggle').setAttribute('aria-expanded', 'true');
      document.body.style.overflow = 'hidden';
      $('menu-close').focus();
    };
    $('menu-close').onclick = function () { closeDashboardMenu(true); };
    $('menu-scrim').onclick = function () { closeDashboardMenu(true); };
    $('mobile-menu').addEventListener('keydown', function (ev) { trapDialogFocus($('mobile-menu'), ev); });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !$('mobile-menu').hidden) { ev.preventDefault(); closeDashboardMenu(true); }
    });
    window.addEventListener('resize', function () {
      if (window.innerWidth > 850) closeDashboardMenu(false);
    });
  }
  function setupStickyNav() {
    var header = document.querySelector('.dashboard-header');
    if (!header) return;
    function measure() {
      var height = header.getBoundingClientRect().height;
      if (height > 0) document.documentElement.style.setProperty('--nav-height', (height + 20) + 'px');
    }
    window.addEventListener('resize', measure);
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(measure).observe(header);
    measure();
  }
  function openProposalDetail(id) {
    proposalListScroll = window.scrollY || 0;
    location.hash = '/proposals/' + encodeURIComponent(id);
  }
  function backToProposals() {
    location.hash = '/proposals';
  }
  var detailLoadId = '';
  var detailLoadGen = 0;
  async function showProposalDetail(id) {
    var host = $('proposal-detail-page');
    if (!host || detailLoadId === id) return;
    detailLoadId = id;
    var gen = ++detailLoadGen;
    var sameDetail = host.getAttribute('data-detail-id') === id;
    if (!sameDetail) {
      host.setAttribute('data-detail-id', id);
      host.innerHTML = '<button type="button" class="action secondary back-proposals">← Proposals</button><p role="status">Loading proposal…</p>';
      host.querySelector('.back-proposals').onclick = backToProposals;
      window.scrollTo(0, 0);
    }
    try {
      var p = await api('/proposals/' + encodeURIComponent(id) + '?include=payload,baseFlow');
      if (readProposalHashId() !== id || gen !== detailLoadGen) return;
      try { var live = await api('/flows/' + encodeURIComponent(p.flowId || p.payload.flowId)); p.visualLiveFlow = live.flow || live; } catch (e) {}
      if (readProposalHashId() !== id || gen !== detailLoadGen) return;
      proposalDetails[id] = p;
      var index = cachedProposals.map(function (item) { return item.id; }).indexOf(id);
      if (index < 0) cachedProposals.push(p); else cachedProposals[index] = p;
      preserveUiState(host, function () { host.innerHTML = renderProposalCard(p); });
      bindProposalActions(host);
      await loadProposalDiff(id);
    } catch (e) {
      if (readProposalHashId() !== id || gen !== detailLoadGen) return;
      host.innerHTML = '<button type="button" class="action secondary back-proposals">← Proposals</button>' +
        '<p class="flash error" role="alert">Could not open proposal. ' + esc(e.message || String(e)) + '</p>';
      host.querySelector('.back-proposals').onclick = backToProposals;
    } finally {
      if (gen === detailLoadGen) detailLoadId = '';
    }
  }
  var deployTypes = [
    ['full', 'Full', 'Deploys everything in the workspace. Warning: full restarts the entire runtime.'],
    ['flows', 'Modified Flows', 'Only deploys flows that contain changed nodes'],
    ['nodes', 'Modified Nodes', 'Only deploys nodes that have changed']
  ];
  function deployTypeIcon(type, square) {
    var first = type === 'full' || type === 'flows';
    return '<svg aria-hidden="true" viewBox="0 0 32 32" width="32" height="32">' +
      (square ? '<path fill="#0a5c45" d="M0 0h32v32H0z"/>' : '') +
      '<path d="M2 13h10v5H2z" fill="' + (first ? '#fff' : 'none') + '" stroke="#fff" opacity="' + (first ? '1' : '.6') + '"/>' +
      '<path d="M19 8h10v5H19z" fill="#fff"/>' +
      '<path d="M19 21h10v5H19z" fill="' + (type === 'full' ? '#fff' : 'none') + '" stroke="#fff" opacity="' + (type === 'full' ? '1' : '.6') + '"/>' +
      '<path d="M11.5 15.5h2l4-5h2" fill="none" stroke="#fff" stroke-width="1.5"/></svg>';
  }
  function proposalDeployType(id) {
    var type = Object.prototype.hasOwnProperty.call(proposalDeployTypes, id) ? proposalDeployTypes[id] : defaultDeploy;
    return ['nodes', 'flows', 'full'].indexOf(type) >= 0 ? type : 'nodes';
  }
  function proposalForReview(id) {
    return cachedProposals.filter(function (p) { return p.id === id; })[0] || proposalDetails[id];
  }
  function renderReviewActionRow(p, stale) {
    var open = p.status === 'pending' || p.status === 'conflict';
    if (!open) return '<div class="action-row"><button type="button" class="action secondary back-proposals">← Proposals</button>' +
      '<p class="proposal-history-notice">Historical record — may no longer match the live flow.</p></div>';
    stale = stale || proposalIsStale(p);
    var type = proposalDeployType(p.id);
    var pending = !!proposalActionPending[p.id];
    var diff = proposalDiffCache[p.id];
    var disabled = pending || !canApprove || !open || stale || !diff || proposalHasNoNetChange(diff);
    var title = !canApprove ? 'Admin approval permission required' : !open ? 'Proposal already resolved' : stale ? 'Resolve conflicts before approving' : !diff ? 'Wait for the diff to load' : 'Deploy: ' + deployTypes.filter(function (item) { return item[0] === type; })[0][1];
    return '<div class="action-row"><button type="button" class="action secondary back-proposals">← Proposals</button>' +
      '<div class="review-actions"><button type="button" class="action secondary reject-btn" data-id="' + esc(p.id) + '"' + (pending || !canApprove || !open ? ' disabled' : '') + '>Reject</button>' +
      '<div class="approve-wrap"><div class="approve-split"><button type="button" class="action approve-btn" data-id="' + esc(p.id) + '" title="' + esc(title) + '"' + (disabled ? ' disabled' : '') + '>' + deployTypeIcon(type, false) + 'Approve</button>' +
      '<button type="button" class="approve-options" aria-label="Choose deploy type" aria-haspopup="menu" aria-expanded="false" aria-controls="approve-menu"' + (disabled ? ' disabled' : '') + '>▾</button></div>' +
      '<div id="approve-menu" role="menu" aria-label="Deploy type" hidden>' + deployTypes.map(function (item) {
        return '<button type="button" role="menuitem" tabindex="-1" data-deploy="' + item[0] + '" class="' + (item[0] === type ? 'selected' : '') + '">' + deployTypeIcon(item[0], true) + '<span><strong>' + item[1] + '</strong><small>' + item[2] + '</small></span></button>';
      }).join('') + '</div></div></div><span class="full-deploy-warn"' + (type === 'full' ? '' : ' hidden') + '>Warning: full restarts the entire runtime.</span></div>';
  }
  function closeApproveMenus(restore) {
    document.querySelectorAll('.approve-wrap').forEach(function (wrap) {
      var menu = wrap.querySelector('[role="menu"]'), toggle = wrap.querySelector('.approve-options');
      if (!menu.hidden) { menu.hidden = true; toggle.setAttribute('aria-expanded', 'false'); if (restore) toggle.focus(); }
    });
  }
  function bindReviewControls(host) {
    host.querySelectorAll('.back-proposals').forEach(function (btn) { bindOnce(btn, 'click', backToProposals); });
    host.querySelectorAll('.approve-wrap').forEach(function (wrap) {
      var toggle = wrap.querySelector('.approve-options'), menu = wrap.querySelector('[role="menu"]');
      function open() {
        if (toggle.disabled) return;
        menu.hidden = false;
        toggle.setAttribute('aria-expanded', 'true');
        menu.querySelector('.selected').focus();
      }
      bindOnce(toggle, 'click', function () { if (menu.hidden) open(); else closeApproveMenus(true); });
      toggle.onkeydown = function (ev) { if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); open(); } };
      menu.onclick = function (ev) {
        var item = ev.target.closest('[data-deploy]');
        if (!item) return;
        var id = wrap.querySelector('.approve-btn').getAttribute('data-id');
        if (proposalActionPending[id]) return;
        proposalDeployTypes[id] = item.getAttribute('data-deploy');
        var actions = wrap.closest('.proposal-actions');
        var p = proposalForReview(id);
        actions.innerHTML = renderReviewActionRow(p, proposalIsStale(p));
        bindProposalActions(actions);
        var focusTarget = actions.querySelector('.approve-options') || actions.querySelector('.back-proposals');
        if (focusTarget) focusTarget.focus();
      };
      menu.onkeydown = function (ev) {
        var items = Array.prototype.slice.call(menu.querySelectorAll('button')), index = items.indexOf(document.activeElement);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].indexOf(ev.key) < 0) return;
        ev.preventDefault();
        items[ev.key === 'Home' ? 0 : ev.key === 'End' ? items.length - 1 : (index + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
      };
    });
  }
  document.addEventListener('click', function (ev) { if (!ev.target.closest('.approve-wrap')) closeApproveMenus(false); });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closeApproveMenus(true); });
  window.addEventListener('hashchange', function () { closeApproveMenus(false); });
`;
}
