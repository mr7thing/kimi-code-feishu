/**
 * 对话日志：飞书完整对话落盘，JSONL 按天分文件（logs/YYYY-MM-DD.jsonl）。
 *
 * 两个接入点：
 * - LoggingChannel：包装通道，所有发出的文本/卡片/更新自动记录
 * - Bridge.publish：任务输出/审批/进度/注入等总线事件统一记录
 * 写入失败静默（日志绝不能拖垮桥）。文件权限 600，目录 700。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG_DIR } from './config.js';
import type { Channel } from './channel.js';

export type LogDir = 'in' | 'out' | 'sys';

export interface LogEntry {
  ts: number;
  chat: string;
  dir: LogDir;
  kind: string;
  text: string;
}

export class ChatLogger {
  /** 条目钩子（dashboard feed 订阅全量对话事件用）。 */
  onEntry?: (e: LogEntry) => void;
  /** false 时只触发钩子不落盘（dashboard feed 与磁盘日志解耦）。 */
  fileEnabled = true;

  constructor(private dir: string = path.join(DEFAULT_CONFIG_DIR, 'logs')) {}

  log(chat: string, dir: LogDir, kind: string, text: string): void {
    const entry: LogEntry = { ts: Date.now(), chat, dir, kind, text };
    try {
      this.onEntry?.(entry);
    } catch {
      /* 钩子异常不影响日志 */
    }
    if (!this.fileEnabled) return;
    try {
      const day = new Date().toISOString().slice(0, 10);
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(path.join(this.dir, `${day}.jsonl`), JSON.stringify(entry) + '\n', { mode: 0o600 });
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  /** 清理 retentionDays 之前的日志文件，返回删除数量。 */
  clean(retentionDays: number): number {
    if (retentionDays <= 0) return 0;
    let removed = 0;
    try {
      const cutoff = Date.now() - retentionDays * 86_400_000;
      for (const f of fs.readdirSync(this.dir)) {
        if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
        const day = Date.parse(f.slice(0, 10) + 'T00:00:00Z');
        if (day < cutoff) {
          fs.rmSync(path.join(this.dir, f), { force: true });
          removed++;
        }
      }
    } catch {
      /* 目录不存在等情况忽略 */
    }
    return removed;
  }
}

/** 通道日志包装：所有出站消息（文本/卡片/更新）落盘后透传。 */
export class LoggingChannel implements Channel {
  constructor(
    private inner: Channel,
    private logger: ChatLogger,
  ) {}

  start(): void | Promise<void> {
    return this.inner.start();
  }

  /** 透传 close（FeishuChannel 有，Channel 接口没有）。 */
  async close(): Promise<void> {
    const c = this.inner as { close?: () => Promise<void> };
    await c.close?.();
  }

  async sendText(chatId: string, text: string): Promise<string | undefined> {
    this.logger.log(chatId, 'out', 'text', text);
    return this.inner.sendText(chatId, text);
  }

  async sendCard(chatId: string, card: Record<string, unknown>): Promise<string | undefined> {
    this.logger.log(chatId, 'out', 'card', summarizeCard(card));
    return this.inner.sendCard(chatId, card);
  }

  async updateText(messageId: string, text: string): Promise<void> {
    this.logger.log('-', 'out', 'update', text);
    return this.inner.updateText(messageId, text);
  }

  async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    this.logger.log('-', 'out', 'update_card', summarizeCard(card));
    return this.inner.updateCard(messageId, card);
  }
}

/** 卡片日志只留可读摘要（标题 + 文本元素），不存完整 JSON。 */
function summarizeCard(card: Record<string, unknown>): string {
  try {
    const header = card.header as Record<string, unknown> | undefined;
    const title = String((header?.title as Record<string, unknown>)?.content ?? '');
    const parts: string[] = [title];
    for (const el of (card.elements ?? []) as Array<Record<string, unknown>>) {
      const text = (el.text as Record<string, unknown>)?.content;
      if (typeof text === 'string') parts.push(text);
    }
    return parts.filter(Boolean).join(' | ').slice(0, 500);
  } catch {
    return '(card)';
  }
}
