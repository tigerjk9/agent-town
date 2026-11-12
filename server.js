#!/usr/bin/env node
/*
 * 에이전트 타운 서버
 *  - GitHub 저장소·이벤트·Actions 를 주기적으로 읽어 "마을" 상태를 만든다
 *  - Claude Code 훅(hook.js)이 보내는 이벤트를 받아 "공장 안 에이전트" 상태를 만든다
 *  - 브라우저에는 /api/state(전체) + /api/stream(SSE 실시간)으로 보낸다
 * 의존성 없음. Node 18 이상.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = __dirname;
function readJSON(f) { try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')); } catch (e) { return {}; } }
(function loadEnv() {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const cfg = Object.assign({
  port: 4747, host: '127.0.0.1', title: '코드 마을', githubUser: '',
  includeForks: true, pollEventsSec: 30, pollRunsSec: 60, idleMinutes: 10,
  conflictWindowSec: 120, vacationMinutes: 20, allowedOrigins: [], names: {}
}, readJSON('factory.config.json'));
if (process.env.AGENT_TOWN_PORT) cfg.port = +process.env.AGENT_TOWN_PORT;

/* ---------------- 상태 ---------------- */
const repos = new Map();
const agents = new Map();
const log = [];
const stats = { pushesToday: 0 };
const clients = new Set();

function send(msg) { const s = 'data: ' + JSON.stringify(msg) + '\n\n'; for (const c of clients) c.write(s); }
function state() {
  return { agentTown: true, user: GH.user, title: cfg.title, repos: [...repos.values()], agents: [...agents.values()],
    log: log.slice(0, 120), stats, vacationMinutes: cfg.vacationMinutes, github: { ok: GH.ok, token: !!GH.token, remaining: GH.remaining } };
}
function addLog(repo, text, kind) {
  const e = { t: Date.now(), repo, text, kind };
  log.unshift(e); if (log.length > 300) log.length = 300;
  send({ type: 'log', entry: e });
}
function findRepoId(id) {
  if (!id) return null;
  if (repos.has(id)) return id;
  const low = id.toLowerCase();
  for (const k of repos.keys()) if (k.toLowerCase() === low) return k;
  return null;
}
function ensureRepo(id) {
  const found = findRepoId(id);
  if (found) return found;
  const r = { id, name: id.split('/').pop(), fork: false, private: false, pushedAt: Date.now(), lang: null, desc: id.startsWith('local/') ? '내 PC에만 있는 폴더' : '',
    url: id.startsWith('local/') ? '' : 'https://github.com/' + id, done: 0, local: id.startsWith('local/') };
  repos.set(id, r); send({ type: 'repo', repo: r });
  return id;
}
function upRepo(id, patch) { const r = repos.get(id); if (!r) return; Object.assign(r, patch); send({ type: 'repo', repo: r }); }
function upAgent(id, patch) {
  const a = Object.assign(agents.get(id) || { id, kind: 'local', room: 'lounge', status: 'idle' }, patch, { updatedAt: Date.now() });
  agents.set(id, a); send({ type: 'agent', agent: a }); return a;
}
function rmAgent(id) { if (agents.delete(id)) send({ type: 'agent-remove', id }); }
const isToday = t => new Date(t).toDateString() === new Date().toDateString();

/* ---------------- 분류 규칙 ---------------- */
function classifyText(s) {
  s = (s || '').toLowerCase();
  if (/deploy|release|publish|pages|ship|vercel|netlify|firebase|upload/.test(s)) return 'ship';
  if (/test|lint|check|verify|e2e|playwright|cypress|jest|vitest|pytest|typecheck|audit|scan|codeql/.test(s)) return 'verify';
  if (/build|compile|bundle|install|setup|checkout|cache|docker|jekyll/.test(s)) return 'build';
  if (/icon|image|asset|svg|png|design/.test(s)) return 'atelier';
  return null;
}
function roomForFile(f) {
  f = f || '';
  if (/\.(png|jpe?g|gif|svg|ico|webp|avif)$/i.test(f) || /(^|\/)(icons?|images?|img)\//i.test(f)) return 'atelier';
  if (/(^|\/)(tests?|__tests__|spec)\//i.test(f) || /\.(test|spec)\.[a-z]+$/i.test(f)) return 'verify';
  return 'dev';
}
function roomForCmd(c) {
  c = c || '';
  if (/\bgit\s+push\b|\bdeploy\b|vercel|netlify|firebase\s+deploy|gh\s+(pr\s+create|release)|npm\s+publish|wrangler/i.test(c)) return 'ship';
  if (/\bgit\s+(commit|tag)\b/i.test(c)) return 'ship';
  if (/\b(test|jest|vitest|pytest|playwright|cypress|lint|eslint|typecheck)\b|tsc\s+--noEmit|screenshot/i.test(c)) return 'verify';
  if (/\b(build|webpack|vite|tsc|make|cargo|gradle|compile|bundle|jekyll)\b/i.test(c) || /\b(npm|pnpm|yarn|bun|pip3?)\s+(i|install|ci|add)\b/i.test(c)) return 'build';
  return null;
}

/* ---------------- Claude Code 훅 처리 ---------------- */
const cwdRepo = new Map();
function git(args) { return new Promise(res => execFile('git', args, { timeout: 2000, windowsHide: true }, (e, out) => res(e ? null : String(out).trim()))); }
async function repoFromCwd(cwd) {
  if (!cwd) return 'local/unknown';
  if (cwdRepo.has(cwd)) return cwdRepo.get(cwd);
  let id = null;
  const url = await git(['-C', cwd, 'remote', 'get-url', 'origin']);
  const m = url && url.match(/github\.com[:/]+([^/]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (m) id = m[1] + '/' + m[2];
  if (!id) { const top = await git(['-C', cwd, 'rev-parse', '--show-toplevel']); id = 'local/' + path.basename(top || cwd); }
  cwdRepo.set(cwd, id);
  return id;
}
const recentWrites = new Map(); // repo|file -> {id,name,t}
function checkConflict(repo, a, file) {
  if (!file) return;
  const key = repo + '|' + file, w = recentWrites.get(key), now = Date.now();
  if (w && w.id !== a.id && agents.has(w.id) && now - w.t < cfg.conflictWindowSec * 1000) {
    [w.id, a.id].forEach(id => upAgent(id, { conflict: file }));
    addLog(repo, '⚠️ 충돌 · ' + file + ' ← ' + w.name + ', ' + a.name + ' 동시 수정', 'conflict');
    setTimeout(() => [w.id, a.id].forEach(id => { const x = agents.get(id); if (x && x.conflict === file) upAgent(id, { conflict: null }); }), 60000);
  }
  recentWrites.set(key, { id: a.id, name: a.name, t: now });
}
function agentName(p, repo, cwd) {
  if (p.name) return p.name;
  const base = path.basename(cwd || '') || 'Claude';
  if (cfg.names[p.session_id]) return cfg.names[p.session_id];
  if (cfg.names[base]) return cfg.names[base];
  if (p.agent_type) return p.agent_type;
  const nm = base.toLowerCase() === repo.split('/').pop().toLowerCase() ? 'Claude' : base;
  const same = [...agents.values()].filter(x => x.repo === repo && x.baseName === nm).length;
  return same ? nm + ' #' + (same + 1) : nm;
}
async function handleHook(p) {
  if (!p || !p.hook_event_name || !p.session_id) return;
  const repo = ensureRepo(await repoFromCwd(p.cwd));
  const id = p.session_id + (p.agent_id ? ':' + p.agent_id : '');
  let a = agents.get(id);
  if (!a) {
    const name = agentName(p, repo, p.cwd);
    a = upAgent(id, { repo, name, baseName: name.replace(/ #\d+$/, ''), kind: 'local', room: 'lounge', status: 'idle', detail: '출근' });
    addLog(repo, '👋 ' + a.name + ' 출근', 'start');
  }
  const ev = p.hook_event_name, tool = p.tool_name || '', ti = p.tool_input || {};
  const rel = f => f ? (p.cwd && f.startsWith(p.cwd) ? f.slice(p.cwd.length).replace(/^[\\/]+/, '') : f).replace(/\\/g, '/') : '';
  const keepRoom = () => (a.room === 'lounge' || !a.room ? 'dev' : a.room);
  const patch = {};
  switch (ev) {
    case 'SessionStart': Object.assign(patch, { room: 'lounge', status: 'idle', detail: p.source === 'resume' ? '다시 접속' : '출근' }); break;
    case 'UserPromptSubmit':
      Object.assign(patch, { room: 'plan', status: 'working', detail: '요청: ' + (p.prompt || '').replace(/\s+/g, ' ').slice(0, 40), file: null });
      addLog(repo, '📝 ' + a.name + ' 새 요청 받음', 'start'); break;
    case 'PreToolUse': {
      patch.status = 'working';
      const file = rel(ti.file_path);
      if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) { Object.assign(patch, { room: roomForFile(file), detail: '수정 중 ' + file, file }); checkConflict(repo, a, file); }
      else if (/^(Read|Grep|Glob|LS|NotebookRead)$/.test(tool)) Object.assign(patch, { room: a.room === 'lounge' || !a.room ? 'plan' : a.room, detail: '읽는 중 ' + (file || ti.pattern || '') });
      else if (/^(WebSearch|WebFetch)$/.test(tool)) Object.assign(patch, { room: 'plan', detail: tool === 'WebSearch' ? '검색: ' + (ti.query || '') : '웹 읽기' });
      else if (/^(TodoWrite|TaskCreate|TaskUpdate|ExitPlanMode)$/.test(tool)) Object.assign(patch, { room: 'plan', detail: '할 일 정리' });
      else if (/^(Task|Agent)$/.test(tool)) Object.assign(patch, { room: 'plan', detail: '서브에이전트 호출: ' + (ti.description || ti.subagent_type || '') });
      else if (tool === 'Bash') { const cmd = (ti.command || '').replace(/\s+/g, ' '); Object.assign(patch, { room: roomForCmd(cmd) || keepRoom(), detail: '$ ' + cmd.slice(0, 60) }); }
      else if (tool.startsWith('mcp__')) {
        const nm = tool.slice(5).split('__').join(' › ');
        Object.assign(patch, { room: /screenshot|browser|playwright|preview|chrome/i.test(tool) ? 'verify' : /image|figma|canva|design/i.test(tool) ? 'atelier' : keepRoom(), detail: '🔌 ' + nm });
      } else Object.assign(patch, { room: keepRoom(), detail: tool });
      break;
    }
    case 'PostToolUse':
      if (p.tool_error) { patch.detail = '오류: ' + tool; break; }
      if (tool === 'Bash' && /\bgit\s+push\b|\bdeploy\b|npm\s+publish|gh\s+release/i.test(ti.command || '')) {
        send({ type: 'fx', fx: { kind: 'rocket', repo } }); addLog(repo, '🚀 ' + a.name + ' 푸시/배포', 'push');
      }
      break;
    case 'Notification': Object.assign(patch, { status: 'waiting', detail: '❗ ' + (p.message || '확인 필요').slice(0, 60) }); addLog(repo, '❗ ' + a.name + ': ' + (p.message || '확인 필요'), 'wait'); break;
    case 'Stop':
    case 'SubagentStop':
      if (ev === 'SubagentStop' && !p.agent_id) return;
      Object.assign(patch, { room: 'lounge', status: 'idle', detail: '작업 완료', file: null });
      upRepo(repo, { done: (repos.get(repo).done || 0) + 1 });
      send({ type: 'fx', fx: { kind: 'confetti', repo, agent: id } });
      addLog(repo, '✅ ' + a.name + ' 작업 완료', 'done');
      if (ev === 'SubagentStop') setTimeout(() => rmAgent(id), 30000);
      break;
    case 'SessionEnd':
      Object.assign(patch, { room: 'lounge', status: 'idle', detail: '퇴근' }); addLog(repo, '🌙 ' + a.name + ' 퇴근', 'end');
      setTimeout(() => rmAgent(id), 8000); break;
    default: return;
  }
  upAgent(id, patch);
}
setInterval(() => {
  const now = Date.now();
  for (const a of agents.values()) {
    if (a.kind !== 'local') continue;
    if (a.status === 'working' && now - a.updatedAt > cfg.idleMinutes * 60000) upAgent(a.id, { status: 'idle', detail: '한동안 조용함' });
    else if (a.status === 'idle' && now - a.updatedAt > 3 * 3600000) rmAgent(a.id);
  }
}, 30000);

/* ---------------- GitHub ---------------- */
const GH = { token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '', user: cfg.githubUser || process.env.GITHUB_USER || '', ok: false, etags: new Map(), remaining: 5000 };
async function gh(p) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'agent-town', 'X-GitHub-Api-Version': '2022-11-28' };
  if (GH.token) headers.Authorization = 'Bearer ' + GH.token;
  const cached = GH.etags.get(p);
  if (cached) headers['If-None-Match'] = cached.etag;
  const res = await fetch((process.env.GITHUB_API || 'https://api.github.com') + p, { headers });
  const rem = res.headers.get('x-ratelimit-remaining'); if (rem != null) GH.remaining = +rem;
  if (res.status === 304 && cached) return { data: cached.data, notModified: true };
  if (!res.ok) throw new Error('GitHub ' + res.status + ' ' + p);
  const data = await res.json();
  const tag = res.headers.get('etag'); if (tag) GH.etags.set(p, { etag: tag, data });
  return { data, notModified: false };
}
function ghCliToken() { return new Promise(res => execFile('gh', ['auth', 'token'], { timeout: 4000, windowsHide: true }, (e, out) => res(e ? '' : String(out).trim()))); }

async function loadRepos(first) {
  const list = [];
  for (let page = 1; page <= 5; page++) {
    const p = GH.token ? `/user/repos?per_page=100&sort=pushed&affiliation=owner&page=${page}` : `/users/${GH.user}/repos?per_page=100&sort=pushed&type=owner&page=${page}`;
    const { data } = await gh(p);
    list.push(...data); if (data.length < 100) break;
  }
  let changed = 0;
  for (const r of list) {
    if (!cfg.includeForks && r.fork) continue;
    const old = repos.get(r.full_name);
    const next = { id: r.full_name, name: r.name, fork: r.fork, private: r.private, pushedAt: Date.parse(r.pushed_at) || 0, lang: r.language, desc: r.description || '', url: r.html_url, done: old ? old.done : 0, local: false };
    if (!old || old.pushedAt !== next.pushedAt) changed++;
    repos.set(r.full_name, Object.assign(old || {}, next));
    if (old && !first && old.pushedAt !== next.pushedAt) send({ type: 'repo', repo: repos.get(r.full_name) });
  }
  return { count: list.length, changed };
}

let lastEventId = 0n, eventsPrimed = false;
function handleEvent(e, live) {
  const repo = ensureRepo(e.repo && e.repo.name);
  const p = e.payload || {}, t = Date.parse(e.created_at) || Date.now();
  const say = (text, kind) => { if (live) addLog(repo, text, kind); else { log.push({ t, repo, text, kind }); } };
  switch (e.type) {
    case 'PushEvent': {
      const branch = (p.ref || '').replace('refs/heads/', '');
      const commits = p.commits || [];
      const n = p.size != null ? p.size : commits.length;
      const last = commits[commits.length - 1];
      if (isToday(t)) stats.pushesToday++;
      say('📦 푸시 → ' + branch + (n ? ' · 커밋 ' + n + '개' : '') + (last && last.message ? ' · ' + last.message.split('\n')[0].slice(0, 50) : ''), 'push');
      if (!live) break;
      upRepo(repo, { pushedAt: Math.max(t, (repos.get(repo) || {}).pushedAt || 0) });
      send({ type: 'stats', stats });
      send({ type: 'fx', fx: { kind: 'push', repo, text: branch + (n ? ' +' + n : '') } });
      const byClaude = /^claude\//.test(branch) || commits.some(c => /claude/i.test((c.author && c.author.name) || '') || /Co-Authored-By: Claude/i.test(c.message || ''));
      if (byClaude) cloudVisit(repo, branch, last ? last.message.split('\n')[0] : '커밋');
      break;
    }
    case 'PullRequestEvent': {
      const pr = p.pull_request || {}, no = p.number || pr.number;
      if (p.action === 'opened') say('🔀 PR 열림 #' + no + ' ' + (pr.title || ''), 'pr');
      else if (p.action === 'closed' && pr.merged) { say('🎉 PR 병합 #' + no + ' ' + (pr.title || ''), 'pr'); if (live) send({ type: 'fx', fx: { kind: 'confetti', repo } }); }
      else if (p.action === 'closed') say('PR 닫힘 #' + no, 'pr');
      break;
    }
    case 'CreateEvent':
      if (p.ref_type === 'repository') { say('🏗 새 저장소 생성', 'create'); if (live) loadRepos(false).catch(() => {}); }
      else if (p.ref_type === 'branch') say('🌿 새 브랜치 ' + p.ref, 'create');
      break;
    case 'ReleaseEvent': say('🚀 릴리스 ' + ((p.release && (p.release.name || p.release.tag_name)) || ''), 'release'); if (live) send({ type: 'fx', fx: { kind: 'rocket', repo } }); break;
    case 'WatchEvent': say('⭐ 스타 받음', 'star'); break;
    case 'ForkEvent': say('🍴 포크됨', 'fork'); break;
    case 'IssuesEvent': if (p.action === 'opened') say('📝 이슈 열림 #' + (p.issue && p.issue.number), 'issue'); break;
    case 'IssueCommentEvent': say('💬 댓글', 'comment'); break;
    case 'DeleteEvent': say('🧹 ' + p.ref_type + ' 삭제 ' + (p.ref || ''), 'delete'); break;
  }
}
const cloudTimers = new Map();
function cloudVisit(repo, branch, msg) {
  const id = 'cloud:' + repo + ':' + branch;
  upAgent(id, { repo, name: 'Claude (클라우드)', kind: 'cloud', room: 'dev', status: 'working', detail: '커밋: ' + msg.slice(0, 50) });
  addLog(repo, '☁ 클라우드 에이전트가 ' + branch + '에 커밋', 'cloud');
  (cloudTimers.get(id) || []).forEach(clearTimeout);
  cloudTimers.set(id, [
    setTimeout(() => agents.has(id) && upAgent(id, { room: 'ship', detail: '브랜치 ' + branch + ' 푸시' }), 60000),
    setTimeout(() => agents.has(id) && upAgent(id, { room: 'lounge', status: 'idle', detail: '다음 지시 대기' }), 180000),
    setTimeout(() => { rmAgent(id); cloudTimers.delete(id); }, 600000)
  ]);
}
async function pollEvents() {
  if (!GH.user) return;
  const { data, notModified } = await gh(`/users/${GH.user}/events?per_page=50`);
  if (notModified && eventsPrimed) return;
  const sorted = data.slice().sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  if (!eventsPrimed) {
    stats.pushesToday = 0;
    sorted.filter(e => Date.now() - Date.parse(e.created_at) < 48 * 3600000).forEach(e => handleEvent(e, false));
    log.sort((a, b) => b.t - a.t);
    eventsPrimed = true;
  } else {
    sorted.filter(e => BigInt(e.id) > lastEventId).forEach(e => handleEvent(e, true));
  }
  for (const e of sorted) if (BigInt(e.id) > lastEventId) lastEventId = BigInt(e.id);
}

const runSeen = new Map();
async function pollRuns() {
  if (!GH.token || GH.remaining < 300) return;
  const now = Date.now();
  const running = new Set([...agents.values()].filter(a => a.kind === 'actions' && a.status !== 'idle').map(a => a.repo));
  const targets = [...repos.values()].filter(r => !r.local && (now - r.pushedAt < 3 * 3600000 || running.has(r.id))).sort((a, b) => b.pushedAt - a.pushedAt).slice(0, 12);
  for (const r of targets) {
    try {
      const { data } = await gh(`/repos/${r.id}/actions/runs?per_page=5`);
      for (const run of data.workflow_runs || []) await handleRun(r.id, run);
    } catch (e) { /* 저장소에 Actions 가 없거나 권한이 없으면 건너뜀 */ }
  }
}
async function handleRun(repo, run) {
  const id = 'gha:' + run.id, prev = runSeen.get(run.id), name = run.name || 'workflow';
  if (run.status !== 'completed') {
    let room = 'plan', status = 'waiting', detail = '대기열';
    if (run.status === 'in_progress') {
      status = 'working'; room = classifyText(name) || 'build'; detail = name;
      try {
        const { data } = await gh(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=30`);
        const jobs = data.jobs || [];
        const job = jobs.find(j => j.status === 'in_progress') || jobs[0];
        const step = job && (job.steps || []).find(s => s.status === 'in_progress');
        room = classifyText([step && step.name, job && job.name, name].filter(Boolean).join(' ')) || room;
        detail = (job ? job.name : name) + (step ? ' › ' + step.name : '');
      } catch (e) {}
    }
    upAgent(id, { repo, name, kind: 'actions', room, status, detail, url: run.html_url });
    if (!prev) addLog(repo, '⚙ 워크플로 시작: ' + name, 'run');
    runSeen.set(run.id, 'running');
  } else if (prev === 'running') {
    runSeen.set(run.id, 'completed');
    const ok = run.conclusion === 'success';
    if (ok) {
      upAgent(id, { repo, name, kind: 'actions', room: 'lounge', status: 'idle', detail: '성공' });
      addLog(repo, '✅ ' + name + ' 성공', 'done');
      if (/pages|deploy|release|publish/i.test(name)) send({ type: 'fx', fx: { kind: 'rocket', repo } });
    } else {
      upAgent(id, { repo, name, kind: 'actions', room: 'verify', status: 'failed', detail: run.conclusion || '실패' });
      addLog(repo, '❌ ' + name + ' ' + (run.conclusion || '실패'), 'fail');
    }
    setTimeout(() => rmAgent(id), ok ? 45000 : 120000);
  } else if (!prev) runSeen.set(run.id, 'completed');
}

function every(sec, fn) { const tick = () => fn().catch(e => console.log('  ·', e.message)).finally(() => setTimeout(tick, sec * 1000)); setTimeout(tick, sec * 1000); }
async function startGitHub() {
  if (!GH.token) GH.token = await ghCliToken();
  try {
    if (GH.token) {
      try { const { data } = await gh('/user'); if (!GH.user) GH.user = data.login; }
      catch (e) { console.log('  ! GitHub 토큰이 거부됐어요(' + e.message + '). 토큰 없이 공개 저장소만 읽습니다.'); GH.token = ''; GH.etags.clear(); }
    }
    if (!GH.user) { console.log('  ! GitHub 사용자를 모릅니다. factory.config.json 의 githubUser 를 채우거나 GITHUB_TOKEN 을 넣어 주세요.'); return; }
    const { count } = await loadRepos(true);
    await pollEvents().catch(e => console.log('  · 이벤트:', e.message));
    GH.ok = true;
    console.log(`  ✓ GitHub @${GH.user} 저장소 ${count}개 불러옴` + (GH.token ? '' : ' (토큰 없음: 공개 저장소만, 5분마다 갱신)'));
    send(Object.assign({ type: 'snapshot' }, state()));
    every(GH.token ? cfg.pollEventsSec : Math.max(300, cfg.pollEventsSec), pollEvents);
    every(cfg.pollRunsSec, pollRuns); pollRuns().catch(() => {});
    every(600, () => loadRepos(false));
  } catch (e) {
    console.log('  ! GitHub 연결 실패:', e.message, '— 우선 내 PC 에이전트만 보여 주고 5분 뒤 다시 시도합니다.');
    setTimeout(startGitHub, 300000);
  }
}

/* ---------------- HTTP ---------------- */
const INDEX = path.join(ROOT, 'docs', 'index.html');
function cors(req, res) {
  const o = req.headers.origin;
  if (!o) return;
  const allow = new Set((cfg.allowedOrigins || []).map(x => x.toLowerCase()));
  const u = (GH.user || cfg.githubUser || '').toLowerCase();
  if (u) allow.add('https://' + u + '.github.io');
  if (allow.has(o.toLowerCase()) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
}
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  cors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': '*', 'Access-Control-Max-Age': '600' });
    return res.end();
  }
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(INDEX).pipe(res);
  }
  if (req.method === 'GET' && url === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(state()));
  }
  if (req.method === 'GET' && url === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': hello\n\n'); clients.add(res);
    const hb = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(hb); clients.delete(res); });
    return;
  }
  if (req.method === 'POST' && url === '/api/hook') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 512 * 1024) req.destroy(); });
    req.on('end', () => {
      res.writeHead(204); res.end();
      let p; try { p = JSON.parse(body); } catch (e) { return; }
      handleHook(p).catch(e => console.log('  · 훅 처리 오류:', e.message));
    });
    return;
  }
  res.writeHead(404); res.end('not found');
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.log(`\n  ! ${cfg.port}번 포트가 이미 쓰이고 있어요. 이미 켜져 있는지 확인하거나 factory.config.json 의 port 를 바꿔 주세요.\n`);
  else console.log(e);
  process.exit(1);
});
server.listen(cfg.port, cfg.host, () => {
  console.log(`\n  🏘  에이전트 타운이 켜졌어요 → http://localhost:${cfg.port}\n`);
  startGitHub();
});
