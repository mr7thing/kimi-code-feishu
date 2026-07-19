/**
 * 飞书通道：基于 @larksuiteoapi/node-sdk 的 WebSocket 长连接，无需公网 IP。
 *
 * - 收消息：im.message.receive_v1
 * - 卡片回调：card.action.trigger（审批按钮），返回 {toast} 给用户即时反馈
 * - 发消息/卡片、更新消息：client.im.v1.message.create / patch
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import type { CardActionHandler, Channel, MessageHandler } from './channel.js';

export class FeishuChannel implements Channel {
  private client: Lark.Client;
  private ws: Lark.WSClient | null = null;
  private seenMessageIds = new Map<string, number>();

  constructor(
    private appId: string,
    private appSecret: string,
    private onMessage: MessageHandler,
    private onCardAction: CardActionHandler,
  ) {
    this.client = new Lark.Client({ appId, appSecret, loggerLevel: Lark.LoggerLevel.warn });
  }

  async start(): Promise<void> {
    const eventDispatcher = new Lark.EventDispatcher({ loggerLevel: Lark.LoggerLevel.warn }).register({
      'im.message.receive_v1': async (data: unknown) => this.handleMessageEvent(data),
      'card.action.trigger': async (data: unknown) => this.handleCardAction(data),
      // 模板默认订阅了已读事件，注册空处理器避免 SDK 刷 "no handle" 警告
      'im.message.message_read_v1': async () => {},
    });

    // 注意：旧版 SDK 的 WSClient.reConnect() 有定时器泄漏 bug（上游 #177）。
    // 1.71+ 已用 generation 计数修复；如运行在旧版，规避方式是重建 WSClient 实例。
    this.ws = new Lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      loggerLevel: Lark.LoggerLevel.warn,
      autoReconnect: true,
      onReady: () => console.log('[feishu] 长连接已就绪'),
      onError: (err: unknown) => console.error('[feishu] 长连接错误:', err),
    } as ConstructorParameters<typeof Lark.WSClient>[0]);

    // start() 返回的 Promise 挂起期间连接由 SDK 维护（含自动重连）
    this.ws.start({ eventDispatcher }).catch((err) => console.error('[feishu] WS 退出:', err));
  }

  async close(): Promise<void> {
    this.ws?.close();
  }

  // ---------------- 事件处理 ----------------
  private handleMessageEvent(data: unknown): void {
    try {
      const event = (data as Record<string, unknown>) ?? {};
      const msg = event.message as Record<string, unknown> | undefined;
      const sender = event.sender as Record<string, unknown> | undefined;
      if (!msg || msg.message_type !== 'text') {
        if (msg?.chat_id) void this.sendText(String(msg.chat_id), '目前只支持文字消息哦');
        return;
      }
      if (sender && sender.sender_type !== 'user') return;
      const openId = String((sender?.sender_id as Record<string, unknown>)?.open_id ?? '');
      const messageId = String(msg.message_id ?? '');
      if (this.isDuplicate(messageId)) return;

      let text = '';
      try {
        text = String((JSON.parse(String(msg.content ?? '{}')) as Record<string, unknown>).text ?? '');
      } catch {
        return;
      }
      text = text.replace(/@_user_\d+\s*/g, '').trim();
      if (!text) return;
      this.onMessage(String(msg.chat_id), openId, text);
    } catch (err) {
      console.error('[feishu] 处理消息失败:', err);
    }
  }

  /** 审批按钮回调：返回 toast + 结果卡片（内联更新是全端同步的唯一可靠途径）。 */
  private handleCardAction(data: unknown): Record<string, unknown> {
    try {
      const event = (data as Record<string, unknown>) ?? {};
      const value = ((event.action as Record<string, unknown>)?.value ?? {}) as Record<string, unknown>;
      const operator = String((event.operator as Record<string, unknown>)?.open_id ?? '');
      const card = this.onCardAction(value, operator);
      const resp: Record<string, unknown> = { toast: { type: 'success', content: '已收到你的选择' } };
      if (card) resp.card = { type: 'raw', data: card };
      return resp;
    } catch (err) {
      console.error('[feishu] 处理卡片回调失败:', err);
      return { toast: { type: 'error', content: '处理失败，请查看桥服务日志' } };
    }
  }

  private isDuplicate(messageId: string): boolean {
    const now = Date.now();
    for (const [k, v] of this.seenMessageIds) {
      if (now - v > 300_000) this.seenMessageIds.delete(k);
    }
    if (this.seenMessageIds.has(messageId)) return true;
    this.seenMessageIds.set(messageId, now);
    return false;
  }

  // ---------------- 发送 ----------------
  async sendText(chatId: string, text: string): Promise<string | undefined> {
    return this.send(chatId, 'text', JSON.stringify({ text }));
  }

  async sendCard(chatId: string, card: Record<string, unknown>): Promise<string | undefined> {
    return this.send(chatId, 'interactive', JSON.stringify(card));
  }

  private async send(chatId: string, msgType: string, content: string): Promise<string | undefined> {
    try {
      const resp = await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: msgType, content },
      });
      const r = resp as unknown as { code?: number; msg?: string; data?: { message_id?: string } };
      if (r.code !== 0) {
        console.error(`[feishu] 发送消息失败: code=${r.code} msg=${r.msg}`);
        return undefined;
      }
      return r.data?.message_id;
    } catch (err) {
      console.error('[feishu] 发送消息异常:', err);
      return undefined;
    }
  }

  // ---------------- 更新 ----------------
  // 注意：飞书的两个"更新"接口分工不同——
  //   message.update（PUT）编辑文本/富文本消息；
  //   message.patch 只更新卡片消息（对文本消息报 230001 "NOT a card"）。
  async updateText(messageId: string, text: string): Promise<void> {
    if (!messageId) return;
    try {
      const resp = await this.client.im.v1.message.update({
        path: { message_id: messageId },
        data: { msg_type: 'text', content: JSON.stringify({ text }) },
      });
      const r = resp as unknown as { code?: number; msg?: string };
      if (r.code !== 0) console.warn(`[feishu] 编辑消息失败: code=${r.code} msg=${r.msg}`);
    } catch (err) {
      console.warn('[feishu] 编辑消息异常:', (err as Error)?.message ?? err);
    }
  }

  async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    if (!messageId) return;
    try {
      const resp = await this.client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      });
      const r = resp as unknown as { code?: number; msg?: string };
      if (r.code !== 0) console.warn(`[feishu] 更新卡片失败: code=${r.code} msg=${r.msg}`);
    } catch (err) {
      console.warn('[feishu] 更新卡片异常:', (err as Error)?.message ?? err);
    }
  }
}
