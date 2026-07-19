/**
 * 飞书通道：基于 @larksuiteoapi/node-sdk 的 WebSocket 长连接，无需公网 IP。
 *
 * - 收消息：im.message.receive_v1
 * - 卡片回调：card.action.trigger（审批按钮），返回 {toast} 给用户即时反馈
 * - 发消息/卡片、更新消息：client.im.v1.message.create / patch
 */
import * as Lark from '@larksuiteoapi/node-sdk';
export class FeishuChannel {
    appId;
    appSecret;
    onMessage;
    onCardAction;
    client;
    ws = null;
    seenMessageIds = new Map();
    constructor(appId, appSecret, onMessage, onCardAction) {
        this.appId = appId;
        this.appSecret = appSecret;
        this.onMessage = onMessage;
        this.onCardAction = onCardAction;
        this.client = new Lark.Client({ appId, appSecret, loggerLevel: Lark.LoggerLevel.warn });
    }
    async start() {
        const eventDispatcher = new Lark.EventDispatcher({ loggerLevel: Lark.LoggerLevel.warn }).register({
            'im.message.receive_v1': async (data) => this.handleMessageEvent(data),
            'card.action.trigger': async (data) => this.handleCardAction(data),
        });
        // 注意：旧版 SDK 的 WSClient.reConnect() 有定时器泄漏 bug（上游 #177）。
        // 1.71+ 已用 generation 计数修复；如运行在旧版，规避方式是重建 WSClient 实例。
        this.ws = new Lark.WSClient({
            appId: this.appId,
            appSecret: this.appSecret,
            loggerLevel: Lark.LoggerLevel.warn,
            autoReconnect: true,
            onReady: () => console.log('[feishu] 长连接已就绪'),
            onError: (err) => console.error('[feishu] 长连接错误:', err),
        });
        // start() 返回的 Promise 挂起期间连接由 SDK 维护（含自动重连）
        this.ws.start({ eventDispatcher }).catch((err) => console.error('[feishu] WS 退出:', err));
    }
    async close() {
        this.ws?.close();
    }
    // ---------------- 事件处理 ----------------
    handleMessageEvent(data) {
        try {
            const event = data ?? {};
            const msg = event.message;
            const sender = event.sender;
            if (!msg || msg.message_type !== 'text') {
                if (msg?.chat_id)
                    void this.sendText(String(msg.chat_id), '目前只支持文字消息哦');
                return;
            }
            if (sender && sender.sender_type !== 'user')
                return;
            const openId = String(sender?.sender_id?.open_id ?? '');
            const messageId = String(msg.message_id ?? '');
            if (this.isDuplicate(messageId))
                return;
            let text = '';
            try {
                text = String(JSON.parse(String(msg.content ?? '{}')).text ?? '');
            }
            catch {
                return;
            }
            text = text.replace(/@_user_\d+\s*/g, '').trim();
            if (!text)
                return;
            this.onMessage(String(msg.chat_id), openId, text);
        }
        catch (err) {
            console.error('[feishu] 处理消息失败:', err);
        }
    }
    /** 审批按钮回调：返回 toast 给点击者即时反馈。 */
    handleCardAction(data) {
        try {
            const event = data ?? {};
            const value = (event.action?.value ?? {});
            const operator = String(event.operator?.open_id ?? '');
            this.onCardAction(value, operator);
            return { toast: { type: 'success', content: '已收到你的选择' } };
        }
        catch (err) {
            console.error('[feishu] 处理卡片回调失败:', err);
            return { toast: { type: 'error', content: '处理失败，请查看桥服务日志' } };
        }
    }
    isDuplicate(messageId) {
        const now = Date.now();
        for (const [k, v] of this.seenMessageIds) {
            if (now - v > 300_000)
                this.seenMessageIds.delete(k);
        }
        if (this.seenMessageIds.has(messageId))
            return true;
        this.seenMessageIds.set(messageId, now);
        return false;
    }
    // ---------------- 发送 ----------------
    async sendText(chatId, text) {
        return this.send(chatId, 'text', JSON.stringify({ text }));
    }
    async sendCard(chatId, card) {
        return this.send(chatId, 'interactive', JSON.stringify(card));
    }
    async send(chatId, msgType, content) {
        try {
            const resp = await this.client.im.v1.message.create({
                params: { receive_id_type: 'chat_id' },
                data: { receive_id: chatId, msg_type: msgType, content },
            });
            const r = resp;
            if (r.code !== 0) {
                console.error(`[feishu] 发送消息失败: code=${r.code} msg=${r.msg}`);
                return undefined;
            }
            return r.data?.message_id;
        }
        catch (err) {
            console.error('[feishu] 发送消息异常:', err);
            return undefined;
        }
    }
    // ---------------- 更新 ----------------
    async updateText(messageId, text) {
        await this.patch(messageId, JSON.stringify({ text }));
    }
    async updateCard(messageId, card) {
        await this.patch(messageId, JSON.stringify(card));
    }
    async patch(messageId, content) {
        if (!messageId)
            return;
        try {
            const resp = await this.client.im.v1.message.patch({
                path: { message_id: messageId },
                data: { content },
            });
            const r = resp;
            if (r.code !== 0)
                console.warn(`[feishu] 更新消息失败: code=${r.code} msg=${r.msg}`);
        }
        catch (err) {
            console.warn('[feishu] 更新消息异常:', err);
        }
    }
}
