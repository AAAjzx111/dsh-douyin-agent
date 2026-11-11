import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BrowserController } from './core.mjs?v=9';
import { messageFingerprint } from './chat-message.mjs';
import { MessageIdentityTracker } from './message-tracker.mjs';
export { MessageIdentityTracker } from './message-tracker.mjs';

const HOME = 'https://www.douyin.com/?recommend=1&from_nav=1';
// 本人主页：比「首页 → 我的 → 个人页」少两次导航，关注名单就在这一页的「关注」角标上。
const PROFILE = 'https://www.douyin.com/user/self';
const hash = value => createHash('sha256').update(value).digest('hex');
const stop = signal => signal?.throwIfAborted();
// 2026-10-31：读「我的关注」名单。原来的实现依赖抖音的哈希类名（.OlxToPIh / .Zce7SWd3），
// 改版后名单还会开在新标签页，导致 followed 全是 null、设置页的许可好友勾选框全灰。
// 现在按行读、按按钮文字判关系：类名再变也不影响；新标签页由 verifyFollowing 负责接管。
const readFollowingRows = () => {
  const root = document.querySelector('[data-e2e="user-fans-container"]') || document.body;
  const order = ['相互关注', '已关注', '关注', '回关'];
  const pick = row => {
    const button = [...row.querySelectorAll('button')].find(item => (item.textContent || '').trim());
    if (!button) return null;
    const text = (button.textContent || '').trim();
    const label = order.find(item => text.startsWith(item));
    if (!label) return null;
    const names = [...row.querySelectorAll('a')].map(anchor => (anchor.textContent || '').trim()).filter(Boolean);
    if (!names.length) return null;
    return { displayName: names[0], mutual: label === '相互关注', followed: label !== '关注' && label !== '回关' };
  };
  const out = [];
  for (const row of root.querySelectorAll('.OlxToPIh, li')) {
    const item = pick(row);
    if (item) out.push(item);
  }
  if (!out.length) {
    // 类名全换了也能用：从按钮往上找能读出名字的那一层当行。
    for (const button of root.querySelectorAll('button')) {
      const text = (button.textContent || '').trim();
      if (!order.some(item => text.startsWith(item))) continue;
      let node = button.parentElement;
      for (let depth = 0; depth < 5 && node && node !== root; depth += 1) {
        const item = pick(node);
        if (item) { out.push(item); break; }
        node = node.parentElement;
      }
    }
  }
  const seen = new Set();
  return out.filter(item => (seen.has(item.displayName) ? false : (seen.add(item.displayName), true)));
};
const readableDraft = value => value.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').trim();
const localDay = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));

export function analyzeConversationDay(snapshot, { now = Date.now, confirmedHistory = [], greetingAsReply = false } = {}) {
  const current = typeof now === 'function' ? now() : now, today = localDay(current), yesterday = localDay(current - 86_400_000);
  const recipientId = snapshot?.conversation?.id || snapshot?.contact?.id;
  if (typeof recipientId === 'string' && recipientId.trim() && confirmedHistory.some(item => item?.confirmed === true && item.recipientId === recipientId && typeof item.messageId === 'string' && item.messageId.trim() && item.date === today && Number.isFinite(Date.parse(item.at)) && localDay(Date.parse(item.at)) === today && Date.parse(item.at) <= current)) return { status: 'already-sent', reason: '共同账本已确认今天向这位好友发过消息。' };
  const evidence = snapshot?.dayEvidence;
  // 2026-10-30 主人定：不再要求「会话最新端已核实 / chronology」这类读不出来的凭据——它让
  // 测试用小猫永远停在 date-unknown。现在只要有会话、没登录/验证、有消息数组就能判。
  if (snapshot?.blocked || snapshot?.loginRequired || snapshot?.verificationRequired || !recipientId || !Array.isArray(snapshot.messages) || (evidence && !Number.isFinite(Date.parse(evidence.observedAt)))) return { status: 'date-unknown', reason: '会话没有读到，或登录/验证状态不明。' };
  const messages = snapshot.messages;
  if (messages.some(item => !['incoming', 'outgoing'].includes(item.sender || item.direction) || item.pending || item.failed)) return { status: 'date-unknown', reason: '会话含方向不明或未确认的消息，未自动问候。' };
  // 2026-11-07 主人报「主动问候全是没动静」：会话列表末尾常常挂着一条「没有文字、没有表情、没有分享卡」的空壳行
  // （实测 入机-66 第 11 条：kind=unsupported、text=''、时间标签为空），旧逻辑把它当成「最后一条消息」，
  // 时间读不出来就整轮判 date-unknown，于是一个都不问候。这里先把它滤掉，用最后一条真消息判日期。
  const real = messages.filter(item => item.kind !== 'unsupported' || item.text || item.media);
  const dayOf = item => {
    const kind = item.dateEvidence?.kind;
    if (kind === 'today') return today;
    if (kind === 'yesterday') return yesterday;
    if (kind === 'before-yesterday') return localDay(current - 2 * 86_400_000);
    // 时间证据常常只有 relativeTime（「15:47」），raw 却是空串；用 || 才能落到 sentAt/timestamp 上。
    const raw = String(item.dateEvidence?.raw || item.sentAt || item.timestamp || '').trim();
    // 只有时分（「15:47」「刚刚」）＝今天；「昨天 14:45」「前天 09:01」按字面算。
    if (/^(?:刚刚|今天)(?:\s|$)/.test(raw) || /^\d{1,2}:\d{2}(?::\d{2})?$/.test(raw)) return today;
    // 「48分钟前」「3小时前」这种相对时间也是今天（实测两条 date-unknown 就是它：raw="48分钟前"）。
    if (/^\d+\s*(?:秒|分钟|小时)前$/.test(raw)) return today;
    if (/^\d+\s*天前$/.test(raw)) return localDay(current - Number(/^(\d+)/.exec(raw)[1]) * 86_400_000);
    if (/^昨天/.test(raw)) return yesterday;
    if (/^前天/.test(raw)) return localDay(current - 2 * 86_400_000);
    const monthDay = /^(\d{1,2})[-/月](\d{1,2})日?(?:$|[ T\s])/.exec(raw);
    if (monthDay && kind === 'month-day') {
      const year = Number(today.slice(0, 4));
      const guess = `${year}-${monthDay[1].padStart(2, '0')}-${monthDay[2].padStart(2, '0')}`;
      return guess <= today ? guess : `${year - 1}-${monthDay[1].padStart(2, '0')}-${monthDay[2].padStart(2, '0')}`;
    }
    const date = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})(?:日)?(?:$|[ T\s])/.exec(raw);
    if (!date) return null;
    const padded = `${date[1]}-${date[2].padStart(2, '0')}-${date[3].padStart(2, '0')}`;
    if (!Number.isFinite(Date.parse(padded + 'T00:00:00+08:00')) || localDay(Date.parse(padded + 'T00:00:00+08:00')) !== padded) return null;
    if (/T.*(?:Z|[+-]\d\d:\d\d)$/.test(raw)) return Number.isFinite(Date.parse(raw)) ? localDay(Date.parse(raw)) : null;
    return padded;
  };
  // 2026-10-30 主人定的规则只有一条：今天没发过消息，就直接问候。
  // 证据就看会话里的时间分隔条（刚刚 / 09:01 / 昨天 14:45），不再纠缠「最新端是否已核实」。
  // 2026-11-07：会话尾巴上经常挂着没有时间标签的行（群标签、空壳行、系统提示），
  // 只按「最后一条」判日期会让整轮卡在 date-unknown（实测 青骑三月、捌宁 就是这种）。
  // 改成往前找最近一条**有时间标签**的消息来定日期。
  const dated = real.map(item => ({ item, day: dayOf(item) }));
  const lastOutgoing = [...dated].reverse().find(entry => (entry.item.sender || entry.item.direction) === 'outgoing' && entry.day);
  if (lastOutgoing?.day === today) return { status: 'already-sent', reason: '当前会话已读到今天真实发出的消息。' };
  if (!real.length) return { status: 'eligible', reason: '会话里还没有消息，今天没发过。' };
  const lastKnown = [...dated].reverse().find(entry => entry.day);
  if (!lastKnown) return { status: 'date-unknown', reason: '最后一条消息的时间标签认不出来，不自动问候。' };
  if (lastKnown.day < today) return { status: 'eligible', reason: `最后一条消息是 ${lastKnown.day}，今天还没发过。` };
  return { status: 'eligible', reason: '对方今天留了话，今天还没发过——问候充当回应。' };
}

// 只采集会话身份和未读标识，不读取预览或其他会话正文。
export function readContactDom() {
  const clean = value => (value ?? '').replace(/\s+/g, ' ').trim();
  const resource = value => { try { return new URL(value, location.href).pathname.replace(/~[^/]*/g, '').replace(/\/[0-9]+x[0-9]+\//g, '/'); } catch { return ''; } };
  // 2026-10-24：实测会话列表会把 uid（纯数字）渲染进标题节点，真实昵称可能在 title 或另一个节点里。
  const looksNumeric = value => /^\d{6,}$/.test(value || '');
  const nameOf = row => {
    const known = clean(row.querySelector('.conversationConversationItemtitle,[data-e2e="conversation-name"]')?.textContent);
    if (known && !looksNumeric(known)) return known;
    const titled = clean(row.getAttribute('title') || row.querySelector('[title]')?.getAttribute('title') || '');
    if (titled && !looksNumeric(titled) && titled !== known) return titled;
    return known;
  };
  const dialog = document.querySelector('[data-e2e="im-dialog"]');
  return [...(dialog?.querySelectorAll('[data-e2e="conversation-item"]') ?? [])].map((row, index) => {
    const displayName = nameOf(row);
    return {
      index,
      displayName,
      nameIsNumeric: looksNumeric(displayName),
      nativeId: row.getAttribute('data-conversation-id') || row.getAttribute('data-conversation-short-id') || null,
      avatar: resource(row.querySelector('.commonIMAvataravatarContainer img,img')?.getAttribute('src')),
      unread: Boolean(row.querySelector('[class*="unread"],[class*="Unread"],[data-e2e="unread-count"]')),
      isGroup: Boolean(row.querySelector('[class*="GroupAvatar"],[data-e2e="group-avatar"]')),
    };
  });
}

export function readChatBlockers() {
  const visible = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const labels = [...document.querySelectorAll('body *')].filter(e => !e.childElementCount && visible(e) && !e.closest('[data-e2e="im-dialog"],[data-e2e="conversation-item"]'));
  return {
    loginRequired: labels.some(e => /扫码登录|验证码登录|登录后即可|手机扫码登录/.test(e.textContent)),
    verificationRequired: labels.some(e => /请完成下方验证|请完成验证|安全验证|拖动滑块/.test(e.textContent)),
  };
}

export function readConversationDom() {
  const clean = value => (value ?? '').trim();
  const resource = value => { try { return new URL(value, location.href).pathname.replace(/~[^/]*/g, '').replace(/\/[0-9]+x[0-9]+\//g, '/'); } catch { return ''; } };
  const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight && s.visibility !== 'hidden' && s.display !== 'none'; };
  // 2026-10-30 主人定：抖音会话里的时间分隔条本身就是最硬的证据——「刚刚」「09:01」是今天，
  // 「昨天 14:45」是昨天。原来的正则只认「今天」和完整年月日，「刚刚」「昨天」全落进 unknown，
  // 判定就永远卡在 date-unknown（测试用小猫就是这条）。
  const datedKind = value => {
    const raw = clean(value);
    if (!raw) return 'unknown';
    if (/^(?:刚刚|今天)(?:\s|$)/.test(raw)) return 'today';
    if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(raw)) return 'today';
    if (/^昨天/.test(raw)) return 'yesterday';
    if (/^前天/.test(raw)) return 'before-yesterday';
    if (/^\d{1,2}[-/月]\d{1,2}日?(?:\s|$)/.test(raw)) return 'month-day';
    if (/^\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/.test(raw)) return 'absolute';
    return 'unknown';
  };
  const dialog = document.querySelector('[data-e2e="im-dialog"]');
  // 2026-11-07：DOM 里常驻 7 个 ChatHeader 节点，关掉面板也不销毁，旧的「数量为 1 才算」永远不成立。
  // 现在只认落在可见面板矩形内、且标题非空的那个；标题里的 U+00A0 也统一成普通空格。
  const panel = dialog?.getBoundingClientRect();
  const inPanel = element => {
    const rect = element.getBoundingClientRect();
    return rect.width > 20 && rect.height > 10 && panel && rect.left >= panel.left - 8 && rect.right <= panel.right + 8 && rect.top >= panel.top - 8 && rect.bottom <= panel.bottom + 8;
  };
  const headers = [...(dialog?.querySelectorAll('.StackLayoutStackChatHeaderuser,[data-e2e="chat-header"]') ?? [])].filter(inPanel);
  const header = headers.find(element => clean(element.querySelector('.StackLayoutStackChatHeadertitle,[data-e2e="chat-title"]')?.textContent)) || headers[0] || null;
  const root = header?.closest('.StackLayoutpagespageRoot,[data-e2e="chat-page"]');
  const displayName = clean(header?.querySelector('.StackLayoutStackChatHeadertitle,[data-e2e="chat-title"]')?.textContent)?.replace(/[\u00A0\u2007\u202F]/g, ' ').replace(/\s+/g, ' ').trim();
  const avatar = resource(header?.querySelector('img')?.getAttribute('src'));
  let timestamp = null;
  const messages = [];
  const nodes = root?.querySelectorAll('.MessageBoxTimetimeLayout,time,[data-e2e="msg-item-content"]') ?? [];
  const list = root?.querySelector('.messageMessageListlist');
  let newestFirst = false, chronologySource = list ? 'message-list-order-unverified' : 'dom-order';
  if (list) {
    const style = getComputedStyle(list);
    let verticallyFlipped = false;
    try { verticallyFlipped = style.transform !== 'none' && new DOMMatrix(style.transform).d < 0; } catch {}
    newestFirst = verticallyFlipped || style.flexDirection === 'column-reverse';
    if (newestFirst) chronologySource = verticallyFlipped ? 'message-list-vertical-transform' : 'message-list-column-reverse';
  }
  for (const node of nodes) {
    if (!node.matches('[data-e2e="msg-item-content"]')) { timestamp = node.getAttribute('datetime') || clean(node.textContent) || timestamp; continue; }
    const box = node.closest('.messageMessageBoxmessageBox,[data-e2e="message-row"]') || node;
    const fromMe = Boolean(node.closest('.MessageBoxContentisFromMe,.messageMessageBoxisFromMe,[data-direction="outgoing"]'));
    const direction = fromMe ? 'outgoing' : box.matches('.messageMessageBoxmessageBox,[data-e2e="message-row"]') ? 'incoming' : 'unknown';
    const textNode = node.querySelector('.MessageItemTextcontainer,[data-e2e="message-text"]');
    // 2026-11-07 主人报「18:04 覃张驰发的是表情，没有回」：单独发的表情有两种渲染——
    // 独立的表情盒子 emojiBox，或者「文字气泡里只有一个 .TextMessageTextemoji」。
    // 后者 innerText 是空串，旧逻辑判成 kind=text 但 text=''，随后被 supported() 当成不支持直接丢掉。
    const emojiBox = node.querySelector('.MessageItemEmojiemojiBox');
    const inlineEmoji = textNode?.querySelector('.TextMessageTextemoji');
    const share = node.querySelector('.MessageItemShareAwemecontainer');
    const kind = textNode ? 'text' : emojiBox ? 'emoji' : share ? 'video' : 'unsupported';
    let text = textNode ? clean(textNode.innerText || textNode.textContent) : '';
    let media = null;
    if (emojiBox) {
      const images = [...emojiBox.querySelectorAll('img')].map(image => ({ src: image.currentSrc || image.getAttribute('src') || '', label: clean(image.getAttribute('alt') || image.getAttribute('aria-label') || image.getAttribute('title')) || null }));
      const label = clean(emojiBox.getAttribute('aria-label') || emojiBox.getAttribute('title')) || images.map(image => image.label).filter(Boolean).join(' ') || null;
      // 没有图片（懒加载没出来的表情）就不要挂 media，否则视觉采样无图可看会拖垮整轮；退化成 [表情] 文本。
      if (images.length) media = { type: 'emoji', label, images, requiresVisual: true, understandingScope: 'single-message-image' };
    }
    // 只有表情、没有文字的气泡也要给模型一个可读的占位，不然就是「已读不回」。
    if (!text && (emojiBox || inlineEmoji)) text = '[表情]';
    if (share) {
      let url = null, videoId = null;
      for (const link of share.querySelectorAll('a[href]')) {
        try { const candidate = new URL(link.getAttribute('href'), location.href); const match = /^\/video\/(\d+)\/?$/.exec(candidate.pathname);
          if (candidate.protocol === 'https:' && /^(?:www\.)?douyin\.com$/.test(candidate.hostname) && match) { videoId = match[1]; url = `https://www.douyin.com/video/${videoId}`; break; }
        } catch {}
      }
      const title = clean(share.querySelector('.MessageItemShareAwemetitle,.MessageItemShareAwemedesc,[data-e2e="shared-video-title"]')?.textContent) || null;
      const author = clean(share.querySelector('.MessageItemShareAwemeauthorName,[data-e2e="shared-video-author"]')?.textContent) || null;
      const cover = share.querySelector('.MessageItemShareAwemeawemeContainer,img:not(.MessageItemShareAwemephotosTag):not(.MessageItemShareAwemeauthorAvatar)');
      media = { type: 'shared-work', videoId, url, title, author, isPhotoGallery: Boolean(share.querySelector('.MessageItemShareAwemephotosTag')),
        images: cover ? [{ src: cover.currentSrc || cover.getAttribute('src') || '', label: clean(cover.getAttribute('alt')) || null }] : [],
        requiresVisual: true, understandingScope: 'card-cover-and-dom-metadata', publicUrlSource: url ? 'dom-link' : null, canResolveByOpeningCard: true };
    }
    const indexNode = node.closest('[data-index]');
    const rawOrder = indexNode?.getAttribute('data-index');
    const order = rawOrder !== null && rawOrder !== undefined && /^\d+$/.test(rawOrder) ? Number(rawOrder) : null;
    const nativeId = box.getAttribute('data-message-id') || box.getAttribute('data-msg-id') || node.getAttribute('data-message-id') || null;
    const ownTimestamp = box.getAttribute('data-sent-at') || box.getAttribute('data-timestamp') || node.getAttribute('data-sent-at');
    const ownTimeNode = box.querySelector('.MessageBoxTimetimeLayout,time');
    const ownTime = ownTimeNode?.getAttribute('datetime') || clean(ownTimeNode?.textContent);
    // 2026-10-30：倒序列表里也退回分组时间标签——「昨天 14:45」「刚刚」就写在分隔条上。
    // 原来这里对 newestFirst 直接给 null，日期证据就永远是 unknown，判定永远过不去。
    const dated = ownTimestamp || ownTime || timestamp || null;
    messages.push({ nativeId, direction, sender: direction, text, kind, media, timestamp: ownTimestamp || timestamp, order, domIndex: order, domPosition: messages.length, orderMode: list ? 'relative' : 'absolute',
      dateEvidence: { raw: dated || timestamp || '', kind: datedKind(dated), source: ownTimestamp ? 'message-attribute' : ownTime ? 'message-time' : !newestFirst ? 'group-label' : 'unverified-group-label' },
      failed: Boolean(box.querySelector('[class*="sendFail"],[class*="SendFail"],[data-e2e="message-failed"]')),
      pending: Boolean(box.querySelector('[class*="sending"],[class*="Sending"],[data-e2e="message-pending"]')) });
  }
  const emptyTodayVerified = messages.length === 0 && [...(root?.querySelectorAll('[data-e2e="empty-conversation"],[class*="empty" i]') ?? [])].some(element => visible(element) && /^今天(?:还)?(?:暂无|没有|尚无)消息[。！!\s]*$/.test(clean(element.textContent)));
  const latestEndVerified = emptyTodayVerified || newestFirst && messages.some(message => message.domIndex === 0);
  if (list) messages.forEach(message => { message.latestEndVerified = latestEndVerified; });
  if (newestFirst) {
    messages.reverse();
    let previousTime = null;
    messages.forEach((message, index) => { message.order = index; message.timestamp ??= previousTime; previousTime = message.timestamp; });
  }
  const loading = [...(root?.querySelectorAll('[class*="loading"],[class*="Loading"],[aria-busy="true"]') ?? [])].some(visible);
  const historyStartVerified = [...(root?.querySelectorAll('[data-e2e="history-start"],[class*="no-more-tip"],[class*="noMoreTip"]') ?? [])].some(element => visible(element) && /没有更多消息|暂无更多消息|已显示全部消息/.test(clean(element.textContent)));
  return { displayName, avatar, messages, loading, latestEndVerified, emptyTodayVerified, historyStartVerified, observedAt: new Date().toISOString(), chronology: list && !newestFirst && !emptyTodayVerified ? 'unknown' : 'oldest-first', chronologySource, sourceDomOrder: newestFirst ? 'newest-first' : list ? 'unknown' : 'oldest-first' };
}

export function readChatIdentityDom() {
  // 2026-11-07：会话标题里的空格可能是 U+00A0（实测「海口男生发型定制设计 oimg」就带一个），
  // 而会话列表那侧统一按 \s+ 归一成普通空格。两边不做同一套归一化，标题比对永远不相等。
  const clean = value => String(value || '').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u00A0\u2007\u202F]/g, ' ').replace(/\s+/g, ' ').trim();
  const panel = document.querySelector('[data-e2e="im-dialog"]')?.getBoundingClientRect();
  if (!panel || panel.width < 40 || panel.height < 40) return { displayName: undefined, avatar: '' };
  const inPanel = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 20 && r.height > 10 && r.left >= panel.left - 8 && r.right <= panel.right + 8 && r.top >= panel.top - 8 && r.bottom <= panel.bottom + 8 && s.visibility !== 'hidden' && s.display !== 'none'; };
  // 2026-11-07：DOM 里常驻 7 个 ChatHeader 节点（关掉面板也不销毁），只认落在可见面板矩形内、标题非空的那个。
  const headers = [...document.querySelectorAll('[data-e2e="im-dialog"] .StackLayoutStackChatHeaderuser,[data-e2e="im-dialog"] [data-e2e="chat-header"]')].filter(inPanel);
  const header = headers.find(element => clean(element.querySelector('.StackLayoutStackChatHeadertitle,[data-e2e="chat-title"]')?.textContent)) || headers[0] || null;
  const src = header?.querySelector('img')?.getAttribute('src');
  let avatar = ''; try { avatar = new URL(src, location.href).pathname.replace(/~[^/]*/g, '').replace(/\/[0-9]+x[0-9]+\//g, '/'); } catch {}
  return { displayName: clean(header?.querySelector('.StackLayoutStackChatHeadertitle,[data-e2e="chat-title"]')?.textContent) || undefined, avatar };
}

// 会话列表去重：抖音同一批会话会被重复渲染成几十条同名行，且每行原生 id 都不一样。
// 按昵称归一化分组（去零宽字符/空白/大小写/标点差异），每组只保留一行；组内优先保留已在白名单里的那条。
export function dedupeContactRows(rawRows, preferredIds = new Set()) {
  const clean = value => String(value || '').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  const keyOf = value => clean(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') || clean(value);
  const convOf = row => `conv:${hash(row.nativeId ? `native:${row.nativeId}` : `${row.displayName}\0${row.avatar}`)}`;
  const groups = new Map();
  for (const raw of rawRows) {
    const displayName = clean(raw?.displayName);
    if (!displayName) continue;
    const row = { ...raw, displayName };
    const key = keyOf(displayName);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const kept = [];
  for (const list of groups.values()) kept.push(list.find(row => preferredIds.has(convOf(row))) ?? list[0]);
  return kept;
}

export class ChatBrowser {
  constructor({ source = 'api-chat', controller } = {}) {
    if (!['api-chat', 'dsh-chat'].includes(source)) throw new TypeError('私信入口须为 api-chat 或 dsh-chat。');
    this.controller = controller ?? new BrowserController({ source });
    // 共用观看那个 controller 时不要关它（关掉等于把整个抖音标签页关了）。
    this.sharedController = Boolean(controller);
    this.contacts = new Map();
    this.following = null;
    this.identities = new MessageIdentityTracker();
    this.mediaResources = new Map();
  }
  // 自主观看是否正在占用同一个标签页（锁文件 + 进程存活）。私信轮询不该在它跑的时候暂停视频。
  watchRoundActive() {
    try {
      const stateDir = this.controller?.limits?.()?.stateDir;
      if (!stateDir) return false;
      const owner = JSON.parse(fs.readFileSync(path.join(stateDir, 'watch-loop.lock'), 'utf8'));
      if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1) return false;
      try { process.kill(owner.pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
    } catch { return false; }
  }
  async dialog(page, signal) {
    stop(signal);
    // 窗口最小化时面板会停在屏幕外（见 normalizeWindow 的注释），每次进面板前先纠正。
    await this.normalizeWindow(page);
    // 2026-10-24 主人报「看完视频就再也播不动」的根因：这里原来挂了一个永久的 play 拦截器，
    // 私信面板关掉以后视频仍然一播就被 pause，自主观看下一次就判「作品被暂停」。
    // 现在只在没有自主观看时暂停一次，不挂永久监听；关面板时由 restorePage 收拾干净。
    // 2026-10-25：这句暂停是给“手动开面板别让推荐流跑走”用的，但它在分享视频播放期间也可能命中，
    // 实测会把刚点开的分享视频按停（主人看到“播一下又停”）。私信只读 DOM，不需要暂停视频，干脆不做。
    const flags = await page.evaluate(readChatBlockers);
    if (flags.loginRequired || flags.verificationRequired) return { ...flags, blocked: true };
    if (!await page.locator('[data-e2e="im-dialog"]').isVisible().catch(() => false)) {
      const entry = page.locator('[data-e2e="im-entry"]');
      try { await entry.waitFor({ state: 'visible', timeout: 20_000 }); }
      catch { throw new Error('没有找到抖音消息入口。'); }
      // 2026-10-25：推荐流在放视频时，铺满的 <video> 会挡住「消息」入口的指针事件，
      // Playwright 的 click 点 10 秒也点不到，接着三个联系人全被 pause（实测 06:37:58）。
      // 先正常点一次，被挡就直派发 DOM click（React 的 onClick 照样接得住）。
      try { await entry.click({ timeout: 8_000 }); }
      catch { await entry.evaluate(element => { const target = element.querySelector('[data-e2e="something-button"]') || element; target.click(); }).catch(() => {}); }
      await page.locator('[data-e2e="im-dialog"]').waitFor({ state: 'visible', timeout: 15_000 }).catch(() => { throw new Error('私信面板没有打开（消息入口被视频挡住，DOM 点击也没生效）。'); });
    }
    stop(signal);
    return { ...flags, blocked: false };
  }
  // 读完/发完把私信面板关掉：面板盖着推荐流时，自主观看会把整轮判成「页面需要手动处理」。
  async restorePage(page) {
    if ((this._panelHold || 0) > 0) return;
    try {
      await page.evaluate(() => {
        if (typeof window.__deepseekChatPauseVideo === 'function') { document.removeEventListener('play', window.__deepseekChatPauseVideo, true); window.__deepseekChatPauseVideo = null; }
      }).catch(() => {});
      const close = page.locator('.StackLayoutStackTitleBarcloseImPage:visible');
      if (await close.count().catch(() => 0)) await close.last().click({ timeout: 2000 }).catch(() => {});
      await page.waitForFunction(() => {
        const visible = element => { const rect = element.getBoundingClientRect(), style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; };
        return ![...document.querySelectorAll('[data-e2e="im-dialog"]')].some(visible);
      }, undefined, { timeout: 3000 }).catch(() => {});
    } catch { /* 关不上不影响已经读到的结果 */ }
  }
  // 2026-11-06 主人报「读联系人一直 90 秒超时」。旧实现的三个问题：
  // ① 用 Playwright 的 click 点 [data-e2e="user-info-follow"]，那个元素右边压着「N人正在直播」角标，
  //    指针事件被角标吃掉，actionability 检查每次白等 5 秒，名单压根没打开；
  // ② 每次点完还要等 8 秒 fans-container，三次重试约 40 秒，加上前后两次整页导航就顶穿宿主的 90 秒上限；
  // ③ 读不到就 throw，this.following 永远停在 null，于是每次调用都重跑整段，越用越慢。
  // 现在：在临时标签页里直达本人主页 → 按「关注」两个字的坐标用真实鼠标点（角标拦不到）→ 等行出现 →
  // 把名单滚到底（名单是懒加载的，直接设 scrollTop 到底才触发下一批）→ 结果落盘缓存。
  // 用临时标签页是因为读名单要整页导航，占用推荐流那页会把私信面板冲掉，回头还得重新等首页渲染再开面板。
  async verifyFollowing(page, signal) {
    const traceAt = Date.now();
    const trace = label => { if (process.env.DOUYIN_CHAT_TRACE) console.log(`[following] ${label} +${((Date.now() - traceAt) / 1000).toFixed(1)}s`); };
    let tab;
    try {
      tab = await page.context().newPage();
    } catch (error) {
      trace('开临时标签页失败，退回当前页 ' + error.message);
      tab = page;
    }
    const own = tab !== page;
    try {
      tab.setDefaultTimeout(10_000);
      tab.setDefaultNavigationTimeout(25_000);
      // 后台标签页的定时器会被浏览器降频（实测 300ms 变 1s 以上），读名单全靠短轮询，所以先提到前台。
      if (own) await tab.bringToFront().catch(() => {});
      let rows = [];
      // 读名单不是主任务：整段自己算预算，最多 50 秒，超了就带空表回去（联系人照样能读）。
      const deadline = Date.now() + 50_000;
      const left = () => deadline - Date.now();
      const hasEntry = () => tab.waitForFunction(() => Boolean(document.querySelector('[data-e2e="user-info-follow"]')), undefined, { timeout: Math.max(1_000, Math.min(12_000, left())) }).then(() => true).catch(() => false);
      try {
        await tab.goto(PROFILE, { waitUntil: 'domcontentloaded' });
        trace('profile loaded');
        // 本人主页偶发冷渲染很慢（实测 19 秒才出 DOM），等不到就重载一次再等，别把整段预算一次烧光。
        let ready = await hasEntry();
        if (!ready && left() > 6_000) { trace('entry not ready, reload'); await tab.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); ready = await hasEntry(); }
        trace('follow entry visible ' + ready);
        await tab.waitForTimeout(1_200);
        for (let attempt = 0; attempt < 4 && !rows.length && left() > 4_000; attempt += 1) {
          stop(signal);
          // 弹层打开后要等约 2 秒才填数据；这期间再点一次，点中的是弹层遮罩，会把刚开的名单关掉。
          // 所以只在「容器真的不在」时才点，点完先短等看容器是否出现（没出现=没点中，立刻重点）。
          const opened = await tab.evaluate(() => Boolean(document.querySelector('[data-e2e="user-fans-container"]'))).catch(() => false);
          if (!opened) {
            const point = await tab.evaluate(() => {
              const host = document.querySelector('[data-e2e="user-info-follow"]');
              if (!host) return null;
              const label = [...host.querySelectorAll('div,span')].find(element => (element.textContent || '').trim() === '关注') || host;
              const rect = label.getBoundingClientRect();
              return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
            }).catch(() => null);
            if (!point) { await tab.waitForTimeout(600); continue; }
            await tab.mouse.click(point.x, point.y);
            trace('clicked attempt ' + attempt);
          }
          const started = Date.now();
          while (Date.now() - started < 6_000 && left() > 1_500) {
            rows = await tab.evaluate(readFollowingRows).catch(() => []);
            if (rows.length) break;
            const present = await tab.evaluate(() => Boolean(document.querySelector('[data-e2e="user-fans-container"]'))).catch(() => false);
            if (!present && Date.now() - started > 2_500) { trace('容器没出现，重新点'); break; }
            await tab.waitForTimeout(300);
          }
          trace('attempt ' + attempt + ' rows=' + rows.length);
        }
        if (rows.length) {
          let stable = 0;
          for (let round = 0; round < 26 && stable < 2 && left() > 2_000; round += 1) {
            stop(signal);
            const before = rows.length;
            // 名单是懒加载 + 虚拟列表：滚到底 → 等一批渲染 → 再滚一次到底，每轮大约多拿 20~40 行。
            const scroll = () => tab.evaluate(() => {
              const root = document.querySelector('[data-e2e="user-fans-container"]');
              if (!root) return { container: false };
              const scroller = [root, ...root.querySelectorAll('div')].find(element => element.scrollHeight > element.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(element).overflowY)) || root;
              scroller.scrollTop = scroller.scrollHeight;
              return { container: true, top: Math.round(scroller.scrollTop), height: scroller.scrollHeight };
            }).catch(() => ({}));
            const info = await scroll();
            let next = rows;
            for (let wait = 0; wait < 3 && next.length === before; wait += 1) {
              await tab.waitForTimeout(350);
              // 只增不减：弹层万一被关掉，重读会得到 0 行，不能把已经读到的名单冲掉。
              const read = await tab.evaluate(readFollowingRows).catch(() => []);
              if (read.length > next.length) next = read;
            }
            if (next.length > before) { await scroll(); await tab.waitForTimeout(350); const read = await tab.evaluate(readFollowingRows).catch(() => []); if (read.length > next.length) next = read; }
            rows = next;
            stable = rows.length === before ? stable + 1 : 0;
            trace(`scroll ${round} rows=${rows.length} ${JSON.stringify(info)}`);
          }
        }
      } catch (error) {
        // 主页没渲染出来/没找到关注入口都只算「这次没核成」，不打断读联系人。
        trace('名单读取中断 ' + error.message);
      }
      this.following = rows;
      this.writeFollowingCache(rows.length > 0, rows);
      trace('rows settled ' + rows.length);
    } finally {
      if (own) {
        await tab.close().catch(() => {});
        await page.bringToFront().catch(() => {});
      }
    }
  }
  // 关注名单读一次要 20~50 秒，而调用方几乎每轮都会传 verifyFollowing:true。
  // 落一份缓存：成功管 6 小时，失败管 10 分钟（失败也存，否则每次调用都重烧一遍）。
  followingCacheFile() {
    try {
      const dir = this.controller?.limits?.()?.stateDir;
      return dir ? path.join(dir, 'chat-following.json') : null;
    } catch { return null; }
  }
  readFollowingCache() {
    const file = this.followingCacheFile();
    if (!file) return null;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const at = Date.parse(data?.at);
      if (!Number.isFinite(at) || (data?.ok !== true && data?.ok !== false)) return null;
      if (data.ok && !Array.isArray(data.rows)) return null;
      const ttl = data.ok ? 6 * 3_600_000 : 10 * 60_000;
      return { ok: data.ok, rows: data.ok ? data.rows : [], stale: Date.now() - at > ttl };
    } catch { return null; }
  }
  writeFollowingCache(ok, rows) {
    const file = this.followingCacheFile();
    if (!file) return;
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ at: new Date().toISOString(), ok, count: rows.length, rows }), 'utf8');
      fs.renameSync(temporary, file);
    } catch { /* 缓存写不进去不影响本次结果 */ }
  }
  // 2026-11-07：专用 Edge 窗口被最小化时，抖音消息面板会停在屏幕右外侧（实测 dialog.x=929 > 视口宽 921），
  // 行有尺寸却点不动，select() 连点三次都判「会话没打开」，好友被暂停、续火花预检缺人。进面板前先恢复窗口。
  async normalizeWindow(page) {
    let session;
    try {
      session = await page.context().newCDPSession(page);
      const { windowId, bounds } = await session.send('Browser.getWindowForTarget');
      if (bounds.windowState !== 'normal') {
        await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
        await page.waitForTimeout(400);
      }
      if (bounds.width < 1_100 || bounds.height < 760) {
        await session.send('Browser.setWindowBounds', { windowId, bounds: { width: 1_280, height: Math.min(960, Math.max(800, bounds.height)) } });
        await page.waitForTimeout(600);
      }
      // 2026-11-07：窗口还可能被拖到屏幕外（实测 left:1055 top:880），此时视口里没有面板、
      // 点「消息」也没反应，只能把窗口拉回可见区域再继续。
      // 用 availLeft/availTop 判边界，双屏时窗口挂在副屏不会被误拉回主屏。
      const area = await page.evaluate(() => ({ left: screen.availLeft, top: screen.availTop, width: screen.availWidth, height: screen.availHeight })).catch(() => null);
      const visible = area
        && bounds.left + 240 > area.left && bounds.left < area.left + area.width
        && bounds.top + 120 > area.top && bounds.top < area.top + area.height;
      if (area && !visible) {
        await session.send('Browser.setWindowBounds', { windowId, bounds: { left: area.left + 40, top: area.top + 40 } });
        await page.waitForTimeout(500);
      }
      return true;
    } catch {
      return false;
    } finally {
      if (session) await session.detach().catch(() => {});
    }
  }
  // 面板和会话页是抖音的常驻 DOM：关掉以后节点还在、只是不可见，残留节点照样带宽高。
  // 所以「可见」必须同时满足：面板整块在视口内 + 行的中心落在面板矩形内 + 会话标题落在面板矩形内。
  async panelState(page) {
    return page.evaluate(() => {
      const dialog = document.querySelector('[data-e2e="im-dialog"]');
      if (!dialog) return { open: false, rows: 0, chat: false };
      const box = dialog.getBoundingClientRect();
      const open = box.width >= 40 && box.height >= 40 && box.x >= 0 && box.y >= 0 && box.x + box.width <= innerWidth + 40 && box.y + box.height <= innerHeight + 40;
      if (!open) return { open: false, rows: 0, chat: false };
      const rows = [...dialog.querySelectorAll('[data-e2e="conversation-item"]')].filter(row => {
        const rect = row.getBoundingClientRect();
        const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
        return rect.width > 4 && rect.height > 4 && cx > box.x && cx < box.x + box.width && cy > box.y && cy < box.y + box.height && cx > 0 && cx < innerWidth;
      }).length;
      const chat = [...dialog.querySelectorAll('[class*="ChatHeader"]')].some(element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 60 && rect.height > 10 && rect.x >= box.x - 8 && rect.x + rect.width <= box.x + box.width + 8;
      });
      return { open, rows, chat };
    }).catch(() => ({ open: false, rows: 0, chat: false }));
  }
  // 会话页开着的时候，会话列表里会缺当前这一位（实测 12 人变 11 人）。读名单前必须先退回列表。
  async leaveChat(page) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let state = await this.panelState(page);
      if (!state.chat) return state;
      // 会话页接了 Escape；不行再点标题栏左上角的返回箭头。
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(450);
      state = await this.panelState(page);
      if (!state.chat) return state;
      const back = await page.evaluate(() => {
        const dialog = document.querySelector('[data-e2e="im-dialog"]');
        if (!dialog) return null;
        const header = [...dialog.querySelectorAll('[class*="ChatHeader"]')].find(element => { const rect = element.getBoundingClientRect(); return rect.width > 60 && rect.height > 10; });
        if (!header) return null;
        const rect = header.getBoundingClientRect();
        return { x: Math.round(rect.x + 20), y: Math.round(rect.y + 22) };
      }).catch(() => null);
      if (back) await page.mouse.click(back.x, back.y).catch(() => {});
      await page.waitForTimeout(600);
    }
    return this.panelState(page);
  }
  async ensureList(page, signal, attempts = 4) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      stop(signal);
      let state = await this.panelState(page);
      if (state.open && state.rows >= 2) return state;
      if (state.chat) { state = await this.leaveChat(page); if (state.open && state.rows >= 2) return state; }
      if (!state.open) {
        // 入口是 toggle：面板已经开着时再点会把它关掉，所以只在确认不可见时才点。
        const entry = page.locator('[data-e2e="im-entry"]');
        if (!await entry.count().catch(() => 0)) { await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(300); continue; }
        await entry.click({ timeout: 5_000 }).catch(async () => {
          const box = await entry.boundingBox().catch(() => null);
          if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
        });
      }
      for (let wait = 0; wait < 12; wait += 1) {
        await page.waitForTimeout(300);
        state = await this.panelState(page);
        if (state.open && state.rows >= 2) return state;
        if (state.chat) break;
      }
    }
    throw new Error('私信面板没有打开（消息入口点不开）。');
  }
  // 行要先进列表可视区再点：贴着面板底边那一行，点下去命中的是输入框。
  async scrollRowIntoView(page, id) {
    await page.evaluate(target => {
      const list = document.querySelector('[data-e2e="im-dialog"] .conversationConversationListwrapper');
      const row = [...document.querySelectorAll('[data-e2e="im-dialog"] [data-e2e="conversation-item"]')].find(item => item.getAttribute('data-deepseek-chat-id') === target);
      if (!list || !row) return;
      const listBox = list.getBoundingClientRect(), rowBox = row.getBoundingClientRect();
      if (rowBox.top < listBox.top || rowBox.bottom > listBox.bottom) list.scrollTop += (rowBox.top - listBox.top) - Math.max(0, (listBox.height - rowBox.height) / 2);
    }, id).catch(() => {});
    await page.waitForTimeout(200);
  }
  // 2026-10-25 主人定：轮询先看右上角「消息」入口上的红数字，0 就不开面板。
  // 只读，不点开私信页；拿不准（入口没渲染/数字不是数字）就返回 count:null，让调用方照旧全读，宁慢勿漏。
  unreadCount() {
    return this.controller.withPage(async page => page.evaluate(() => {
      const entry = document.querySelector('[data-e2e="im-entry"]');
      if (!entry) return { ok: false, count: null, raw: null };
      const badge = entry.querySelector('.semi-badge-count');
      const raw = (badge?.textContent || '').trim();
      if (!raw) return { ok: true, count: 0, raw: '' };
      const match = /^(\d{1,4})\+?$/.exec(raw);
      return { ok: true, count: match ? Number(match[1]) : null, raw };
    }), {});
  }
  // 2026-10-25 主人报「反复关掉又再拉开」：一次轮询里要读/发好几步，每一步 readConversation 都会
  // 在 finally 里 restorePage 关一次面板。holdPanel() 期间不关门，最后由调用方 closePanel() 收一次。
  holdPanel() { this._panelHold = (this._panelHold || 0) + 1; }
  releasePanel() { this._panelHold = Math.max(0, (this._panelHold || 0) - 1); }
  // 只看角标、一个会话都不读的时候，别把面板留在页面上（挡住推荐流会让自主观看判 needs_user）。
  closePanel() {
    return this.controller.withPage(async (page) => { await this.restorePage(page); return { ok: true }; }, {});
  }
  // 列表是懒加载的：滚到底再回顶，逼出最后一批行，然后用「可见行数连续两次不变」确认渲染完。
  // 2026-11-07：以前只在 first().waitFor(attached) 之后立刻读，面板刚打开时少一行（12 人读成 11 人），
  // 于是 select() 判「指定联系人已变化」把好友暂停、续火花预检缺人拒绝启动。
  async settleListRows(page) {
    const count = () => page.evaluate(() => {
      const dialog = document.querySelector('[data-e2e="im-dialog"]');
      if (!dialog) return 0;
      const box = dialog.getBoundingClientRect();
      return [...dialog.querySelectorAll('[data-e2e="conversation-item"]')].filter(row => {
        const rect = row.getBoundingClientRect();
        const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
        return rect.width > 4 && rect.height > 4 && cx > box.x && cx < box.x + box.width && cy > box.y && cy < box.y + box.height;
      }).length;
    }).catch(() => 0);
    const scroll = to => page.evaluate(position => {
      const list = document.querySelector('[data-e2e="im-dialog"] .conversationConversationListwrapper');
      if (!list) return false;
      list.scrollTop = position === 'bottom' ? list.scrollHeight : 0;
      return true;
    }, to).catch(() => false);
    if (await scroll('bottom')) await page.waitForTimeout(350);
    if (await scroll('top')) await page.waitForTimeout(200);
    let previous = -1, steady = 0;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      await page.waitForTimeout(250);
      const now = await count();
      steady = now === previous ? steady + 1 : 0;
      previous = now;
      if (steady >= 2) return now;
    }
    return previous;
  }
  async contactList(page, signal) {
    const flags = await this.dialog(page, signal);
    if (flags.blocked) return { ...flags, contacts: [] };
    // 会话页开着的时候，会话列表里会缺当前这一位（实测 12 人变 11 人），所以先退回列表；
    // 面板也可能只是「残留 DOM 还在、其实关着」，ensureList 会把它真正打开。
    await this.ensureList(page, signal);
    await this.leaveChat(page);
    await this.ensureList(page, signal);
    await this.settleListRows(page);
    if (this.following?.length === 2) await page.waitForFunction(() => document.querySelectorAll('[data-e2e="im-dialog"] [data-e2e="conversation-item"]').length >= 2, undefined, { timeout: 5000 }).catch(() => {});
    const rawRows = await page.evaluate(readContactDom);
    // 2026-10-25：同一批会话被 DOM 重复渲染时会出现几十条同名行（设置页那次 17 个「测试用小猫」）。
    // 旧写法只看原生 id，可同一人每次渲染的 id 都不一样，去重等于没做；现在先按昵称归一化分组，
    // 组内优先保留「已在白名单里」的那条，这样勾选状态不会因为换了条 id 而错位。
    const rows = dedupeContactRows(rawRows, this.preferredContactIds ?? new Set());
    const identities = rows.map(row => `conv:${hash(row.nativeId ? `native:${row.nativeId}` : `${row.displayName}\0${row.avatar}`)}`);
    if (new Set(identities).size !== identities.length || rows.some(row => !row.displayName || (!row.nativeId && !row.avatar))) throw new Error('联系人身份不完整或存在歧义，已停止读取会话。');
    const contacts = [];
    const marks = [];
    this.contacts.clear();
    for (const [index, row] of rows.entries()) {
      const id = identities[index];
      const matching = this.following?.filter(item => item.displayName === row.displayName && item.mutual) ?? [];
      const uniqueName = rows.filter(item => item.displayName === row.displayName).length === 1;
      const followed = matching.length === 1 && uniqueName ? true : null;
      const contact = { id, displayName: row.displayName, name: row.displayName, unread: row.unread, followed, isGroup: row.isGroup ? true : followed ? false : null,
        relationshipEvidence: followed ? { source: 'self-follow-list', label: '相互关注', matchedBy: 'unique-display-name', accountIdCrossChecked: false } : null };
      this.contacts.set(id, { ...contact, avatar: row.avatar });
      contacts.push(contact);
      marks.push({ index, id });
    }
    // 2026-10-30 主人报「读私信又卡住」：原写法逐行 nth(index).evaluate()，每行一次往返；locator 解析
    // 不到时默认等 30 秒，一行失败会把整串拖成几分钟，读一次会话能卡到时间超时。改成一次 evaluate
    // 按 DOM 顺序批量打标记，行为和结果都不变（标记只是给 select() 找行的锚点），失败照旧不影响读取。
    try {
      await page.evaluate(list => {
        const nodes = [...document.querySelectorAll('[data-e2e="im-dialog"] [data-e2e="conversation-item"]')];
        for (const item of list) nodes[item.index]?.setAttribute('data-deepseek-chat-id', item.id);
      }, marks);
    } catch { /* 标记失败不影响读取 */ }
    return { ...flags, contacts };
  }
  listContacts({ signal, verifyFollowing = this.following === null, preferredIds = [] } = {}) {
    this.preferredContactIds = new Set(Array.isArray(preferredIds) ? preferredIds : []);
    return this.controller.withPage(async page => {
      // 名单读一次要几十秒，而调用方几乎每轮都传 verifyFollowing:true：先看落盘缓存，新鲜的直接当已知关系用。
      if (this.following === null) {
        const cached = this.readFollowingCache();
        if (cached && !cached.stale) this.following = cached.rows;
      }
      const initial = await this.dialog(page, signal);
      if (initial.blocked) return { ...initial, contacts: [] };
      // 名单在临时标签页里读，推荐流那页不导航，刚打开的私信面板不会被打断。
      if (verifyFollowing && this.following === null) await this.verifyFollowing(page, signal);
      return this.contactList(page, signal);
    }, { signal });
  }
  async select(page, recipientId, signal) {
    if (typeof recipientId !== 'string' || !/^conv:[a-f0-9]{64}$/.test(recipientId)) throw new TypeError('需要已发现的精确联系人 ID。');
    let contact = this.contacts.get(recipientId);
    let flags;
    if (contact) {
      // 轮询里 listContacts 刚整轮读过列表，这里再整轮重读要多花 5~6 秒；只在没这个人时才重读。
      flags = await this.dialog(page, signal);
      if (flags.blocked) return { flags };
      await this.ensureList(page, signal);
      await this.leaveChat(page);
    } else {
      flags = await this.contactList(page, signal);
      if (flags.blocked) return { flags };
      contact = this.contacts.get(recipientId);
      // 列表少一行时这里会取不到人：先补读一次，而不是直接把好友判成「已变化」。
      if (!contact) { await this.contactList(page, signal); contact = this.contacts.get(recipientId); }
    }
    if (!contact || contact.isGroup === true) throw new Error('指定联系人已变化或属于群聊，已停止操作。');
    let row = page.locator(`[data-e2e="conversation-item"][data-deepseek-chat-id="${recipientId}"]`);
    // 2026-11-07：快路径只做 ensureList/leaveChat，列表一重渲染就把上次打的 data-deepseek-chat-id 全抹掉，
    // count 变 0 直接抛「不是唯一匹配」（实测 步月登云 / jrz / 脑花 三个都被这条卡住）。缺标记就补读一次列表。
    if (await row.count() !== 1) {
      await this.contactList(page, signal);
      contact = this.contacts.get(recipientId);
      if (!contact || contact.isGroup === true) throw new Error('指定联系人已变化或属于群聊，已停止操作。');
      row = page.locator(`[data-e2e="conversation-item"][data-deepseek-chat-id="${recipientId}"]`);
    }
    if (await row.count() !== 1) throw new Error('指定会话不是唯一匹配，已停止操作。');
    const current = await page.evaluate(readChatIdentityDom);
    if (current.displayName !== contact.displayName) {
      const back = page.locator('[data-stack-layer="chat"] .StackLayoutStackTitleBarbackBtn');
      if (current.displayName && await back.count() === 1) {
        await back.click();
        await this.contactList(page, signal);
      }
      // 2026-11-07：DOM 里常驻 7 个 ChatHeader，不能用「可见 header 数量」判会话开没开；
      // 必须要求「面板在视口内 + header 在面板矩形内 + 标题等于期望昵称」。
      const opened = () => page.waitForFunction(expected => {
        const dialog = document.querySelector('[data-e2e="im-dialog"]');
        if (!dialog) return false;
        const box = dialog.getBoundingClientRect();
        if (!(box.width >= 40 && box.height >= 40 && box.x >= 0 && box.y >= 0 && box.x + box.width <= innerWidth + 40 && box.y + box.height <= innerHeight + 40)) return false;
        const clean = value => String(value || '').replace(/[\u00A0\u2007\u202F]/g, ' ').replace(/\s+/g, ' ').trim();
        const headers = [...dialog.querySelectorAll('.StackLayoutStackChatHeaderuser,[data-e2e="chat-header"]')].filter(header => {
          const rect = header.getBoundingClientRect();
          return rect.width > 20 && rect.height > 10 && rect.left >= box.left - 8 && rect.right <= box.right + 8 && rect.top >= box.top - 8 && rect.bottom <= box.bottom + 8;
        });
        return headers.some(header => clean(header.querySelector('.StackLayoutStackChatHeadertitle,[data-e2e="chat-title"]')?.textContent) === clean(expected));
      }, contact.displayName, { timeout: 8_000 }).then(() => true).catch(() => false);
      // 三次尝试：先 Playwright click（带 5 秒上限），再按坐标鼠标点（行先滚进列表可视区），最后派发 DOM click。
      let done = false;
      for (let attempt = 0; attempt < 3 && !done; attempt += 1) {
        stop(signal);
        await this.scrollRowIntoView(page, recipientId);
        if (attempt === 0) await row.click({ timeout: 5_000 }).catch(() => {});
        else if (attempt === 1) {
          const box = await row.boundingBox().catch(() => null);
          if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
        } else await row.evaluate(element => element.click()).catch(() => {});
        await page.waitForTimeout(250);
        done = await opened();
      }
      if (!done) throw new Error('会话没有打开（点击没有生效），已停止操作。');
      await page.waitForTimeout(300);
    }
    const identity = await page.evaluate(readChatIdentityDom);
    // 2026-10-24：头像链接带签名、每次可能不同，不能拿它当身份。身份以 data-deepseek-chat-id 为准，
    // 这里只核对标题（昵称）；头像不一致只记下来，不再中止。
    if (identity.displayName !== contact.displayName) throw new Error('会话标题回读与联系人不一致，已停止操作。');
    stop(signal);
    return { contact, flags };
  }
  async stableConversation(page, contact, signal) {
    let previous;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      stop(signal);
      const current = await page.evaluate(readConversationDom);
      if (current.displayName !== contact.displayName || current.avatar !== contact.avatar) throw new Error('读取前会话身份发生变化。');
      const signature = JSON.stringify(current.messages);
      if (!current.loading && previous === signature) return current;
      previous = current.loading ? undefined : signature;
      await page.waitForTimeout(150);
    }
    throw new Error('指定会话的消息列表仍在加载或变化，未确认正文快照。');
  }
  publicMessages(recipientId, rawRows) {
    const rows = rawRows.map(row => {
      if (!row.media) return row;
      const { images = [], ...media } = row.media;
      const resources = images.filter(image => image.src).map(image => {
        const ref = `media:${hash(image.src.startsWith('data:') ? image.src : (() => { try { return new URL(image.src).pathname; } catch { return image.src; } })())}`;
        this.mediaResources.set(ref, { src: image.src, label: image.label ?? null, recipientId });
        return { resourceRef: ref, label: image.label ?? null };
      });
      // 2026-11-07：表情图片的地址有时还没加载（src 为空），这种 media 拿去视觉采样必然「没有画面」，
      // 会把联系人直接判成暂停。没图就退化成 [表情] 文本，交给模型正常回一句。
      if (media.type === 'emoji' && resources.length === 0) return { ...row, media: null };
      return { ...row, media: { ...media, imageCount: resources.length, resources } };
    });
    const identified = this.identities.identify(recipientId, rows);
    return identified.map(row => row.media?.type === 'shared-work' ? { ...row, media: { ...row.media,
      safeOpenSelector: `[data-deepseek-message-id="${row.id}"] .MessageItemShareAwemecontainer` } } : row);
  }
  async markMessages(page, messages) {
    await page.evaluate(mapping => {
      const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight && s.visibility !== 'hidden' && s.display !== 'none'; };
      const header = [...document.querySelectorAll('[data-e2e="im-dialog"] .StackLayoutStackChatHeaderuser,[data-e2e="im-dialog"] [data-e2e="chat-header"]')].filter(visible);
      const root = header.length === 1 ? header[0].closest('.StackLayoutpagespageRoot,[data-e2e="chat-page"]') : null;
      const nodes = [...(root?.querySelectorAll('[data-e2e="msg-item-content"]') ?? [])];
      if (nodes.length !== mapping.length || new Set(mapping.map(item => item.domPosition)).size !== nodes.length) throw new Error('消息窗口已经改变。');
      for (const item of mapping) {
        if (!Number.isSafeInteger(item.domPosition) || item.domPosition < 0 || item.domPosition >= nodes.length) throw new Error('消息 DOM 位置不可核对。');
        nodes[item.domPosition].setAttribute('data-deepseek-message-id', item.id);
      }
    }, messages.map((message, index) => ({ id: message.id, domPosition: message.domPosition ?? index })));
  }
  readConversation(recipientId, { allowed = false, signal } = {}) {
    if (allowed !== true) return Promise.reject(new Error('读取正文需要这个指定联系人的明确授权。'));
    return this.controller.withPage(async page => {
      try {
        const { contact, flags } = await this.select(page, recipientId, signal);
        if (flags.blocked) return { ...flags, conversation: null, contact: null, messages: [] };
        const raw = await this.stableConversation(page, contact, signal);
        if (raw.displayName !== contact.displayName || raw.avatar !== contact.avatar) throw new Error('读取前会话身份发生变化。');
        const { avatar, ...publicContact } = contact;
        const messages = this.publicMessages(recipientId, raw.messages);
        await this.markMessages(page, messages);
        return { ...flags, conversation: { id: contact.id, displayName: contact.displayName }, contact: publicContact,
          messages, dayEvidence: { observedAt: raw.observedAt, latestEndVerified: raw.latestEndVerified, chronology: raw.chronology, historyStartVerified: raw.historyStartVerified, emptyTodayVerified: raw.emptyTodayVerified } };
      } finally { await this.restorePage(page); }
    }, { signal });
  }
  captureMessage(recipientId, messageId, { allowed = false, signal } = {}) {
    if (allowed !== true) return Promise.reject(new Error('查看画面需要这个指定联系人的明确授权。'));
    if (typeof messageId !== 'string' || !/^msg:[a-f0-9]{64}$/.test(messageId)) return Promise.reject(new TypeError('需要已读取的精确消息 ID。'));
    return this.controller.withPage(async page => {
      try {
      const { contact, flags } = await this.select(page, recipientId, signal);
      if (flags.blocked) return { ...flags, frames: [], imageStatus: '登录或验证画面未采集。' };
      const raw = await this.stableConversation(page, contact, signal);
      const messages = this.publicMessages(recipientId, raw.messages);
      const message = messages.find(item => item.id === messageId);
      if (!message?.media || message.unsupported) throw new Error('该消息没有已识别的表情或分享作品画面。');
      await this.markMessages(page, messages);
      const frame = page.locator(`[data-e2e="im-dialog"] [data-deepseek-message-id="${messageId}"]`).locator('.MessageItemEmojiemojiBox,.MessageItemShareAwemecontainer');
      if (await frame.count() !== 1) throw new Error('没有唯一的指定消息画面。');
      const current = await page.evaluate(readChatIdentityDom);
      const protectedScreen = await page.evaluate(readChatBlockers);
      if (protectedScreen.loginRequired || protectedScreen.verificationRequired) return { ...protectedScreen, frames: [], imageStatus: '登录或验证画面未采集。' };
      if (current.displayName !== contact.displayName || current.avatar !== contact.avatar) throw new Error('截取画面前会话身份发生变化。');
      stop(signal);
      const rectangle=await frame.boundingBox();
      const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
      if(!rectangle) throw new Error('指定消息画面目前不可见，未采集。');
      const clip={x:Math.max(0,rectangle.x),y:Math.max(0,rectangle.y),width:Math.min(viewport.width,rectangle.x+rectangle.width)-Math.max(0,rectangle.x),height:Math.min(viewport.height,rectangle.y+rectangle.height)-Math.max(0,rectangle.y)};
      if(clip.width<2||clip.height<2) throw new Error('指定消息不在当前视口内，未采集其他区域。');
      const unobstructed=await frame.evaluate(element=>{const r=element.getBoundingClientRect(),x=Math.max(1,Math.min(innerWidth-1,r.x+r.width/2)),y=Math.max(1,Math.min(innerHeight-1,r.y+r.height/2));return element.contains(document.elementFromPoint(x,y));});
      if(!unobstructed) throw new Error('指定消息被其他界面遮挡，未采集。');
      // 倒转的虚拟列表不能依赖 locator 的自动滚动稳定等待；只截取当前消息的可见矩形。
      const data = await page.screenshot({ type:'jpeg',quality:70,clip,timeout:5000 });
      const afterRectangle=await frame.boundingBox();
      if(!afterRectangle||['x','y','width','height'].some(key=>Math.abs(afterRectangle[key]-rectangle[key])>1)) throw new Error('截图期间指定消息位置改变，画面已丢弃。');
      const afterIdentity=await page.evaluate(readChatIdentityDom);
      const afterProtection=await page.evaluate(readChatBlockers);
      if(afterProtection.loginRequired||afterProtection.verificationRequired) return {...afterProtection,frames:[],imageStatus:'截图期间出现登录或验证，本次画面已丢弃。'};
      if(afterIdentity.displayName!==contact.displayName || afterIdentity.avatar!==contact.avatar) throw new Error('截图期间会话身份发生变化，画面已丢弃。');
      const afterRaw=await this.stableConversation(page,contact,signal);
      const afterMessages=this.publicMessages(recipientId,afterRaw.messages);
      const afterMessage=afterMessages.find(item=>item.id===messageId);
      const mediaIdentity=value=>JSON.stringify([value?.sender,value?.kind,value?.text,value?.media?.type,value?.media?.resources,value?.media?.label,value?.media?.title,value?.media?.videoId]);
      if(!afterMessage || mediaIdentity(afterMessage)!==mediaIdentity(message)) throw new Error('截图期间指定消息发生变化，画面已丢弃。');
      return { ...flags, conversation: { id: recipientId, displayName: contact.displayName }, messageId,
        media: message.media, understandingScope: message.media.understandingScope,
        frames: [{ mimeType: 'image/jpeg', data: data.toString('base64') }], imageStatus: '已采集指定消息的实际画面，尚需支持图像的模型读取。' };
      } finally { await this.restorePage(page); }
    }, { signal });
  }
  openSharedVideo(recipientId, messageId, { allowed = false, signal } = {}) {
    if (allowed !== true) return Promise.reject(new Error('打开分享作品需要这个指定联系人的明确授权。'));
    if (typeof messageId !== 'string' || !/^msg:[a-f0-9]{64}$/.test(messageId)) return Promise.reject(new TypeError('需要已读取的精确消息 ID。'));
    return this.controller.withPage(async page => {
      try {
      const { contact, flags } = await this.select(page, recipientId, signal);
      if (flags.blocked) return { ...flags, opened: false };
      const raw = await this.stableConversation(page, contact, signal);
      const messages = this.publicMessages(recipientId, raw.messages);
      const message = messages.find(item => item.id === messageId);
      if (message?.media?.type !== 'shared-work') throw new Error('该消息不是已识别的分享作品卡片。');
      if (message.media.url) return { ...flags, opened: false, videoId: message.media.videoId, url: message.media.url, source: 'dom-link' };
      await this.markMessages(page, messages);
      const card = page.locator(`[data-e2e="im-dialog"] ${message.media.safeOpenSelector}`);
      if (await card.count() !== 1) throw new Error('没有唯一的指定分享卡片。');
      const beforeUrl = new URL(page.url());
      const beforeId = /^\/video\/(\d+)\/?$/.exec(beforeUrl.pathname)?.[1] || beforeUrl.searchParams.get('modal_id') || null;
      const pop = page.waitForEvent('popup', { timeout: 2500 }).catch(() => null);
      stop(signal);
      const parentSource = this.controller.source?.startsWith('dsh') ? 'dsh' : 'api';
      const decision = this.controller.limits().beforeAction(parentSource, 'douyin_open_video');
      if (!decision.allowed) throw new Error(decision.reason || '当前时间不允许打开分享作品。');
      let popup, target = page;
      try {
        await card.click();
        popup = await pop;
        target = popup ?? page;
        if (popup) await popup.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        await target.waitForFunction(({ beforeId, newPopup }) => {
          const observed = new URL(location.href);
          const id = /^\/video\/(\d+)\/?$/.exec(observed.pathname)?.[1] || observed.searchParams.get('modal_id');
          return /^\d+$/.test(id || '') && (newPopup || id !== beforeId);
        }, { beforeId, newPopup: Boolean(popup) }, { timeout: 5000 }).catch(() => {});
        const observed = new URL(target.url());
        const id = /^\/video\/(\d+)\/?$/.exec(observed.pathname)?.[1] || observed.searchParams.get('modal_id');
        if (observed.protocol !== 'https:' || !/^(?:www\.)?douyin\.com$/.test(observed.hostname) || !/^\d+$/.test(id || '')) return { ...flags, opened: true, videoId: null, url: null, reason: '实际打开页面没有可核实的公开作品 ID。' };
        if (!popup && id === beforeId) return { ...flags, opened: true, videoId: null, url: null, reason: '点击后没有核实新的作品页面，未采用原详情页的作品 ID。' };
        return { ...flags, opened: true, videoId: id, url: `https://www.douyin.com/video/${id}`, source: 'actual-opened-page-url', isPhotoGallery: message.media.isPhotoGallery };
      } finally {
        if (!popup) { popup = await pop; if (popup) target = popup; }
        // 2026-10-25 主人实测：手动点卡片，详情/浮层里的视频是**自动播放**的。
        // 这里原来会把它按暂停，导致后面三次采样都是 t=4.03 同一帧。现在不再动播放状态。
        if (popup) await popup.close().catch(() => {});
      }
      } finally { await this.restorePage(page); }
    }, { signal });
  }
  sendMessage(recipientId, message, { allowed = false, expectedMessageIds, expectedMessageContent, signal: parentSignal, authorize, followUp = false, knownDraft = '' } = {}) {
    if (allowed !== true) return Promise.reject(new Error('发送需要这个指定联系人的明确授权。'));
    if (typeof message !== 'string' || !message.trim() || [...message].length > 1000) return Promise.reject(new TypeError('发送内容须为 1 到 1000 字的非空文字。'));
    if (authorize !== undefined && (typeof authorize !== 'function' || typeof authorize.beginDispatch !== 'function')) return Promise.reject(new TypeError('主动问候需要本机许可检查和最终短输入控制。'));
    const interrupt = new AbortController(), signal = AbortSignal.any([interrupt.signal, ...(parentSignal ? [parentSignal] : [])]);
    const authorized = async phase => { stop(signal); if (authorize && await authorize({ phase, recipientId }) !== true) throw new Error('主动问候许可已撤回，未继续发送。'); stop(signal); };
    return this.controller.withPage(async page => {
      await authorized('prepare');
      const { contact, flags } = await this.select(page, recipientId, signal);
      if (flags.blocked) return { ...flags, confirmed: false, deliveryUncertain: false };
      const before = await page.evaluate(readConversationDom);
      const initialMessages = this.publicMessages(recipientId, before.messages);
      const expected = expectedMessageIds ?? initialMessages.map(item => item.id);
      const contentOf = messages => messages.map(item => ({ id: item.id, fingerprint: messageFingerprint(item) }));
      const expectedContent = expectedMessageContent ?? contentOf(initialMessages);
      // 2026-10-24 21:35：以前这里要求「整窗消息 id + 指纹」与调用方读到的完全一致。实测抖音消息行没有稳定原生 id，
      // 同一句「回我」重复十几条时窗口重叠无法唯一对齐，每次读都会重新分配 id → 永远「水位已变化」、一条都发不出去。
      // 现在只守住真正重要的三条：会话身份对、没有方向不明的消息、对方最后一条还是新消息（可选）。
      const tailOf = messages => messages.slice(-8);
      const tailSignature = messages => JSON.stringify(tailOf(messages).map(item => [item.direction, messageFingerprint(item)]));
      if (!Array.isArray(expected) || !Array.isArray(expectedContent) || initialMessages.some(item => item.direction === 'unknown')) return { confirmed: false, deliveryUncertain: false, reason: '私信会话状态不明，未填写或发送回复。' };
      const replyWithState = Array.isArray(expectedMessageIds) || Array.isArray(expectedMessageContent);
      if (replyWithState && !followUp && initialMessages.length && initialMessages.at(-1).direction !== 'incoming') return { confirmed: false, deliveryUncertain: false, reason: '对方最后一条不是新消息，未发送。' };
      const baselineTail = tailSignature(initialMessages);
      const outgoingBefore = initialMessages.filter(item => item.direction === 'outgoing').length;
      const receipt = { conversation: { id: contact.id, displayName: contact.displayName }, contact: { id: contact.id, name: contact.displayName } };
      const editor = page.locator('[data-e2e="im-dialog"] [data-e2e="msg-input"] [contenteditable="true"]');
      if (await editor.count() !== 1) throw new Error('没有唯一的私信文字输入框。');
      if (await editor.locator('img,video,audio,[data-slate-void="true"]').count()) throw new Error('当前会话已有图片或语音草稿，已停止发送以保留原内容。');
      const staleDraft = readableDraft(await editor.innerText());
      // 中止过一次的上一次回复会以草稿留在输入框里。
      // 2026-11-07：以前靠文本开头是不是「[自动回复]」来认自己的草稿；主人要求正文不带任何标记后，
      // 改成让调用方把自己上一次填进去的原文传进来比对，只有对得上才敢覆盖，别人的草稿照样保留。
      // 直接改 textContent 清不掉 Slate 的内部状态，fill 会变成"再追加一份"，所以用真键盘全选删除再复核。
      if (staleDraft && readableDraft(knownDraft || '') !== staleDraft) throw new Error('当前会话已有别人的草稿，已停止发送以保留原内容。');
      if (staleDraft) {
        await editor.click({ timeout: 3000 }).catch(() => {});
        await page.keyboard.press('Control+A').catch(() => {});
        await page.keyboard.press('Backspace').catch(() => {});
        await page.waitForTimeout(150);
        const left = readableDraft(await editor.innerText());
        if (left) throw new Error(`旧草稿没能清掉（还剩 ${left.length} 字），未发送。`);
      }
      let clicked = false, monitoring = false, monitor, polling, releaseDispatch;
      const witnessId = `chat-${hash(`${recipientId}:${Date.now()}:${Math.random()}`)}`;
      try {
        await editor.fill(message);
        stop(signal);
        const ready = await page.evaluate(readConversationDom);
        const draftNow = readableDraft(await editor.innerText());
        // 2026-10-24 21:45：失败信息带上具体差在哪一步，免得又只能看到一句"不一致"。
        if (ready.displayName !== contact.displayName) throw new Error(`发送前会话标题不一致（读到「${ready.displayName || '空'}」，应为「${contact.displayName}」）。`);
        if (draftNow !== readableDraft(message)) throw new Error(`发送前输入文字回读不一致（读到 ${draftNow.length} 字，应为 ${readableDraft(message).length} 字：${JSON.stringify(draftNow.slice(0, 40))}）。`);
        const readyMessages = this.publicMessages(recipientId, ready.messages);
        // 只比对"有没有人插话"和方向；不再比对整窗 id（会随虚拟列表重排而变）。
        if (readyMessages.some(item => item.direction === 'unknown')) throw new Error('填写回复期间出现方向不明的消息，未点击发送。');
        if (replyWithState && tailSignature(readyMessages) !== baselineTail && readyMessages.length > initialMessages.length && readyMessages.at(-1)?.direction !== 'incoming') throw new Error('填写回复期间会话被切换，未点击发送。');
        const escaped = contact.displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const targetPage = page.locator('.StackLayoutpagespageRoot,[data-e2e="chat-page"]').filter({ has: page.locator('.StackLayoutStackChatHeadertitle,[data-e2e="chat-title"]').filter({ hasText: new RegExp(`^${escaped}$`) }) });
        const send = targetPage.locator('.e2e-send-msg-btn,[data-e2e="send-msg-btn"]');
        if (await send.count() !== 1) throw new Error('没有唯一的指定会话发送按钮。');
        await send.evaluate((button, token) => {
          const entries = window.__deepseekChatInputs ??= Object.create(null), entry = { dispatched: false };
          const witness = event => { if (event.isTrusted && (event.target === button || button.contains(event.target))) entry.dispatched = true; };
          document.addEventListener('click', witness, true);
          entry.cleanup = () => document.removeEventListener('click', witness, true); entries[token] = entry;
        }, witnessId);
        const inputDispatched = () => page.evaluate(token => window.__deepseekChatInputs?.[token]?.dispatched === true, witnessId);
        const checkPendingInput = async () => {
          if (clicked && await inputDispatched()) return;
          await authorized('monitor');
          if (await editor.count() !== 1 || await send.count() !== 1 || readableDraft(await editor.innerText()) !== readableDraft(message)) throw new Error('等待期间发送按钮或草稿发生变化，未发送。');
          const current = await page.evaluate(readConversationDom), blockers = await page.evaluate(readChatBlockers);
          if (blockers.loginRequired || blockers.verificationRequired || current.displayName !== contact.displayName || current.avatar !== contact.avatar) throw new Error('等待期间会话身份或页面许可发生变化，未发送。');
          const messages = this.publicMessages(recipientId, current.messages);
          if (messages.some(item => item.direction === 'unknown')) throw new Error('等待期间出现方向不明的消息，未发送。');
          stop(signal);
        };
        monitoring = true;
        monitor = setInterval(() => { if (polling || !monitoring) return; polling = checkPendingInput().catch(async error => { if (monitoring && !await inputDispatched().catch(() => false)) interrupt.abort(error); }).finally(() => { polling = null; }); }, 40);
        await checkPendingInput();
        await send.click({ trial: true, timeout: 3000 });
        stop(signal); await checkPendingInput(); await authorized('before-click');
        if (await inputDispatched()) throw new Error('等待期间已发生发送输入，未再点击一次。');
        if (authorize) { releaseDispatch = await authorize.beginDispatch(); if (typeof releaseDispatch !== 'function') throw new Error('最终输入控制没有返回可释放的许可。'); }
        stop(signal); clicked = true;
        await send.click({ timeout: 350, noWaitAfter: true });
        releaseDispatch?.(); releaseDispatch = null;
        if (!await inputDispatched()) throw new Error('没有核对到真实发送输入，结果需要核对。');
        monitoring = false; clearInterval(monitor); stop(signal);
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const after = await page.evaluate(readConversationDom);
          if (after.displayName !== contact.displayName || after.avatar !== contact.avatar) return { ...receipt, confirmed: false, deliveryUncertain: true, reason: '发送后会话发生变化，未再次发送。' };
          const messages = this.identities.identify(recipientId, after.messages);
          const outgoing = messages.filter(item => item.direction === 'outgoing');
          const last = messages.at(-1);
          // 回读不看旧 id 集合（虚拟列表会重排）：最后一行为我方、正文一致、我方条数比发送前多一条，就算发成功。
          const sent = last && last.direction === 'outgoing' && last.text === message.trim() && outgoing.length > outgoingBefore ? last : null;
          if (sent && !sent.failed && !sent.pending) return { ...receipt, confirmed: true, messageId: sent.id, deliveryUncertain: false };
          if (sent?.failed) return { ...receipt, confirmed: false, deliveryUncertain: true, reason: '网页显示发送失败，未自动重试。' };
          stop(signal);
          await page.waitForTimeout(250);
        }
        return { ...receipt, confirmed: false, deliveryUncertain: true, reason: '未取得新发出消息的界面回读，未自动重试。' };
      } catch (error) {
        if (!clicked) await editor.evaluate((element,own)=>{
          // 只清除本次写入的完整回复；用户已改动的草稿保留。
          const readable=value=>value.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g,'').trim();
          if(readable(element.innerText)===readable(own)) {
            element.textContent='';
            element.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));
          }
        },message).catch(()=>{});
        // 2026-10-24：原来把真实原因吞成一句「检查未通过」，日志里查不出到底卡在哪一步。
        const detail = String(error?.message || error || '').replace(/\s+/g, ' ').slice(0, 120);
        return { ...receipt, confirmed: false, deliveryUncertain: clicked, reason: clicked ? '发送动作已尝试但结果不确定，未自动重试。' : `发送前检查未通过（${detail || '原因不详'}），未点击发送。` };
      } finally {
        monitoring = false; clearInterval(monitor); releaseDispatch?.();
        await page.evaluate(token => { const entry = window.__deepseekChatInputs?.[token]; entry?.cleanup(); if (window.__deepseekChatInputs) delete window.__deepseekChatInputs[token]; }, witnessId).catch(() => {});
        await this.restorePage(page);
      }
    }, { signal });
  }
  async close() { if (!this.sharedController) await this.controller.close(); }
}
