// DOM recorder and snap/content heuristics adapted from Benji Taylor's Stageshow:
// https://github.com/benjitaylor/skills/blob/802057409787133703c56001080169e347305572/stageshow/scripts/jumps-core.mjs
// MIT, Copyright (c) 2026 Benji Taylor. See LICENSE.stageshow.
// Changes: ordinary light-DOM roots (including root), viewport CSS pixels,
// explicit windows, structured findings, coverage, event/content/lifecycle data,
// separate screenshot runs. Removed demonstration-specific exclusions, camera,
// sibling-gap and ss-* anchor assumptions. No dependencies or browser launch.
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const positive = (n, name) => { if (!Number.isFinite(n) || n <= 0) throw new TypeError(`${name} must be an explicit positive number`); };
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const median = (xs) => [...xs].sort((a,b) => a-b)[Math.floor(xs.length / 2)] ?? null;
const limitations = [
  '只检查指定根及其 light DOM；不进入 iframe、shadow DOM，不读取 canvas、视频像素或伪元素。',
  '几何为视口 CSS 像素；旋转、裁剪、遮挡、颜色、字形与主观运动观感需结合图像和实际操作。',
  '采集会读取布局与样式并可能扰动页面；轨迹与截图应分别运行，真实时间与受控运行证据分别解释。',
  '无启发式发现只表示本次采样未发现对应模式，不表示动画或用户流程通过。',
];

/** Uses an already-open Playwright Page. Install BEFORE the real event trigger.
 * durationMs is the observation window, not an animation timeout or product rule.
 * mode is an evidence label; this API does not alter browser clocks or animations.
 */
export async function captureMotion(page, { root, durationMs, trigger, label = '', mode = 'realtime' }) {
  positive(durationMs, 'durationMs');
  if (typeof root !== 'string' || !root) throw new TypeError('root must be a CSS selector');
  if (typeof trigger !== 'function') throw new TypeError('trigger must be a function');
  if (!['realtime', 'controlled'].includes(mode)) throw new TypeError('mode must be realtime or controlled');
  const key = `__motion_${randomUUID().replaceAll('-', '')}`;
  await page.evaluate(({key, root, durationMs, label, mode}) => {
    // Fail invalid CSS selectors before installing timers/listeners.
    document.querySelectorAll(root);
    const ids = new WeakMap(); let nextId = 0; let raf; let timer;
    const t0 = performance.now();
    const state = { schema: 1, root, label, mode, durationMs, startedAt: new Date().toISOString(),
      modeEffect: 'label-only: recorder does not control clocks or animation playback',
      timeOrigin: performance.timeOrigin, startPerformanceMs: t0,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      media: { reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches },
      frames: [], events: [], errors: [], done: false };
    let resolveFinished;
    state.finished = new Promise(resolve => { resolveFinished = resolve; });
    window[key] = state;
    const id = (el) => { if (!ids.has(el)) ids.set(el, nextId++); return ids.get(el); };
    const sample = (kind, rafTimestamp = null) => {
      const before = performance.now(); const matches = document.querySelectorAll(root);
      const items = [];
      if (matches.length === 1) {
        for (const el of [matches[0], ...matches[0].querySelectorAll('*')]) {
          const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
          let alpha = 1; let hidden = cs.visibility !== 'visible';
          for (let p = el; p; p = p.parentElement) {
            const style = getComputedStyle(p); alpha *= Number(style.opacity);
            if (style.display === 'none') hidden = true;
          }
          const visible = !hidden && alpha > 0 && el.getClientRects().length > 0;
          const name = `${el.tagName.toLowerCase()}${el.id ? '#'+el.id : ''}${el.getAttribute('class') ? '.'+el.getAttribute('class').trim().replace(/\s+/g,'.') : ''}`;
          const words = [...el.childNodes].filter(c => c.nodeType === 3).map(c => c.textContent).join('');
          const content = JSON.stringify({ text: words, svg: el.tagName.toLowerCase() === 'svg' ? el.innerHTML : '',
            value: 'value' in el ? el.value : null, checked: 'checked' in el ? el.checked : null });
          // Compatible first nine columns with upstream jumps-core.mjs.
          items.push([id(el), name, r.x, r.y, r.width, r.height,
            el.parentElement ? id(el.parentElement) : -1,
            el.nextElementSibling ? id(el.nextElementSibling) : -1, content,
            {visible, opacity: alpha, display: cs.display, visibility: cs.visibility}]);
        }
      }
      state.frames.push({ t: before - t0, kind, rafTimestamp, rootMatches: matches.length,
        rootId: matches.length === 1 ? id(matches[0]) : null, items,
        documentVisibility: document.visibilityState, sampleCostMs: performance.now() - before });
    };
    const event = (e) => state.events.push({ t: performance.now()-t0, type: e.type,
      target: e.target instanceof Element ? id(e.target) : null, trusted: e.isTrusted });
    const types = ['pointerdown','pointerup','click','keydown','keyup','input','change','transitionrun','transitionend','transitioncancel','animationstart','animationend','animationcancel','visibilitychange'];
    types.forEach(type => document.addEventListener(type, event, true));
    const stop = () => {
      if (state.done) return;
      cancelAnimationFrame(raf); clearTimeout(timer);
      try { sample('final'); } catch (e) { state.errors.push(String(e)); }
      state.endedMs = performance.now()-t0; state.done = true;
      types.forEach(type => document.removeEventListener(type, event, true));
      resolveFinished();
    };
    state.stop = stop;
    const tick = (timestamp) => {
      if (state.done) return;
      try { sample('raf', timestamp); } catch (e) { state.errors.push(String(e)); stop(); return; }
      if (performance.now()-t0 >= durationMs) stop(); else raf = requestAnimationFrame(tick);
    };
    sample('initial');
    raf = requestAnimationFrame(tick); timer = setTimeout(stop, durationMs);
  }, { key, root, durationMs, label, mode });
  let triggerError = null;
  try {
    await page.evaluate(key => { window[key].triggerStartedMs = performance.now()-window[key].startPerformanceMs; }, key);
    await trigger(page);
  } catch (e) { triggerError = String(e); }
  try {
    await page.evaluate(key => { window[key].triggerEndedMs = performance.now()-window[key].startPerformanceMs; }, key);
    // Browser timer owns the window; no hidden fixed timeout or frame cap.
    const trace = await page.evaluate(async key => {
      const s = window[key];
      if (!s) throw new Error('Recorder context was lost (navigation or document replacement)');
      await s.finished;
      const { stop, finished, ...data } = s; delete window[key]; return data;
    }, key);
    if (triggerError) trace.errors.push(`trigger: ${triggerError}`);
    trace.limitations = limitations;
    return { ...trace, ...analyseMotion(trace) };
  } catch (error) {
    // Navigation destroys the recorder: return explicit inconclusive evidence.
    await page.evaluate(key => { window[key]?.stop(); delete window[key]; }, key).catch(() => {});
    const trace = { schema: 1, root, label, mode, durationMs, frames: [], events: [],
      errors: [triggerError, String(error)].filter(Boolean), limitations };
    return { ...trace, ...analyseMotion(trace) };
  }
}

export function analyseMotion(trace) {
  const frames = trace.frames ?? [];
  const raf = frames.filter(f => f.kind === 'raf');
  const gaps = raf.slice(1).map((f,i) => ({ fromMs: raf[i].t, toMs: f.t, dtMs: f.t-raf[i].t }));
  const cadence = median(gaps.map(g => g.dtMs));
  // Diagnostic coverage heuristics inherited from Stageshow, not product budgets.
  const longGaps = gaps.filter(g => g.dtMs > cadence * 1.6);
  const reasons = [];
  if (trace.errors?.length) reasons.push('recorder-or-trigger-error');
  if (raf.length < 4) reasons.push('fewer-than-four-raf-samples');
  if (cadence > 40) reasons.push('median-raf-interval-over-40ms');
  if (longGaps.length) reasons.push('raf-gap-over-1.6x-median');
  if (frames.some(f => f.rootMatches !== 1) || !frames.length) reasons.push('missing-or-ambiguous-root');
  if (new Set(frames.map(f=>f.rootId).filter(id=>id!==null)).size>1) reasons.push('root-replaced');
  if (!frames.some(f => f.items.some(i => i[9]?.visible))) reasons.push('no-visible-target');
  if (frames.some(f => f.documentVisibility !== 'visible')) reasons.push('document-not-visible');
  if (!frames.length || !trace.endedMs || trace.endedMs < trace.durationMs || frames.at(-1).t < trace.durationMs) reasons.push('window-not-covered');
  if (trace.triggerEndedMs > trace.durationMs) reasons.push('trigger-outlasted-window');
  // Start/final are manual samples: include their boundary gaps in coverage.
  const boundaryGaps = raf.length ? [raf[0].t, frames.at(-1).t-raf.at(-1).t] : [];
  if (cadence && boundaryGaps.some(dt => dt > cadence*1.6)) reasons.push('window-boundary-gap');
  const at = frames.map(f => new Map(f.items.filter(i => i[9]?.visible).map(i => [i[0],i])));
  const late = f => f > 0 && frames[f].t-frames[f-1].t > (cadence || 16.7)*1.6;
  const jumps = []; const contentChanges = []; const lifecycle = [];
  for (let f=1; f<frames.length; f++) {
    const before = new Map(frames[f-1].items.map(i => [i[0],i]));
    const now = new Map(frames[f].items.map(i => [i[0],i]));
    for (const [id,it] of now) {
      const old = before.get(id);
      if (!old) lifecycle.push({t:frames[f].t,type:'added',id,name:it[1]});
      else {
        if (it[8] !== old[8]) contentChanges.push({t:frames[f].t,id,name:it[1],before:old[8],after:it[8],
          sameBox:it.slice(2,6).every((n,i) => Math.abs(n-old[i+2])<0.5)});
        if (it[9]?.visible !== old[9]?.visible) lifecycle.push({t:frames[f].t,type:'visibility',id,name:it[1],visible:it[9]?.visible});
      }
    }
    for (const [id,it] of before) if (!now.has(id)) lifecycle.push({t:frames[f].t,type:'removed',id,name:it[1]});
  }
  // Upstream snap heuristic: >2px and >3x adjacent changes, with four samples.
  // Report every location; an intentional step is still evidence to inspect.
  for (let f=2; f<frames.length-1; f++) {
    if (late(f-1)||late(f)||late(f+1)) continue;
    for (const [id,it] of at[f]) {
      const a=at[f-2].get(id), b=at[f-1].get(id), c=at[f+1].get(id);
      if (!a||!b||!c) continue;
      for (const [axis,index] of [['x',2],['y',3],['width',4],['height',5]]) {
        const delta=it[index]-b[index];
        const calm=Math.max(Math.abs(b[index]-a[index]),Math.abs(c[index]-it[index]),0.4);
        if (Math.abs(delta)>2 && Math.abs(delta)>3*calm) jumps.push({t:frames[f].t,id,name:it[1],axis,delta});
      }
    }
  }
  return { coverage: { status: reasons.length ? 'inconclusive' : 'sampled', reasons, rafSamples:raf.length,
    medianIntervalMs:cadence, longGaps, boundaryGapsMs:boundaryGaps, observedEndMs:frames.at(-1)?.t ?? null,
    maxSampleCostMs:frames.reduce((max,f)=>Math.max(max,f.sampleCostMs),0),
    thresholds:{minimumRafSamples:4,medianIntervalMs:40,gapMultiplier:1.6},
    scope:'指定 light DOM 的采样覆盖；sampled 也不等于整体通过。' },
    analysis:{jumps,contentChanges,lifecycle, conclusion: jumps.length ? 'geometry-findings' : 'no-geometry-findings',
      note:'突跳与内容变化为待检查位置；文字、绘制变化、连续运动与运行性能需结合时间图组及实际操作判断。'} };
}

const shell = (title, body) => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>body{font:16px/1.55 system-ui;margin:32px;background:#f3f4f6;color:#17212d}h1{font-size:26px}figure{margin:0;background:white;padding:12px;border:1px solid #cbd5e1}img{display:block;width:100%;height:auto}section.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:white;padding:16px}svg{background:white;width:100%;height:auto}small{color:#475569}</style>${body}</html>`;

export async function writeMotionReport(trace, outputDir) {
  await mkdir(outputDir,{recursive:true});
  await writeFile(join(outputDir,'trace.json'),JSON.stringify(trace,null,2));
  const width=1000,height=250,pad=35;
  const series=new Map(); let min=0,max=1;
  for(const frame of trace.frames) for(const item of frame.items) {
    if(!item[9]?.visible) continue;
    min=Math.min(min,item[2]);max=Math.max(max,item[2]);
    if(!series.has(item[0])) series.set(item[0],{name:item[1],samples:[]});
    series.get(item[0]).samples.push({t:frame.t,x:item[2],frame:frame});
  }
  const colors=['#2563eb','#dc2626','#059669','#7c3aed','#b45309'];
  const frameIndex=new Map(trace.frames.map((f,i)=>[f,i]));
  const paths=[...series.values()].map((s,index)=>{let previous=-2;const commands=s.samples.map(p=>{const n=frameIndex.get(p.frame);const command=n===previous+1?'L':'M';previous=n;return `${command}${pad+(width-pad*2)*p.t/trace.durationMs},${height-pad-(height-pad*2)*(p.x-min)/(max-min)}`;});return `<path fill="none" stroke="${colors[index%colors.length]}" stroke-width="1.5" d="${commands.join(' ')}"><title>${escape(s.name)} · x</title></path>`;}).join('');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="各目标视口横坐标随时间变化"><rect width="100%" height="100%" fill="white"/><path d="M${pad} 12V${height-pad}H${width-12}" fill="none" stroke="#64748b"/>${paths}<text x="${pad}" y="${height-8}" font-size="13">0 ms</text><text x="${width-120}" y="${height-8}" font-size="13">${trace.durationMs} ms</text><text x="${pad+5}" y="20" font-size="13">x: ${min.toFixed(1)} — ${max.toFixed(1)} CSS px</text></svg>`;
  await writeFile(join(outputDir,'trajectory.svg'),svg);
  const html=shell(trace.label||'动效轨迹',`<h1>${escape(trace.label||'动效轨迹')}</h1><p>${escape(trace.mode)} · ${escape(trace.root)} · ${trace.durationMs} ms · 覆盖：<strong>${trace.coverage.status}</strong></p><p>${escape(trace.coverage.reasons.join('、')||'已取得本窗口采样；仍需检查运动观感。')}</p>${svg}<h2>几何与内容变化</h2><pre>${escape(JSON.stringify(trace.analysis,null,2))}</pre><h2>覆盖信息</h2><pre>${escape(JSON.stringify(trace.coverage,null,2))}</pre><p>${trace.limitations.map(escape).join('<br>')}</p>`);
  await writeFile(join(outputDir,'report.html'),html);
  return {json:join(outputDir,'trace.json'),html:join(outputDir,'report.html'),image:join(outputDir,'trajectory.svg')};
}

/** Separate replay after caller resets the page. Screenshots perturb timing.
 * Each PNG is independently viewable; HTML embeds the same images for portability.
 * intervalMs is requested cadence; actual screenshot start/end times are retained.
 */
export async function captureFilmstrip(page,{root,durationMs,intervalMs,trigger,outputDir,label='',mode='realtime'}) {
  positive(durationMs,'durationMs'); positive(intervalMs,'intervalMs');
  if (typeof root!=='string'||!root) throw new TypeError('root must be a CSS selector');
  if (typeof trigger!=='function') throw new TypeError('trigger must be a function');
  if (!['realtime','controlled'].includes(mode)) throw new TypeError('mode must be realtime or controlled');
  await mkdir(outputDir,{recursive:true});
  const result={schema:1,root,label,mode,durationMs,intervalMs,images:[],errors:[],limitations,
    modeEffect:'label-only: recorder does not control clocks or animation playback',
    note:'截图为独立重放，不能与另一条轨迹当成同一次运行；图片采集不是实时性能证据。'};
  const key=`__motion_images_${randomUUID().replaceAll('-','')}`;
  await page.evaluate(({key,root})=>{document.querySelectorAll(root);window[key]={origin:performance.now(),ids:new WeakMap(),nextId:0};},{key,root});
  const stamp=()=>page.evaluate(({key,root})=>{
    const state=window[key];if(!state) throw new Error('Screenshot recorder context lost');
    const matches=document.querySelectorAll(root);let rootId=null;
    if(matches.length===1){if(!state.ids.has(matches[0]))state.ids.set(matches[0],state.nextId++);rootId=state.ids.get(matches[0]);}
    return {t:performance.now()-state.origin,rootMatches:matches.length,rootId};
  },{key,root});
  const shot=async(requestedMs)=>{const before=await stamp(); const buffer=await page.screenshot({type:'png',animations:'allow'}); const after=await stamp();
    const name=`frame-${String(result.images.length).padStart(4,'0')}.png`; await writeFile(join(outputDir,name),buffer);
    result.images.push({file:name,requestedMs,startMs:before.t,endMs:after.t,rootMatches:before.rootMatches,
      rootMatchesAfter:after.rootMatches,rootId:before.rootId,rootIdAfter:after.rootId});
    return buffer.toString('base64');};
  const embedded=[];
  const targets=[];
  for(let t=0;t<durationMs;t+=intervalMs) targets.push(t);
  targets.push(durationMs);
  let action;
  try {
    // Baseline screenshot completes before the first event.
    embedded.push(await shot(null));
    result.triggerStartedMs=(await stamp()).t;
    action=Promise.resolve().then(()=>trigger(page)).catch(e=>{result.errors.push(`trigger: ${e}`);}).then(async()=>{
      try {result.triggerEndedMs=(await stamp()).t;}catch(e){result.errors.push(String(e));}
    });
    for (const requested of targets) {
      const due=result.triggerStartedMs+requested; const now=(await stamp()).t;
      if(now<due) await new Promise(resolve=>setTimeout(resolve,due-now));
      embedded.push(await shot(requested));
      if((await stamp()).t-result.triggerStartedMs>=durationMs) break;
    }
  } catch(e) { result.errors.push(String(e)); }
  await action;
  try {result.endedMs=(await stamp()).t;} catch(e) {result.errors.push(String(e));}
  await page.evaluate(key=>{delete window[key];},key).catch(()=>{});
  const actualIntervals=result.images.slice(2).map((x,i)=>x.startMs-result.images[i+1].startMs);
  const missed=targets.filter(t=>!result.images.some(i=>i.requestedMs===t));
  const reasons=[];
  if(result.errors.length) reasons.push('recorder-or-trigger-error');
  if(!result.images.length||result.images.some(i=>i.rootMatches!==1||i.rootMatchesAfter!==1)) reasons.push('missing-or-ambiguous-root');
  if(new Set(result.images.flatMap(i=>[i.rootId,i.rootIdAfter]).filter(id=>id!==null)).size>1) reasons.push('root-replaced');
  if(missed.length) reasons.push('requested-images-missing');
  if(actualIntervals.some(dt=>dt>intervalMs*1.6)) reasons.push('image-gap-over-1.6x-requested-interval');
  const lateness=result.images.filter(i=>i.requestedMs!==null).map(i=>i.startMs-result.triggerStartedMs-i.requestedMs);
  if(lateness.some(dt=>dt>intervalMs*0.6)) reasons.push('image-start-late-over-0.6x-requested-interval');
  if(result.triggerEndedMs-result.triggerStartedMs>durationMs) reasons.push('trigger-outlasted-window');
  if(!result.images.some(i=>i.requestedMs!==null&&i.endMs-result.triggerStartedMs>=durationMs)) reasons.push('window-end-not-observed');
  result.coverage={status:reasons.length?'inconclusive':'sampled',evidence:'images-only',reasons,
    requestedOffsetsMs:targets,
    capturedOffsetsMs:result.images.slice(1).map(i=>i.startMs-result.triggerStartedMs),
    skippedRequestedOffsetsMs:missed,
    actualIntervalsMs:actualIntervals,startLatenessMs:lateness,
    maxScreenshotDurationMs:result.images.reduce((max,i)=>Math.max(max,i.endMs-i.startMs),0),
    thresholds:{gapMultiplier:1.6,latenessIntervalMultiplier:0.6},
    scope:'仅检查图片请求的采样节奏，阈值是工具观测规则，不是产品性能预算；图片之间始终有未观察区间。',
    gapsAreUnobserved:true};
  await writeFile(join(outputDir,'filmstrip.json'),JSON.stringify(result,null,2));
  const html=shell(label||'动效时间图组',`<h1>${escape(label||'动效时间图组')}</h1><p>${escape(mode)} · 请求间隔 ${intervalMs} ms · ${escape(result.coverage.status)}</p><p>${escape(result.note)} 图片之间的状态未被图像覆盖；开始/结束时间包含截图与通信开销。</p><section class="grid">${result.images.map((i,n)=>`<figure><figcaption>${i.requestedMs===null?'触发前':`请求 +${i.requestedMs} ms`} · 实际 ${i.startMs.toFixed(1)}—${i.endMs.toFixed(1)} ms${i.requestedMs===null?'':` · 相对触发 +${(i.startMs-result.triggerStartedMs).toFixed(1)} ms`}</figcaption><img alt="第 ${n} 张，采集于 ${i.startMs.toFixed(1)} 毫秒" src="data:image/png;base64,${embedded[n]}"></figure>`).join('')}</section><h2>采集信息</h2><pre>${escape(JSON.stringify(result.coverage,null,2))}</pre>`);
  await writeFile(join(outputDir,'filmstrip.html'),html);
  return result;
}
