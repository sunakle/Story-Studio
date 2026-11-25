import { t as uiText } from './i18n.js';
/** Bind workspace navigation to the same views and selections as the editor. */
export function initWorkspaceShell(store, ui) {
  const byId = id => document.getElementById(id);
  const workbench = ui.workbench;
  const left = byId('leftPanel');
  const right = byId('rightPanel');
  const tabs = byId('documentTabs');
  const commands = byId('shellCommands');
  const sections = byId('projectSections');
  const overview = byId('vizRoot');

  let projectTitle;
  function paintLocation() {
    const location = workbench.currentLocation();
    const history = workbench.historyState();
    const inOverview = ui.visualizer?.isOpen() === true;
    const overlay = inOverview && location.kind !== 'overview';
    projectTitle = store.project.meta?.title || '';
    byId('viewParent').textContent = inOverview ? projectTitle : location.chapter || projectTitle;
    byId('viewName').textContent = inOverview ? uiText("Обзор сюжета", "Story overview") : location.title;
    byId('shellBack').disabled = !overlay && !history.back;
    byId('shellForward').disabled = overlay || !history.forward;
    const current = inOverview ? 'btnViz' : { graph: 'ribbonGraph', table: 'ribbonTable', overview: 'btnViz' }[location.kind];
    for (const id of ['btnViz', 'ribbonGraph', 'ribbonTable']) {
      if (id === current) byId(id).setAttribute('aria-current', 'page');
      else byId(id).removeAttribute('aria-current');
    }
  }

  function paintPanels() {
    byId('btnToggleLeft').setAttribute('aria-expanded', String(!left.classList.contains('collapsed')));
    byId('btnToggleRight').setAttribute('aria-expanded', String(!right.classList.contains('collapsed')));
    const active = byId('rightTabs').querySelector('.tab.active');
    byId('rightPaneLabel').textContent = active?.getAttribute('aria-label') || uiText("Инспектор", "Inspector");
  }

  byId('ribbonJump').onclick = () => workbench.quickJump();
  byId('ribbonGraph').onclick = () => workbench.openGraph();
  byId('ribbonTable').onclick = () => workbench.openTable();
  byId('ribbonDaily').onclick = () => workbench.daily();
  byId('ribbonPlay').onclick = () => {
    const selection = store.selection;
    workbench.openPlayer(selection?.kind === 'node' ? selection.id : undefined);
  };
  byId('ribbonFile').onclick = event => {
    event.stopPropagation();
    if (left.classList.contains('collapsed')) byId('btnToggleLeft').click();
    byId('btnFile').click();
    byId('menuFile').querySelector('button')?.focus();
  };
  byId('closeInspector').onclick = () => {
    if (!right.classList.contains('collapsed')) byId('btnToggleRight').click();
    byId('btnToggleRight').focus();
  };

  byId('shellBack').onclick = () => {
    if (ui.visualizer?.isOpen() && workbench.current() !== 'overview') ui.visualizer.close();
    else workbench.back();
  };
  byId('shellForward').onclick = () => workbench.forward();
  tabs.addEventListener('workspace:navigate', paintLocation);
  new MutationObserver(paintLocation).observe(overview, { attributes: true, attributeFilter: ['class'] });
  store.subscribe(() => {
    if (projectTitle !== store.project.meta?.title) paintLocation();
  });

  const panelChanges = new MutationObserver(paintPanels);
  for (const panel of [left, right]) panelChanges.observe(panel, { attributes: true, attributeFilter: ['class'] });
  panelChanges.observe(byId('rightTabs'), { subtree: true, attributes: true, attributeFilter: ['aria-selected'] });

  document.addEventListener('click', event => {
    if (commands.open && (!commands.contains(event.target) || event.target.closest('button'))) {
      const focusWasInside = commands.contains(document.activeElement);
      commands.open = false;
      if (focusWasInside) commands.querySelector('summary').focus();
    }
    if (!sections.contains(event.target)) sections.open = false;
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const detail = [commands, sections].find(element => element.open);
    if (detail) {
      detail.open = false;
      detail.querySelector('summary').focus();
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    for (const [menuId, triggerId] of [['menuFile', 'btnFile'], ['menuExport', 'btnExport']]) {
      const menu = byId(menuId);
      if (menu.classList.contains('hidden')) continue;
      menu.classList.add('hidden');
      byId(triggerId).focus();
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
  }, true);

  for (const [buttonId, menuId] of [['btnFile', 'menuFile'], ['btnExport', 'menuExport']]) {
    const menu = byId(menuId);
    const trigger = byId(buttonId);
    const expanded = () => trigger.setAttribute('aria-expanded', String(!menu.classList.contains('hidden')));
    new MutationObserver(expanded).observe(menu, { attributes: true, attributeFilter: ['class'] });
    expanded();
  }
  paintLocation();
  paintPanels();
  return () => { paintLocation(); paintPanels(); };
}

