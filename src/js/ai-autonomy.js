import { t } from './i18n.js';

// A session deliberately lives only in this renderer and this project.
// Only completed turns reschedule, so a slow provider never overlaps itself.
export function createAutonomy({run, cancel, render, generation, clock = globalThis}) {
  let timer, session = 0, idle = 0;
  const state = {enabled:false,busy:false,status:'',nextAt:0};
  const later = (wait, token) => {
    if (!state.enabled || token !== session) return;
    clock.clearTimeout(timer);
    state.nextAt = Date.now() + wait;
    timer = clock.setTimeout(() => tick(token),wait);
    render();
  };
  let project;
  async function tick(token) {
    if (token !== session || !state.enabled) return;
    if (project !== generation()) { stop(); return; }
    state.nextAt = 0;
    state.busy = true;
    state.status = t('ИИ работает на холсте','AI is working on the canvas');
    render();
    let result;
    try { result = await run(() => token === session && state.enabled && project === generation()); }
    catch (error) { result = {error:String(error?.message || error)}; }
    if (token !== session || !state.enabled) return;
    if (project !== generation()) { stop(); return; }
    state.busy = false;
    idle = result?.changed ? 0 : Math.min(4,idle + 1);
    state.status = result?.error || (result?.changed ? t('Правка сохранена в проекте','Change applied to the project')
      : t('Пока нет новых правок','No new edits yet'));
    later(result?.retry ? 10000 : 30000 * (2 ** idle),token);
  }
  function start() {
    if (state.enabled) return;
    session++; project = generation(); idle = 0;
    Object.assign(state,{enabled:true,busy:false,status:t('Запуск мастерской','Starting workshop')});
    later(0,session);
  }
  function stop() {
    if (!state.enabled) return;
    session++; clock.clearTimeout(timer); cancel();
    Object.assign(state,{enabled:false,busy:false,nextAt:0,status:t('Автономный режим остановлен','Autonomous mode stopped')});
    render();
  }
  function manualTurn() {
    if (!state.enabled) return;
    // Retire the timer/in-flight result. Manual work always has priority.
    session++; cancel(); idle = 0;
    Object.assign(state,{busy:false,status:t('Приоритет у вашего запроса','Your request has priority')});
    later(30000,session);
  }
  return {state,start,stop,manualTurn};
}
