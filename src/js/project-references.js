// A project can be renamed or moved without changing the links saved with it.
const encodePart = value => encodeURIComponent(value).replace(/[!'()*]/g,
  char => '%' + char.charCodeAt(0).toString(16).toUpperCase());

export function makeProjectReference(project, ref) {
  if (!project?.meta?.createdAt || !ref) return '';
  const path = ref.kind === 'gigma' ? [ref.workspaceId, ref.pageId, ref.objectId]
    : ref.kind === 'node' ? [ref.id] : ref.kind === 'screenplay' ? [] : null;
  if (!path || path.some(id => typeof id !== 'string' || !id || id === '.' || id === '..')) return '';
  const query = new URLSearchParams({project: project.meta.createdAt});
  if (ref.kind === 'screenplay' && ref.end > ref.start) {
    if (!Number.isSafeInteger(ref.start) || !Number.isSafeInteger(ref.end) || ref.start < 0
      || ref.end > (project.screenplay || '').length) return '';
    query.set('start', ref.start);
    query.set('end', ref.end);
  }
  return 'storyforge://' + [ref.kind, ...path.map(encodePart)].join('/') + '?' + query;
}

export function parseProjectReference(value, project) {
  if (typeof value !== 'string' || value.length > 8192 || !value.startsWith('storyforge://')) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.port || url.hash || !project?.meta?.createdAt
      || url.searchParams.get('project') !== project.meta.createdAt) return null;
    const path = url.pathname ? url.pathname.slice(1).split('/').map(decodeURIComponent) : [];
    if (path.some(id => !id)) return null;
    if (url.host === 'gigma' && path.length === 3) {
      const [workspaceId, pageId, objectId] = path;
      return {kind: 'gigma', workspaceId, pageId, objectId};
    }
    if (url.host === 'node' && path.length === 1) return {kind: 'node', id: path[0]};
    if (url.host === 'screenplay' && !path.length) {
      if (!url.searchParams.has('start') && !url.searchParams.has('end')) return {kind: 'screenplay'};
      const start = url.searchParams.get('start'), end = url.searchParams.get('end');
      if (!/^\d+$/.test(start || '') || !/^\d+$/.test(end || '') || +start >= +end
        || +end > (project.screenplay || '').length) return null;
      return {kind: 'screenplay', start: +start, end: +end};
    }
  } catch { /* Invalid URL or percent-encoded identifier. */ }
  return null;
}
