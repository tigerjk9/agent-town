#!/usr/bin/env node
/*
 * Claude Code 훅 → 에이전트 타운 서버로 이벤트를 전달합니다.
 * - 서버가 꺼져 있거나 오류가 나도 아무것도 출력하지 않고 바로 끝납니다(Claude Code 작업에 영향 없음).
 * - 필요한 정보만 골라서 보냅니다(파일 경로, 명령 앞부분, 요청 앞 80자 등). 내 PC(127.0.0.1) 밖으로 나가지 않습니다.
 * - 터미널마다 이름을 붙이고 싶으면: AGENT_TOWN_NAME=기획봇 claude
 */
'use strict';
const http = require('http');
const PORT = +(process.env.AGENT_TOWN_PORT || 4747);
setTimeout(() => process.exit(0), 2500).unref();

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { buf += d; if (buf.length > 4e6) process.exit(0); });
process.stdin.on('end', () => {
  let p;
  try { p = JSON.parse(buf); } catch (e) { return process.exit(0); }
  const ti = p.tool_input || {};
  const tr = p.tool_response;
  const slim = {
    hook_event_name: p.hook_event_name,
    session_id: p.session_id,
    agent_id: p.agent_id,
    agent_type: p.agent_type,
    cwd: p.cwd,
    tool_name: p.tool_name,
    tool_input: {
      file_path: ti.file_path || ti.notebook_path || ti.path,
      command: typeof ti.command === 'string' ? ti.command.slice(0, 300) : undefined,
      pattern: ti.pattern, query: ti.query, url: ti.url,
      description: ti.description, subagent_type: ti.subagent_type
    },
    tool_error: !!(tr && typeof tr === 'object' && (tr.is_error || tr.error || tr.interrupted)),
    prompt: typeof p.prompt === 'string' ? p.prompt.slice(0, 80) : undefined,
    message: p.message, source: p.source, reason: p.reason,
    name: process.env.AGENT_TOWN_NAME
  };
  const body = JSON.stringify(slim);
  const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/hook', method: 'POST', timeout: 800,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
    res => { res.resume(); res.on('end', () => process.exit(0)); });
  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.end(body);
});
