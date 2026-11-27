// The draft is local to the renderer profile. Text edits never rewrite the photos.
export function createComposerDrafts(onError) {
  let connection, pending = Promise.resolve(), reported = false;
  function database() {
    if (!connection) connection = new Promise((resolve, reject) => {
      const request = indexedDB.open('storyforge-composer', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('drafts');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch(error => { connection = null; throw error; });
    return connection;
  }
  function write(key, text, localAttachments, photos) {
    if (!globalThis.indexedDB || !key) return;
    const images = photos?.slice();
    pending = pending.then(async () => {
      const db = await database();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('drafts', 'readwrite'), rows = tx.objectStore('drafts');
        if (text || localAttachments) rows.put({text, localAttachments}, key);
        else rows.delete(key);
        if (images) {
          if (images.length) rows.put(images, key + '/images');
          else rows.delete(key + '/images');
        }
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
      });
    }).catch(() => { if (!reported) onError(); reported = true; });
  }
  async function read(key) {
    if (!globalThis.indexedDB || !key) return null;
    await pending;
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('drafts'), rows = tx.objectStore('drafts');
      const info = rows.get(key), pictures = rows.get(key + '/images');
      tx.oncomplete = () => resolve({...info.result, images:pictures.result || []});
      tx.onabort = () => reject(tx.error);
    });
  }
  return {read, write, flush:() => pending};
}
