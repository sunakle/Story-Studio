// Generated, in-memory data for development tests. Nothing here is packaged.
import { createEmptyProject, migrateProject } from '../src/js/model.js';

const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j00sAAAAASUVORK5CYII=';
function option(id, text, next) { return { id, text, next }; }

export function makeStoryFixture() {
  const ids = ['qa_start', 'qa_choice', 'qa_side', 'qa_shared', 'qa_test', 'qa_true', 'qa_false', 'qa_scene', 'qa_late', 'qa_other', 'qa_end', 'qa_note'];
  const types = ['line', 'choice', 'line', 'line', 'condition', 'line', 'line', 'scene', 'choice', 'line', 'end', 'note'];
  const nodes = ids.map((id, i) => ({
    id, type: types[i], title: 'Узел ' + (i + 1), text: 'Проверка поля ' + (i + 1),
    next: ids[i + 1] || '', chapterId: 'qa_chapter',
    locationId: i === 3 ? 'qa_room2' : 'qa_room1',
    speakerId: i % 2 ? 'qa_reader' : 'qa_author',
    position: {x: (i % 4) * 310, y: Math.floor(i / 4) * 210},
  }));
  nodes[1].choices = [option('a', 'Первый путь', ids[2]), option('b', 'Второй путь', ids[3]), option('c', 'Третий путь', ids[3])];
  nodes[1].next = '';
  nodes[2].next = ids[4];
  nodes[4].branches = [{id:'branch', condition:'count >= 1', next:ids[6]}];
  nodes[7].media = ['pixel'];
  nodes[7].previewId = 'pixel';
  nodes[8].choices = [option('d','Открыть строку',ids[9]), option('e','Закончить',ids[10])];
  nodes[8].next = '';
  nodes[10].next = '';
  return migrateProject(createEmptyProject({
    meta:{title:'Проверка редактора'}, startNodeId:ids[0], nodes,
    characters:[{id:'qa_author',name:'Автор', voice:{preset:1,params:{pitch:120}}},
      {id:'qa_reader',name:'Диктор',voice:{preset:2,params:{pitch:180}}}],
    locations:[{id:'qa_room1',name:'Зал №1'}, {id:'qa_room2',name:'Зал №2'}],
    variables:[{id:'qa_count',name:'count',type:'number',initial:1}],
    chapters:[{id:'qa_chapter',name:'Тестовая глава'}],
    media:{pixel:{id:'pixel',name:'pixel.png',mime:'image/png',w:1,h:1,size:68,data:pixel}},
  })).project;
}

export function makeStressFixture() {
  const count = 201;
  const characters = Array.from({length:8}, (_,i) => ({id:'qa_speaker_' + i,name:'Голос ' + i}));
  const chapters = Array.from({length:5}, (_,i) => ({id:'qa_ch_' + i,name:'Группа ' + i}));
  const locations = Array.from({length:4}, (_,i) => ({id:'qa_loc_' + i,name:'Зона ' + i}));
  const nodes = Array.from({length:count}, (_,i) => {
    const next = i + 1 < count ? 'qa_' + (i + 1) : '';
    const n = {id:'qa_' + i, type:next ? 'line' : 'end', text:'Строка ' + i, title:'Проверка ' + i,
      next, speakerId:characters[i % 3 === 0 ? 0 : 1 + (i % 7)].id,
      chapterId:chapters[Math.min(4, Math.floor(i / 40))].id, locationId:locations[i % 4].id,
      position:{x: (i % 12) * 290, y:Math.floor(i / 12) * 170}};
    if (i % 12 === 3 && i < 173) {
      n.type = 'choice';
      n.choices = [1,2,3].map(offset => option('op_' + i + '_' + offset, 'Путь ' + offset, 'qa_' + (i + offset)));
      n.next = '';
    }
    return n;
  });
  return migrateProject(createEmptyProject({meta:{title:'Нагрузочная проверка'}, startNodeId:nodes[0].id,
    chapters,characters,locations,nodes})).project;
}
