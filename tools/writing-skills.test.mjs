import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { setLanguage } from '../src/js/i18n.js';
import { writingSkillPrompt, writingSkillsSettingsHTML, wireWritingSkillSources } from '../src/js/writing-skills.js';

test('three built-in skills are localized, read-only and linked to pinned MIT sources', async () => {
  try {
    const notice = await fs.readFile(new URL('../src/notices/writing-skills-MIT.txt',import.meta.url),'utf8');
    assert.match(notice,/Permission is hereby granted/);
    for (const [lang, names] of [
      ['ru',['Речь и подтекст','Последовательность сцен','Редактура сценария']],
      ['en',['Dialogue and subtext','Scene sequencing','Story revision']],
    ]) {
      setLanguage(lang);
      const prompt=writingSkillPrompt(), html=writingSkillsSettingsHTML();
      for (const name of names) { assert.ok(prompt.includes(name)); assert.ok(html.includes(name)); }
      assert.match(html,/<details/);
      assert.doesNotMatch(html,/<input|<textarea|<select|contenteditable|<script/);
      const urls=Array.from(html.matchAll(/href="(https:[^"]+)"/g), m=>m[1]);
      assert.equal(new Set(urls).size,3);
      assert.ok(urls.every(u=>/github\.com\/jwynia\/agent-skills\/blob\/[0-9a-f]{40}\//.test(u) && notice.includes(u)));
      assert.ok(prompt.length>500 && prompt.length<3500);
      let linkHandler, opened;
      const link={href:urls[0],addEventListener:(_,handler)=>{linkHandler=handler;}};
      wireWritingSkillSources({querySelectorAll:()=>[link]});
      globalThis.window={sf:{app:{openExternal:url=>{opened=url;}}}};
      linkHandler({preventDefault(){}});
      assert.equal(opened,urls[0]);
    }
  } finally { setLanguage('ru'); }
});
