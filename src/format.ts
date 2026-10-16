import type { Status, Translation } from './contracts';

export const STATUS: Record<Status, string> = { running: '翻译中', completed: '已完成', stopped: '已停止', failed: '未完成', interrupted: '已中断' };
export const PHASE: Record<NonNullable<Translation['phase']>, string> = { connecting: '正在连接模型', thinking: '模型思考中', translating: '正在翻译' };
const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');
const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const daysAgo = (d: Date, today: number) => Math.round((today - startOfDay(d)) / DAY);
export const fullTime = (iso: string) => { const d = new Date(iso); return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${clock(d)}`; };
/** History groups: today, yesterday, the past week, then calendar months. */
export function groupOf(iso: string, today: number) {
  const d = new Date(iso), days = daysAgo(d, today);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return '近 7 天';
  return d.getFullYear() === new Date(today).getFullYear() ? `${d.getMonth() + 1} 月` : `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
}
export function timeOf(iso: string, today: number) {
  const d = new Date(iso), days = daysAgo(d, today);
  return days <= 1 ? clock(d) : days < 7 ? `周${'日一二三四五六'[d.getDay()]}` : `${d.getMonth() + 1}/${d.getDate()}`;
}
export function duration(record: Translation) {
  const ms = Date.parse(record.updatedAt) - Date.parse(record.createdAt);
  if (!(ms > 0)) return '';
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} 秒`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`;
  return `${Math.floor(ms / 60_000)} 分 ${Math.round(ms % 60_000 / 1000)} 秒`;
}
