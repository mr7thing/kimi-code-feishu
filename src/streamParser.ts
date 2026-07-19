/**
 * kimi -p --output-format stream-json 的容错解析器（Python 版直译）。
 * schema 可能随 CLI 版本变化，做"尽力而为"的提取；不认识就降级为原文。
 */

export interface StreamEvent {
  kind: 'text' | 'tool_call' | 'tool_result' | 'done' | 'raw';
  text?: string;
  tool?: string;
}

function* iterTextBlocks(obj: unknown): Generator<string> {
  if (typeof obj === 'string') {
    yield obj;
  } else if (Array.isArray(obj)) {
    for (const item of obj) yield* iterTextBlocks(item);
  } else if (obj && typeof obj === 'object') {
    const rec = obj as Record<string, unknown>;
    if (rec.type === 'text' && typeof rec.text === 'string') {
      yield rec.text;
      return;
    }
    for (const key of ['text', 'content', 'delta', 'message', 'result']) {
      if (key in rec) yield* iterTextBlocks(rec[key]);
    }
  }
}

function looksLikeToolEvent(obj: Record<string, unknown>): { kind: StreamEvent['kind']; summary: string } | null {
  const t = String(obj.type ?? obj.event ?? '');
  const name = obj.tool_name ?? obj.name ?? '';
  if (t.includes('tool') && name) {
    if (t.includes('result') || t.includes('output') || t.includes('end')) {
      return { kind: 'tool_result', summary: String(name) };
    }
    return { kind: 'tool_call', summary: String(name) };
  }
  if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) {
    const names = (obj.tool_calls as Array<Record<string, unknown>>)
      .map((tc) => String((tc.function as Record<string, unknown>)?.name ?? tc.name ?? '?'))
      .join(', ');
    return { kind: 'tool_call', summary: names || '?' };
  }
  return null;
}

export function parseLine(line: string): StreamEvent | null {
  const s = line.trim();
  if (!s) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(s);
  } catch {
    return { kind: 'raw', text: s };
  }

  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const rec = obj as Record<string, unknown>;
    const toolEv = looksLikeToolEvent(rec);
    if (toolEv) return { kind: toolEv.kind as StreamEvent['kind'], tool: toolEv.summary };
    const texts = [...iterTextBlocks(rec)].filter((t) => t.trim());
    if (texts.length) return { kind: 'text', text: texts.join('') };
    if (['done', 'result', 'finished'].includes(String(rec.type))) return { kind: 'done' };
    return null;
  }
  if (typeof obj === 'string') return { kind: 'text', text: obj };
  return null;
}
