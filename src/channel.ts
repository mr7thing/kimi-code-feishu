/**
 * 消息通道抽象：Bridge 只依赖这个接口，便于测试与扩展到 Telegram/企业微信。
 */

export interface Channel {
  /** 启动通道（飞书长连接等）。 */
  start(): void | Promise<void>;
  /** 发送文本消息，返回 message_id。 */
  sendText(chatId: string, text: string): Promise<string | undefined>;
  /** 发送交互卡片，返回 message_id。 */
  sendCard(chatId: string, card: Record<string, unknown>): Promise<string | undefined>;
  /** 更新文本消息内容（用于流式进度）。 */
  updateText(messageId: string, text: string): Promise<void>;
  /** 更新卡片（审批后置为已处理状态）。 */
  updateCard(messageId: string, card: Record<string, unknown>): Promise<void>;
}

export type MessageHandler = (chatId: string, openId: string, text: string) => void;
/** 返回结果卡片 JSON 时会内联进回调响应（全端立即同步），null 则只弹 toast。 */
export type CardActionHandler = (value: Record<string, unknown>, operatorOpenId: string) => Record<string, unknown> | null;
