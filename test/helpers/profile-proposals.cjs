/* Run from the repository root with Node. Requires Playwright (or set
 * PROPOSAL_PROFILE_PLAYWRIGHT to its module path). No server/ports are used.
 * Optional: --baseline=<git revision>. Uses 500 lean rows and 40 ms/request;
 * browser CPU, JSON parsing, CSS and layout are real, network latency is synthetic.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');
const { chromium } = require(process.env.PROPOSAL_PROFILE_PLAYWRIGHT || 'playwright');
const revision = process.argv.find(arg => arg.startsWith('--baseline='))?.split('=')[1];
const modules = new Map();
function load(relative) {
  if (modules.has(relative)) return modules.get(relative);
  const source = revision
    ? execFileSync('git', ['show', revision + ':' + relative], { encoding: 'utf8' })
    : fs.readFileSync(relative, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  });
  const exports = {};
  new Function('exports', 'require', output.outputText)(exports, spec =>
    load(path.join(path.dirname(relative), spec.replace(/\.js$/, '.ts')))
  );
  modules.set(relative, exports);
  return exports;
}
const original = load('src/plugin/page-client.ts').pageClientScript();
const client = original.replace(
  '  boot();',
  `
  window.profile = { counts: {}, timings: {}, requests: [], parseMs: 0 };
  ['loadProposals','renderProposalsList','showProposalDetail','renderProposalCard','loadProposalDiff','renderCompactProposal','buildDisambiguatedTitles','proposalMatchesFilter','proposalMatchesSearch','mountProposalVisual'].forEach(function(name) {
    var fn = eval(name);
    eval(name + ' = function() { var t = performance.now(); profile.counts[name] = (profile.counts[name] || 0) + 1; try { return fn.apply(this, arguments); } finally { profile.timings[name] = (profile.timings[name] || 0) + performance.now() - t; } }');
  });
  var rows = Array.from({length: 500}, function(_,i) {return {id:'prop-' + String(i).padStart(8,'0'), status:'pending', title:'Update Test flow', flowId:'tab',flowLabel:'Test flow',createdAt:new Date(1700000000000 + i * 1000).toISOString(),changeCounts:{modified:1}};});
  var node = {id:'n',type:'function',name:'Build reply',x:100,y:100,func:'return msg;',wires:[[]]};
  var p = Object.assign({},rows[0],{baseFlow:{nodes:[node]},payload:{flowId:'tab',flow:{nodes:[Object.assign({},node,{func:'msg.payload = 1; return msg;'})]}}});
  var diff = {summary:{added:0,removed:0,modified:1,moved:0,tabChanges:[]},added:[],removed:[],modified:[{id:'n',type:'function',changes:[{key:'func',kind:'text',lines:[{op:'remove',text:'return msg;'},{op:'add',text:'msg.payload = 1; return msg;'}]}]}],moved:[]};
  api = async function(url) {
    profile.requests.push(url);
    await new Promise(function(r){setTimeout(r,40)});
    var data = url === '/status' ? {aiFeaturesEnabled:true,capabilities:{approveProposals:true},adminAuthEnabled:true} :
      url === '/flows' ? {flows:[]} : url.indexOf('?status=pending') >= 0 ? {proposals:rows} : url.indexOf('?status=') >= 0 ? {proposals:[]} :
      url.indexOf('/diff') >= 0 ? diff : url.indexOf('/flows/') === 0 ? {flow:{nodes:[node]}} : url.indexOf('/node-types/') === 0 ? {} : p;
    var json = JSON.stringify(data), t = performance.now(); var parsed = JSON.parse(json); profile.parseMs += performance.now() - t; return parsed;
  };
  aiOn = true; canApprove = true; cachedProposals = rows;
  if (typeof proposalsLoaded !== 'undefined') proposalsLoaded = true;
  document.querySelectorAll('section.panel').forEach(function(el){el.hidden=false;});
  profile.rows = rows; profile.back = backToProposals;
  profile.focus = function() {lastAutoRefresh = 0; window.dispatchEvent(new Event('focus'));};
  profile.state = function() {return visualStates[p.id];};
  profile.reset = function() {profile.counts={}; profile.timings={}; profile.requests=[];profile.parseMs=0;};
  profile.result = function() {return JSON.parse(JSON.stringify({counts:profile.counts,timings:profile.timings,requests:profile.requests,parseMs:profile.parseMs}));};
`
);
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proposal-profile-'));
  const htmlPath = path.join(dir, 'profile.html');
  fs.writeFileSync(
    htmlPath,
    load('src/plugin/page.ts')
      .renderMcpPage({ apiBase: '/api', authTokenKey: 'auth-tokens' })
      .replace(original, () => client)
  );
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox'],
  });
  try {
    const runs = [];
    for (let i = 0; i < 5; i++) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(pathToFileURL(htmlPath).href + '#status');
      const cached = await page.evaluate(async () => {
        document.querySelector('nav.tabs button[data-tab="status"]').click();
        document.querySelector('#proposal-detail-page').hidden = false;
        document.querySelector('#proposals-list').hidden = true;
        profile.reset();
        var t = performance.now();
        document.querySelector('nav.tabs button[data-tab="proposals"]').click();
        var syncMs = performance.now() - t,
          syncHidden = document.querySelector('#proposal-detail-page').hidden;
        while (
          document.querySelector('#proposals-list').hidden ||
          !document.querySelector('.proposal-card-compact')
        )
          await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        return { paintMs: performance.now() - t, syncMs, syncHidden, ...profile.result() };
      });
      await page.waitForTimeout(250);
      await page.evaluate(() => {
        profile.reset();
        location.hash = '/proposals/' + profile.rows[0].id;
      });
      await page.waitForTimeout(350);
      const detail = await page.evaluate(() => profile.result());
      await page.locator('.visual-change-row[data-visual-node="n"]').click();
      await page.evaluate(() => {
        var state = profile.state();
        state.view = { k: 1.7, x: 50, y: -35 };
        window.scrollTo(0, 180);
        profile.rows[1].title = 'An unrelated update';
        profile.reset();
        profile.focus();
      });
      const focusBefore = await page.evaluate(() => ({
        state: JSON.stringify(profile.state().view),
        selected: profile.state().selected,
        scroll: window.scrollY,
      }));
      await page.waitForTimeout(350);
      const focus = await page.evaluate(() => ({
        ...profile.result(),
        state: JSON.stringify(profile.state().view),
        selected: profile.state().selected,
        scroll: window.scrollY,
        drawer: !!document.querySelector('.drawer:not([hidden])'),
      }));
      const back = await page.evaluate(async () => {
        profile.reset();
        var t = performance.now();
        profile.back();
        var syncMs = performance.now() - t,
          syncHidden = document.querySelector('#proposal-detail-page').hidden;
        while (document.querySelector('#proposals-list').hidden)
          await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        return { paintMs: performance.now() - t, syncMs, syncHidden, ...profile.result() };
      });
      runs.push({ cached, detail, focusBefore, focus, back, errors });
      await page.close();
    }
    const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    console.log(
      JSON.stringify(
        {
          revision: revision || 'working tree',
          medianMs: {
            cachedPaint: median(runs.map(r => r.cached.paintMs)),
            cachedSync: median(runs.map(r => r.cached.syncMs)),
            backPaint: median(runs.map(r => r.back.paintMs)),
            backSync: median(runs.map(r => r.back.syncMs)),
          },
          runs,
        },
        null,
        2
      )
    );
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
