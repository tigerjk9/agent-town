#!/usr/bin/env node
/*
 * Claude Code 설정(settings.json)에 에이전트 타운 훅을 추가/제거합니다.
 *   node install-hooks.js                 → 내 모든 프로젝트(~/.claude/settings.json)에 설치
 *   node install-hooks.js --project=경로   → 특정 프로젝트(.claude/settings.json)에만 설치
 *   node install-hooks.js --uninstall     → 제거
 * 바꾸기 전에 원래 파일을 settings.json.bak-날짜 로 백업합니다. 다른 훅은 건드리지 않습니다.
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const args = process.argv.slice(2);
const uninstall = args.includes('--uninstall');
const projArg = args.find(a => a.startsWith('--project='));
const file = projArg ? path.join(path.resolve(projArg.slice(10)), '.claude', 'settings.json') : path.join(os.homedir(), '.claude', 'settings.json');
const hookPath = path.join(__dirname, 'hook.js').replace(/\\/g, '/');
const MARK = '--agent-town';
const command = `node "${hookPath}" ${MARK}`;
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop', 'SessionEnd'];

let settings = {};
if (fs.existsSync(file)) {
  const raw = fs.readFileSync(file, 'utf8');
  try { settings = raw.trim() ? JSON.parse(raw) : {}; }
  catch (e) { console.error(`\n  ! ${file} 이 올바른 JSON 이 아니라서 건드리지 않았어요. 먼저 파일을 확인해 주세요.\n`); process.exit(1); }
  const bak = file + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(file, bak);
  console.log('  · 백업:', bak);
} else fs.mkdirSync(path.dirname(file), { recursive: true });

settings.hooks = settings.hooks || {};
for (const ev of EVENTS) {
  let groups = (settings.hooks[ev] || []).map(g => Object.assign({}, g, { hooks: (g.hooks || []).filter(h => !String(h.command || '').includes(MARK)) })).filter(g => g.hooks.length);
  if (!uninstall) {
    const g = { hooks: [{ type: 'command', command, timeout: 5 }] };
    if (ev === 'PreToolUse' || ev === 'PostToolUse') g.matcher = '*';
    groups.push(g);
  }
  if (groups.length) settings.hooks[ev] = groups; else delete settings.hooks[ev];
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
console.log(uninstall ? `\n  ✓ 에이전트 타운 훅을 제거했어요: ${file}\n` : `\n  ✓ 훅 설치 완료: ${file}\n    이제 새로 여는 Claude Code 세션부터 마을에 나타나요.\n`);
