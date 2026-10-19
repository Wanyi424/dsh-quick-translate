import React, { useState } from 'react';
import { ChevronRight, Copy } from 'lucide-react';
import type { Translation } from './contracts';
import { STATUS, count, elapsed, fullTime, inputOf, span, totalOf } from './format';
import { Dialog, copyText } from './ui';

type Phase = readonly ['wait' | 'think' | 'write', string, number];
/** Where the time went, from the stored phase marks; empty for records made before timing was kept. */
function phasesOf(r: Translation): Phase[] {
  const total = elapsed(r), first = r.firstTokenMs, text = r.firstTextMs;
  if (first === undefined || !(total > 0)) return [];
  const phases: Phase[] = [['wait', '等待响应', first], ['think', '思考', (text ?? total) - first], ['write', '输出译文', text === undefined ? 0 : total - text]];
  return phases.filter(([, , ms]) => ms > 0);
}
const speedOf = (r: Translation) => {
  const generating = elapsed(r) - (r.firstTokenMs ?? NaN);
  return r.usage && generating > 0 ? Math.round(r.usage.outputTokens / (generating / 1000)) : undefined;
};
const join = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' · ');

/** Plain text for an issue report or a chat with whoever maintains the model setup. */
function report(r: Translation) {
  const u = r.usage, phases = phasesOf(r);
  return [
    '翻译 · 翻译详情',
    `记录编号：${r.id}`,
    `开始时间：${r.createdAt}`,
    `模型：${r.modelName}（${r.provider} / ${r.model}）`,
    `结果：${STATUS[r.status]}${r.errorCode ? `（${r.errorCode}）` : ''}${r.error ? `：${r.error}` : ''}`,
    u ? `Token：输入 ${count(inputOf(u))}${u.cacheReadTokens ? `（缓存命中 ${count(u.cacheReadTokens)}）` : ''} · 输出 ${count(u.outputTokens)} · 合计 ${count(totalOf(u))}` : 'Token：模型未返回用量',
    `耗时：${join(...phases.map(([, label, ms]) => `${label} ${span(ms)}`), elapsed(r) > 0 && `总计 ${span(elapsed(r))}`)}`,
    `字数：原文 ${count(r.source.length)} · 译文 ${count(r.result.length)} 字符`,
  ].join('\n');
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return <div className="dqt-stat"><span>{label}</span><strong>{value}</strong><small>{note || ' '}</small></div>;
}

/** One place for everything about a single run: token usage, timing, model, outcome and the prompt snapshot. */
export function DetailsDialog({ record: r, onClose }: { record: Translation; onClose(): void }) {
  const [copied, setCopied] = useState(false);
  const u = r.usage, total = elapsed(r), phases = phasesOf(r), speed = speedOf(r);
  return <Dialog title="翻译详情" className="dqt-dialog-wide dqt-details" onClose={onClose} footer={<>
    <button type="button" className="dqt-button dqt-button-secondary" onClick={() => void copyText(report(r)).then(() => setCopied(true), () => {})}><Copy />{copied ? '已复制' : '复制诊断信息'}</button>
    <button type="button" className="dqt-button dqt-button-primary" data-autofocus onClick={onClose}>关闭</button>
  </>}>
    <div className="dqt-stats">
      <Stat label="输入 tokens" value={u ? count(inputOf(u)) : '—'} note={u ? join(!!u.cacheReadTokens && `缓存命中 ${count(u.cacheReadTokens!)}`, !!u.cacheWriteTokens && `写入缓存 ${count(u.cacheWriteTokens!)}`) : ''} />
      <Stat label="输出 tokens" value={u ? count(u.outputTokens) : '—'} note={join(!!u?.reasoningTokens && `含推理 ${count(u.reasoningTokens!)}`, speed !== undefined && `${count(speed)} tokens/秒`)} />
      <Stat label="总耗时" value={total > 0 ? span(total) : '—'} note={r.firstTokenMs !== undefined ? `首字 ${span(r.firstTokenMs)}` : ''} />
    </div>
    {!u && <p className="dqt-hint">模型没有返回这次的用量。手动停止、连接中断，或旧版本留下的记录，通常没有这项数据。</p>}
    {phases.length > 0 && <div className="dqt-timeline" role="group" aria-label="耗时分布">
      <div className="dqt-timeline-bar" aria-hidden>{phases.map(([key, , ms]) => <i key={key} data-phase={key} style={{ flexGrow: ms }} />)}</div>
      <div className="dqt-timeline-legend">{phases.map(([key, label, ms]) => <span key={key} data-phase={key}><i aria-hidden />{label}<b>{span(ms)}</b></span>)}</div>
    </div>}
    <dl className="dqt-facts">
      <dt>模型</dt><dd>{r.modelName}<small>{r.provider} / {r.model}</small></dd>
      <dt>结果</dt><dd data-status={r.status}>{STATUS[r.status]}{r.errorCode && <code>{r.errorCode}</code>}{r.error && <small>{r.error}</small>}</dd>
      {u && <><dt>Token 合计</dt><dd>{count(totalOf(u))}</dd></>}
      <dt>字数</dt><dd>原文 {count(r.source.length)} · 译文 {count(r.result.length)} 字符</dd>
      <dt>开始时间</dt><dd>{fullTime(r.createdAt)}</dd>
      <dt>记录编号</dt><dd><code className="dqt-id">{r.id}</code></dd>
    </dl>
    <details className="dqt-disclosure">
      <summary><ChevronRight />本次使用的提示词<small>{count(r.prompt.length)} 字符 · 之后修改提示词不会改变这条记录</small></summary>
      <pre className="dqt-prompt-view dqt-prompt-snapshot">{r.prompt}</pre>
    </details>
  </Dialog>;
}
