import { TOOL_DEFINITIONS, validateToolArguments } from './tool-definitions.mjs?v=10';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntimePaths } from './runtime-paths.mjs';
import { createNativeWatchDecision } from './native-watch-decision.mjs';
import { createNativeSparkGreeting } from './native-spark-greeting.mjs?v=10';
import { bindNativePersonaContext } from './native-persona-context.mjs';
import { createNativeSettingsRoute } from './native-settings.mjs?v=10';
import { readRelay, relayState, saveRelay, clearRelay } from './relay-settings.mjs';
import { NativeModelSettings } from './native-model-settings.mjs?v=10';
import { randomUUID } from 'node:crypto';

export const name = 'douyin-browser';
export const inject = ['tools'];

let replySettings = null;

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// 原生 ToolRuntime 接收领域 JSON 值，再由 output.render 生成模型上下文。
// 图片必须保存成 DSH attachment ref；MCP 的 base64 图片块不能直接用于这里。
export const NATIVE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tool: { type: 'string' },
    result: { type: 'object', additionalProperties: true },
    images: { type: 'array', items: { type: 'object', additionalProperties: true } },
    imageStatus: { type: 'string' },
  },
  required: ['tool', 'result', 'images', 'imageStatus'],
};

function optionalService(ctx, service) {
  try { return ctx?.get?.(service); } catch { return undefined; }
}

function decodeFrames(frames) {
  return frames.map((frame) => {
    if (!frame || !IMAGE_MIME_TYPES.has(frame.mimeType) || typeof frame.data !== 'string' || frame.data.length === 0 || !CANONICAL_BASE64.test(frame.data)) throw new Error('画面不是支持的图片格式或有效 base64。');
    const data = Buffer.from(frame.data, 'base64');
    if (data.toString('base64') !== frame.data) throw new Error('画面数据不是规范 base64。');
    return { data, mediaType: frame.mimeType };
  });
}

async function projectFrames(ctx, exec, frames) {
  if (frames.length === 0) return { images: [], imageStatus: '本次操作没有采集画面。' };
  try {
    const decoded = decodeFrames(frames);
    const attachments = optionalService(ctx, 'attachments');
    const llm = optionalService(ctx, 'llm');
    if (typeof attachments?.saveImages !== 'function') throw new Error('当前 DSH 未挂载图片附件存储。');
    const route = exec.agent?.session?.requestHeader?.()?.config;
    const provider = route?.provider ?? exec.agent?.options?.provider;
    const model = route?.model ?? exec.agent?.options?.model;
    if (!provider || !model || typeof llm?.resolveModelInfo !== 'function') throw new Error('无法核实当前 DSH 模型的图像输入能力。');
    let info;
    try { info = await llm.resolveModelInfo(provider, model, exec.signal); }
    catch { throw new Error('无法核实当前 DSH 模型的图像输入能力。'); }
    if (!info?.inputModalities?.includes('image')) throw new Error(`当前模型 ${model} 未声明支持图像输入。`);
    exec.signal?.throwIfAborted();
    let images;
    try { images = await attachments.saveImages(decoded); }
    catch { throw new Error('DSH 图片附件存储未接收本次画面。'); }
    if (!Array.isArray(images) || images.length !== frames.length || images.some((ref) => !ref?.attachmentId)) throw new Error('DSH 图片附件存储返回了不完整的引用。');
    return { images, imageStatus: `已向模型提供 ${images.length} 张画面。` };
  } catch (error) {
    if (exec.signal?.aborted) throw error;
    return { images: [], imageStatus: `画面未送入模型：${error instanceof Error ? error.message : String(error)} 仍可读取播放状态和可见文字。` };
  }
}

function frameAdmission(result, frames) {
  const state = result.state ?? result;
  const protectedScreen = result.loginRequired === true || result.verificationRequired === true
    || state.loginRequired === true || state.verificationRequired === true;
  if (protectedScreen || frames.some((frame) => frame?.sensitive === true)) {
    return { frames: [], imageStatus: '登录或验证画面未送入模型，请在专用浏览器窗口完成操作。' };
  }
  return { frames };
}

function renderNativeValue(_args, value) {
  const content = [{ type: 'text', text: JSON.stringify({ tool: value.tool, ...value.result, imageStatus: value.imageStatus }, null, 2) }];
  for (const attachment of value.images) content.push({ type: 'image', attachment });
  return content;
}

function nativeParameters(schema) {
  // 当前 DSH 的 schema 子集不接收长度或数值边界；执行时仍由统一验证器检查。
  return {
    ...schema,
    properties: Object.fromEntries(Object.entries(schema.properties).map(([key, field]) => {
      const { minLength, maxLength, minimum, maximum, ...supported } = field;
      return [key, supported];
    })),
  };
}

export function createNativeToolDefinitions({ ctx, getController, getWatch, getSpark, attachPersona }) {
  return TOOL_DEFINITIONS.map((definition) => ({
    ...definition,
    parameters: nativeParameters(definition.parameters),
    timeoutMs: 90000,
    output: { schema: NATIVE_OUTPUT_SCHEMA, render: renderNativeValue },
    async execute(args, exec = {}) {
      validateToolArguments(definition, args);
      exec.signal?.throwIfAborted();
      attachPersona?.(exec.agent);
      const controller = await getController();
      let result;
      if (getSpark && definition.name.startsWith('douyin_spark_')) {
        const spark = await getSpark(exec, definition.name === 'douyin_spark_start');
        if (definition.name === 'douyin_spark_start') result = await spark.start({ schedule: true, explicit: true });
        else if (definition.name === 'douyin_spark_stop') result = await spark.stop({ explicit: true });
        else result = spark.state();
      } else if (getWatch && definition.name.startsWith('douyin_watch_')) {
        const watch=await getWatch(exec,definition.name==='douyin_watch_start');
        if(definition.name==='douyin_watch_start') result=await watch.start({startSession:false},{explicit:true});
        else if(definition.name==='douyin_watch_stop') result=await watch.stop({explicit:true});
        else result=watch.state();
      } else result = await controller.execute(definition.name, args, { signal: exec.signal });
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('浏览器控制器未返回 JSON 对象。');
      if (result.ok === false) throw new Error(typeof result.error === 'string' ? result.error : result.error?.message ?? '抖音工具执行失败。');
      const { frames = [], ...state } = result;
      if (!Array.isArray(frames)) throw new Error('浏览器控制器返回的 frames 不是数组。');
      const admitted = frameAdmission(result, frames);
      const projected = admitted.imageStatus
        ? { images: [], imageStatus: admitted.imageStatus }
        : await projectFrames(ctx, exec, admitted.frames);
      // 持久日志与对话只保留画面概要和 attachment ref，避免把 base64 写进文本。
      const publicResult = JSON.parse(JSON.stringify({ ...state, ...(admitted.frames.length ? { frames: admitted.frames.map((frame) => ({ mimeType: frame?.mimeType ?? 'unknown', time:frame.time,videoId:frame.videoId, bytes: typeof frame?.data === 'string' ? Buffer.byteLength(frame.data, 'base64') : 0 })) } : {}) }));
      return { tool: definition.name, result: publicResult, ...projected };
    },
  }));
}

// 原生命令由人类界面直接分派，不进入模型或视频工具执行链。
export function createNativeLaunchCommand({ getController, lifetimeSignal } = {}) {
  return {
    name: 'douyin-open',
    description: '打开抖音专用窗口，不开始或延长刷视频轮次',
    recordInput: false,
    async handler({ rawInput, attachments, signal }) {
      if (rawInput.trim() || attachments.length) return { kind: 'error', text: '/douyin-open 不接收参数或附件。' };
      const signals = [signal, lifetimeSignal].filter(Boolean);
      const currentSignal = signals.length ? AbortSignal.any(signals) : undefined;
      currentSignal?.throwIfAborted();
      const controller = await getController();
      currentSignal?.throwIfAborted();
      const result = await controller.openBrowser({ signal: currentSignal });
      currentSignal?.throwIfAborted();
      if (result?.opened !== true) return { kind: 'error', text: '未确认抖音专用窗口已打开，请稍后重试。' };
      return { kind: 'success', text: typeof result.message === 'string' && result.message.length <= 1000 ? result.message : '已打开抖音专用窗口，未开始或延长刷视频轮次。' };
    },
  };
}

export async function apply(ctx, config = {}) {
  let controllerPromise;
  let watchPromise;
  let disposed = false;
  const modelSettings = new NativeModelSettings({ getLlm: () => optionalService(ctx, 'llm') });
  const settingsSessionId = `douyin-settings:${randomUUID()}`;
  const settingsExec = (starting = false) => {
    const route = modelSettings.state();
    if (starting && !route.configured) throw Object.assign(new Error('请先在刷抖音设置页选择 DSH 提供商和模型。'), { status: 400 });
    return { agent: { options: { provider: route.provider, model: route.model }, session: { id: settingsSessionId } } };
  };
  const getController = () => {
    if (disposed) throw new Error('抖音插件已卸载。');
    // 加载插件时只注册工具，首次调用时才创建控制器、启动浏览器。
    controllerPromise ??= import('./core.mjs?v=10')
      .then(({ BrowserController }) => new BrowserController({ ...config, source: 'dsh', personaMemory: sharedPersona }))
      .catch((error) => { controllerPromise = undefined; throw error; });
    return controllerPromise;
  };
  const {PersonaMemory}=await import('./persona-memory.mjs?v=10');
  // 2026-10-24：可选的中转站（state/relay.json）。有就走中转，没有就走 DSH 原生模型。
  // 只影响这个插件自己的模型调用；主对话仍用 DSH 的登录，不受影响。
  const readRelayConfig = readRelay;
  const sharedPersona=new PersonaMemory();
  const personaBinding=bindNativePersonaContext(ctx,{workspacePaths:[path.dirname(resolveRuntimePaths().memoryDir),path.dirname(fileURLToPath(import.meta.url))],getPersonaMemory:()=>{
    // 提示词读取不触发浏览器或模型，按每次生成时的文件内容刷新。
    return sharedPersona;
  }});
  const getWatch=async(exec,starting)=>{
    if (!watchPromise) watchPromise=Promise.all([getController(),import('./autonomous-watch.mjs?v=13')]).then(async ([controller,{AutonomousWatch}])=>{
      if(starting) sharedPersona.initialize({importLegacy:false});
      const route=exec.agent?.session?.requestHeader?.()?.config ?? exec.agent?.options ?? {};
      const relay=readRelayConfig();
      return new AutonomousWatch({controller,videoLimits:controller.limits(),personaMemory:sharedPersona,commentService:await controller.getComments(),reportService:await controller.getReport(),source:'dsh',config:relay?{apiKey:relay.apiKey,baseUrl:relay.baseUrl,model:relay.model}:{apiKey:'',baseUrl:'https://api.deepseek.com',model:route.model||'deepseek-flash'},...(starting&&!relay?{decisionProvider:createNativeWatchDecision({llm:optionalService(ctx,'llm'),attachments:optionalService(ctx,'attachments'),agent:exec.agent})}:{})});
    }).catch(error=>{watchPromise=undefined;throw error;});
    const watch=await watchPromise;
    if(starting) {
      if(watch.state().worker?.alive) throw new Error('已有自主观看在运行，请先停止。');
      if(!readRelayConfig()) watch.decisionProvider=createNativeWatchDecision({llm:optionalService(ctx,'llm'),attachments:optionalService(ctx,'attachments'),agent:exec.agent});
      sharedPersona.initialize({importLegacy:false});
    }
    return watch;
  };
  const getSpark = async (exec, starting) => {
    const spark = await (await getController()).getSparkService();
    if (starting && !spark.running && !spark.starting && !spark.busy) spark.setGreetingProvider(createNativeSparkGreeting({ llm: optionalService(ctx, 'llm'), agent: exec.agent }));
    return spark;
  };
  const definitions = createNativeToolDefinitions({ ctx, getController, getWatch, getSpark, attachPersona:personaBinding.attach });
  const disposers = [];
  const launchLifetime = new AbortController();
  let commandFiber, settingsFiber, cleanupPromise;
  const teardown = () => cleanupPromise ??= (async () => {
    disposed = true;
    launchLifetime.abort(new Error('抖音打开命令已卸载。'));
    await commandFiber?.dispose();
    await settingsFiber?.dispose();
    personaBinding.close();
    const sharedState=watchPromise?await watchPromise.then(watch=>watch.state()).catch(()=>null):null;
    if(watchPromise) await watchPromise.then(watch=>watch.close()).catch(()=>{});
    for (const dispose of disposers.reverse()) dispose?.();
    if (controllerPromise) await controllerPromise.then((controller) => {if(sharedState?.worker?.alive&&!sharedState.owned&&sharedState.worker.source==='dsh')controller.limitsEnabled=false;return controller.close?.();}).catch(() => {});
  })();
  try {
    for (const tool of definitions) disposers.push(ctx.tools.register(tool));
    // 2026-10-30 主人定：回复只在有限视频轮次里查，轮次外的通知等下一轮补。
    // 这里每 10 分钟兜一次底（暂停/长按不阻塞），轮次不在时直接跳过。
    try {
      const replyTicker = setInterval(async () => {
        try {
          if (!watchPromise) return;
          const watch = await watchPromise.catch(() => null);
          if (!watch) return;
          const service = watch.getReplyService?.();
          if (!service || !service.state()?.allowed) return;
          const handled = await service.checkApi({ max: 1 });
          if (handled?.replied?.length) {
            watch.onEvent?.({ type: 'watch.replies', message: `回了 ${handled.replied.length} 条评论回复。`, result: handled.replied });
          }
        } catch { /* 页面没开/网络问题就等下一次 */ }
      }, 10 * 60 * 1000);
      replyTicker.unref?.();
      disposers.push(() => clearInterval(replyTicker));
    } catch { /* 定时器起不来不影响主功能 */ }
    // 2026-11-07 主人定：DSH 一启动就把私信自动回复拉起来，不用每次去设置页点「启用私信自动回复」。
    // 只在「上次是主人自己开着」的时候自动开：策略文件里的 autoStart 为真（启动成功置真、手动停止置假，
    // 进程退出不改），所以主人手动停过就真的停着，不会被开机自启偷偷打开。
    // 刚启动时浏览器还没拉起、推荐流也可能没就绪，所以先等 25 秒，失败按 1/2/3/5 分钟再试。
    const autoStartTimers = [];
    const startChatOnBoot = async (attempt) => {
      if (disposed) return;
      try {
        if (!modelSettings.state().configured) return;
        const controller = await getController();
        const chat = await controller.getChatService();
        const snapshot = chat.state();
        if (snapshot.running || snapshot.starting) return;
        // 只有「明确记着主人手动停过」（autoStart === false）才不自动开；
        // 老版本策略文件里没有这个字段，按「想开」处理，免得升级后第一次重启又得手点。
        if (snapshot.policy?.autoStart === false) return;
        if (!(snapshot.policy?.allowlist || []).length) return;
        chat.setReplyProvider(createNativeWatchDecision({ llm: optionalService(ctx, 'llm'), attachments: optionalService(ctx, 'attachments'), agent: settingsExec(false).agent, maxTokens: 512 }));
        await chat.start({ schedule: true });
      } catch {
        const next = [60_000, 120_000, 180_000, 300_000][attempt];
        if (next && !disposed) { const timer = setTimeout(() => { void startChatOnBoot(attempt + 1); }, next); timer.unref?.(); autoStartTimers.push(timer); }
      }
    };
    {
      const timer = setTimeout(() => { void startChatOnBoot(0); }, 25_000);
      timer.unref?.();
      autoStartTimers.push(timer);
      disposers.push(() => { for (const pending of autoStartTimers) clearTimeout(pending); });
    }
    // 2026-11-07 主人定：主动问候也开机自启。等私信那边先起来（45 秒），失败按 1.5/3/5/10 分钟重试。
    // 有三类情况直接放弃这一轮：主人手动停过（autoStart === false）、许可开关没开、
    // 还有问候发送结果等人工核对（这时重试也发不出去，得主人先点核对）。
    const startSparkOnBoot = async (attempt) => {
      if (disposed) return;
      try {
        if (!modelSettings.state().configured) return;
        const controller = await getController();
        const spark = await controller.getSparkService();
        const snapshot = spark.state();
        if (snapshot.running || snapshot.starting) return;
        if (snapshot.policy?.autoStart === false) return;
        if (snapshot.policy?.enabled !== true) return;
        if (snapshot.paused) return;
        if (!(snapshot.recipients || []).length) return;
        spark.setGreetingProvider(createNativeSparkGreeting({ llm: optionalService(ctx, 'llm'), agent: settingsExec(false).agent }));
        await spark.start({ schedule: true, explicit: true });
      } catch {
        const next = [90_000, 180_000, 300_000, 600_000][attempt];
        if (next && !disposed) { const timer = setTimeout(() => { void startSparkOnBoot(attempt + 1); }, next); timer.unref?.(); autoStartTimers.push(timer); }
      }
    };
    {
      const timer = setTimeout(() => { void startSparkOnBoot(0); }, 45_000);
      timer.unref?.();
      autoStartTimers.push(timer);
    }
    if (typeof ctx.inject === 'function') {
      // commands 只作为子作用域依赖；缺少该服务时仍注册完整视频工具目录。
      commandFiber = ctx.inject(['commands'], commandCtx => {
        const dependencyLifetime = new AbortController();
        commandCtx.effect(() => () => dependencyLifetime.abort(new Error('原生命令服务已卸载。')));
        commandCtx.commands.register(createNativeLaunchCommand({ getController, lifetimeSignal: AbortSignal.any([launchLifetime.signal, dependencyLifetime.signal]) }));
      });
      if (optionalService(ctx, 'commands')) await commandFiber.await();
      settingsFiber = ctx.inject(['webServer'], settingsCtx => {
        settingsCtx.effect(() => settingsCtx.webServer.register(createNativeSettingsRoute({
          getController, modelSettings,
          relay: { state: relayState, save: saveRelay, clear: clearRelay },
          getComments: async () => (await getController()).getComments(),
          getReplies: async () => {
            const controller = await getController();
            if (!replySettings) {
              const { AutonomousReplies } = await import('./autonomous-replies.mjs');
              replySettings = new AutonomousReplies({ videoLimits: controller.limits(), stateDir: controller.limits().stateDir, source: 'dsh' });
            }
            return replySettings;
          },
          getReport: async () => (await getController()).getReport(),
          getSpark: async () => (await getController()).getSparkService(),
          getShare: async () => (await getWatch(settingsExec(), false)).getShareService(),
          getChat: async () => (await getController()).getChatService(),
          getMedia: async () => (await getController()).getMediaAdapter(),
          getWatch: async () => getWatch(settingsExec(), false),
          getMode: async () => (await getController()).getWatchMode(),
          configureMode: async input => {
            const controller = await getController(), mode = await controller.getWatchMode();
            const saved = mode.configure(input, { explicit: true });
            const application = await controller.applyWatchMode({ minimize: saved.silent });
            return { ...saved, application };
          },
          startWatch: async input => {
            const watch = await getWatch(settingsExec(true), true);
            const result = watch.start({ ...input, startSession: false }, { explicit: true });
            (await getController()).applyWatchMode({ minimize: true }).catch(() => {});
            // 2026-10-24 主人定：刷视频时白名单私信自动回，不用再单独点「启用私信自动回复」。
            // 页面刚打开时会话列表偶尔先渲染 uid（读不到昵称），第一次起不来就隔 6 秒再试一次。
            try {
              const chat = await (await getController()).getChatService();
              if (!chat.state().running && (chat.state().policy?.allowlist || []).length) {
                chat.setReplyProvider(createNativeWatchDecision({ llm: optionalService(ctx, 'llm'), attachments: optionalService(ctx, 'attachments'), agent: settingsExec(true).agent, maxTokens: 512 }));
                try { await chat.start({ schedule: true }); }
                catch (first) {
                  await new Promise(resolve => setTimeout(resolve, 6_000));
                  await chat.start({ schedule: true }).catch(() => {});
                }
              }
            } catch { /* 私信起不来不影响看视频 */ }
            // 2026-11-07 主人定：刷视频结束（到点或手动停）之后不再顺手停私信。
            // 旧实现在这里挂了每 15 秒一次的看门狗，一旦自主观看停下就 chat.stop()，
            // 于是「看完视频私信就哑了」，主人还得回设置页重新点一次启用。现在自动回复
            // 会一直跑到手动停止（或出错自愈失败）为止。
            return result;
          },
          startSpark: async () => (await getSpark(settingsExec(true), true)).start({ schedule: true, explicit: true }),
          startChat: async () => {
            const chat = await (await getController()).getChatService();
            chat.setReplyProvider(createNativeWatchDecision({ llm: optionalService(ctx, 'llm'), attachments: optionalService(ctx, 'attachments'), agent: settingsExec(true).agent, maxTokens: 512 }));
            return chat.start();
          },
        })));
      });
      if (optionalService(ctx, 'webServer')) await settingsFiber.await();
    } else {
      const commands = optionalService(ctx, 'commands');
      if (commands) disposers.push(commands.register(createNativeLaunchCommand({ getController, lifetimeSignal: launchLifetime.signal })));
    }
    ctx.effect?.(() => teardown);
  } catch (error) { await teardown(); throw error; }
}

export default { name, inject, apply };
