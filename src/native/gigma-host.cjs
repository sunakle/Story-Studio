'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const editorRoot = path.resolve(__dirname, '../gigma');
const assets = new Map([
  ['/index.html', 'text/html; charset=utf-8'],
  ['/editor.js', 'text/javascript; charset=utf-8'],
  ['/editor.css', 'text/css; charset=utf-8'],
  ['/story-studio.css', 'text/css; charset=utf-8'],
  ['/theme-palette.css', 'text/css; charset=utf-8'],
  ['/gigma.svg', 'image/svg+xml'],
]);

// Serve only packaged artwork-editor assets. Documents travel over the per-frame
// message channel and never enter the URL namespace.
async function editorAsset(request) {
  const url = new URL(request.url);
  const type = assets.get(url.pathname);
  if (request.method !== 'GET' || url.host !== 'studio' || !type) return new Response(null, {status:404});
  const root = url.pathname === '/theme-palette.css' ? path.dirname(editorRoot) : editorRoot;
  try {
    const bytes = await fs.readFile(path.join(root, url.pathname.slice(1)));
    return new Response(bytes, {headers:{'Content-Type':type, 'X-Content-Type-Options':'nosniff'}});
  } catch { return new Response(null, {status:404}); }
}

function registerGigma(protocol, ipcMain, dialog, getWindow) {
  protocol.handle('sf-gigma', editorAsset);
  function owner(event) {
    const win = getWindow();
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
      throw Error('Эта команда доступна только из окна StoryForge.');
    }
    return win;
  }
  ipcMain.handle('sf:gigma:openIllustrator', async event => {
    const win = owner(event);
    const pick = await dialog.showOpenDialog(win, {
      title: 'Открыть документ Illustrator', properties:['openFile'],
      filters:[{name:'Adobe Illustrator', extensions:['ai']}],
    });
    if (pick.canceled || !pick.filePaths.length) return null;
    return require('./gigma/illustrator.cjs').openIllustratorFile(pick.filePaths[0]);
  });
  ipcMain.handle('sf:gigma:exportIllustrator', (event, job) => {
    owner(event);
    return require('./gigma/illustrator.cjs').convertIllustrator(job);
  });
}
module.exports = {registerGigma};
