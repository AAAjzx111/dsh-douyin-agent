import { randomUUID } from 'node:crypto';

// 问候只沿用当前 DSH 的文本模型路由，不提供工具或其他会话内容。
export function createNativeSparkGreeting({ llm, agent } = {}) {
  const route = agent?.session?.requestHeader?.()?.config;
  const provider = route?.provider ?? agent?.options?.provider;
  const model = route?.model ?? agent?.options?.model;
  if (!provider || !model || typeof llm?.stream !== 'function' || !agent?.session?.id) throw new Error('当前 DSH 未提供可核实的文本模型路由，不能启动人格问候。');
  let system = '';
  const once = async (input, limit, signal) => {
    let text = '', finish, usage = {}; const deltaIndexes = new Set();
    for await (const chunk of llm.stream({ provider, model, messages: input, system, maxTokens: limit, signal, sessionId: agent.session.id })) {
      signal?.throwIfAborted();
      if (chunk.type === 'text-delta') { deltaIndexes.add(chunk.index); text += chunk.text; }
      if (chunk.type === 'block-end' && chunk.block?.type === 'text' && !deltaIndexes.has(chunk.index)) text += chunk.block.text;
      if (text.length > 2000) throw new Error('人格问候模型返回过长，未发送。');
      if (chunk.type === 'usage') usage = { promptTokens: chunk.usage?.inputTokens || 0, completionTokens: chunk.usage?.outputTokens || 0, totalTokens: chunk.usage?.totalTokens ?? (chunk.usage?.inputTokens || 0) + (chunk.usage?.outputTokens || 0) };
      if (chunk.type === 'finish') finish = chunk.reason;
    }
    return { text, finish, usage };
  };
  return async ({ system: prompt, messages, signal, maxTokens = 160 } = {}) => {
    signal?.throwIfAborted();
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 24_000 || !Array.isArray(messages) || !messages.length || messages.length > 3 || messages.some(message => message?.role !== 'user' || typeof message.content !== 'string' || !message.content.trim() || message.content.length > 4000) || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 256) throw new Error('人格问候只接收有限的文本提示，不接收工具、图片或历史会话。');
    system = prompt;
    const converted = messages.map(message => ({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: message.content }], source: { kind: 'plugin', plugin: 'douyin-browser', form: 'snapshot', sections: [] } }));
    let { text, finish, usage } = await once(converted, maxTokens, signal);
    // 2026-11-07 主人报「主动问候说服务未启动/发不出去」：这一版 DSH 模型先想一段再开口，
    // 160 token 常被思考吃掉，问候直接被截断（步月登云那次就是 max-tokens）。与自主观看同样的处理：
    // 被长度截断就再要一次，明确要求「不要思考过程、只给一句 40 字内的问候」。
    if (finish?.kind !== 'stop' && ['max-tokens', 'length'].includes(finish?.kind)) {
      const shorter = converted.concat([{ id: randomUUID(), role: 'user', content: [{ type: 'text', text: '上一次输出被长度限制截断。不要思考过程，只输出一句能直接发出去的中文问候，40 字以内。' }], source: { kind: 'plugin', plugin: 'douyin-browser', form: 'snapshot', sections: [] } }]);
      ({ text, finish, usage } = await once(shorter, Math.min(256, maxTokens + 96), signal));
    }
    signal?.throwIfAborted();
    if (finish?.kind !== 'stop' || !text.trim()) throw new Error(`DSH 人格问候未完整返回（${finish?.kind || '缺少完成标记'}），未发送。`);
    return { text: text.trim(), usage };
  };
}
