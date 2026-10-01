/** Read-only narrative inventory. Run from server: node --import tsx scripts/export-story-illustration-census.ts */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from '../../web/node_modules/typescript/lib/typescript.js';
import { openingRoutes, openingLessonText } from '../src/game/opening-content';
import { openingHubs, openingStartRouteCodes } from '../src/game/opening-world.config';
import { forestArrivalTownScenes, forestArrivalGuildScenes } from '../src/game/forest-arrival-content';
import { lamplightPrivate, lamplightLegacy, lamplightLocal, lamplightJoin, lamplightWorld } from '../src/game/lamplight-content.generated';
import { hiddenProfessions } from '../src/game/hidden-profession.config';
import { hiddenQuestStory, hiddenMentorVoices } from '../src/game/hidden-quest.story';
import { worldTreeAdvancedProfessions, mapHiddenAdvancedProfessions } from '../src/game/advanced-profession.config';
import { mapHiddenAdvancedQuests } from '../src/game/map-hidden-advanced-quest.config';
import { mentorDialogues } from '../src/game/advanced-profession.dialogue';
import { floatingTourScenes, floatingRescueTexts, floatingThanksScenes } from '../src/game/floating-leaf-content';
import { aevierTour, aevierChallenge, aesonVictory } from '../src/game/worldtree-witness-content';
import { heartCards } from '../src/game/heart-question-content';
import { lamplightPeople } from '../src/game/lamplight-people';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.dirname(serverRoot);
type Scene = { sceneKey:string; title:string; text:string; npcs:string[]; source:string; group:string; status:'new-player'|'supported-existing-save'|'active'|'retired'; aliases?:string[] };
type Group = { storyGroupKey:string; title:string; recommendedSceneKey:string; sceneKeys:string[]; displaySceneKeys:string[]; npcs:string[]; source:string; status:Scene['status']; notes?:string };
const scenes: Scene[] = [];
const groups: Group[] = [];
const isCurrentStory = (group: Pick<Group, 'status'>) => group.status === 'active' || group.status === 'new-player';
const names = [...Object.keys(lamplightPeople), '梨子喵','梨子','阿克谢尔·梨子','莱昂','伊芙','希娅','菲萝缇','烬川','艾薇儿','艾森','晴儿','漠北','唯薇安','洛文·赫斯特','雷恩','岑渡','温槐','斐珞','木芽','朵菈','砾秋','瑟芙菈'];
const npcNames = (text:string, extras:string[] = []) => [...new Set([...extras,...names.filter(n=>text.includes(n))].filter(Boolean))];
const add = (sceneKey:string,title:string,text:string,source:string,group:string,extras:string[]=[],status:Scene['status']='active',aliases?:string[]) => {
  scenes.push({sceneKey,title,text,npcs:npcNames(text,extras),source,group,status,...(aliases?.length?{aliases}:{})});
  return sceneKey;
};
const addGroup = (storyGroupKey:string,title:string,source:string,recommendedSceneKey?:string,displaySceneKeys?:string[],notes?:string) => {
  const entries=scenes.filter(s=>s.group===storyGroupKey);
  if(!entries.length)return;
  groups.push({storyGroupKey,title,recommendedSceneKey:recommendedSceneKey??entries[0]!.sceneKey,sceneKeys:entries.flatMap(s=>[s.sceneKey,...s.aliases??[]]),displaySceneKeys:displaySceneKeys??[recommendedSceneKey??entries[0]!.sceneKey],npcs:[...new Set(entries.flatMap(s=>s.npcs))],source,status:entries[0]!.status,...(notes?{notes}:{})});
};
const sourceFile = (file:string) => ts.createSourceFile(file,fs.readFileSync(path.join(serverRoot,'src/game',file),'utf8'),ts.ScriptTarget.Latest,true);
const staticValue = (node:ts.Node|undefined):any => {
  if(!node)return undefined;
  if(ts.isParenthesizedExpression(node)||ts.isAsExpression(node)||ts.isSatisfiesExpression(node))return staticValue(node.expression);
  if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node))return node.text;
  if(ts.isNumericLiteral(node))return Number(node.text);
  if(ts.isArrayLiteralExpression(node))return node.elements.map(staticValue);
  if(ts.isObjectLiteralExpression(node))return Object.fromEntries(node.properties.filter(ts.isPropertyAssignment).map(p=>[p.name.getText().replace(/^['"]|['"]$/g,''),staticValue(p.initializer)]));
  if(ts.isTemplateExpression(node))return node.head.text+node.templateSpans.map(s=>`[${s.expression.getText()}]`+s.literal.text).join('');
  if(ts.isConditionalExpression(node))return {conditional:node.condition.getText(),yes:staticValue(node.whenTrue),no:staticValue(node.whenFalse)};
  if(ts.isIdentifier(node))return {reference:node.text};
  return undefined;
};
const readVariable = (file:string,name:string):any => {
  let result:any;
  const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText()===name)result=staticValue(node.initializer);ts.forEachChild(node,visit);};
  visit(sourceFile(file));return result;
};
const namedSource=(file:string)=>path.posix.normalize(`server/src/game/${file}`);

// Registration: do not count catalog/talent/reward buttons as new scenes.
const lastScenes=readVariable('message.ts','storyScenes') as string[];
lastScenes.forEach((text,i)=>add(`registration.story.${String(i+1).padStart(2,'0')}`,`最后一幕·${i+1}`,text,namedSource('message.ts'),'registration.last_moment'));
addGroup('registration.last_moment','序章·最后一幕',namedSource('message.ts'),'registration.story.12',['registration.story.12'],'其余11种死亡背景差异大；通用意象不包含交通、医院、海岸等具体地点，只在第12种中性片段显示，其他不硬贴。');
const erisTexts=readVariable('divine-message.ts','texts');
for(const goddess of ['aqua','eris']){
  for(const stage of ['audience','question','destination','danger']){
    const text=goddess==='eris'?erisTexts[stage].yes:readVariable('message.ts',`${stage}Text`);
    add(`registration.${goddess}.${stage}`,`${goddess==='eris'?'厄里斯':'阿库娅'}·${stage}`,text,namedSource(goddess==='eris'?'divine-message.ts':'message.ts'),`registration.${goddess}`,[goddess==='eris'?'厄里斯':'阿库娅']);
  }
  addGroup(`registration.${goddess}`,`序章·${goddess==='eris'?'厄里斯':'阿库娅'}的接引`,namedSource('divine-message.ts'),`registration.${goddess}.audience`,[`registration.${goddess}.audience`,`registration.${goddess}.question`,`registration.${goddess}.destination`],'恩赐触额和展开名录动作不同，关键图选择面向女神的接引室对话。');
}
add('registration.heaven','天堂的门扉',readVariable('message.ts','heavenText'),namedSource('message.ts'),'registration.heaven');
addGroup('registration.heaven','序章·天堂的门扉',namedSource('message.ts'));

// Use final runtime content, never generated files before retention/polish.
for(const route of openingRoutes){
  const group=`opening.${route.code}`;
  const status=openingStartRouteCodes.has(route.code)?'new-player':'supported-existing-save';
  const source=namedSource('opening-content.ts');
  const reading=route.entryMergedIntoFirstPage?route.pages:[{title:route.title,text:route.moveEntry},...route.pages];
  reading.forEach((page,i)=>add(`${group}.reading.${i+1}`,page.title,page.text,source,group,[],status));
  const arrivals=new Map<string,string>();const lessons=new Map<string,string>();
  for(const choice of route.choices){
    choice.pages.forEach((page,i)=>add(`${group}.${choice.code}.branch.${i+1}`,page.title,page.text,source,group,[],status));
    (choice.arrival??route.arrival).forEach((page,i)=>{
      const key=`${group}.${choice.code}.arrival.${i+1}`;
      const existing=arrivals.get(page.text);
      if(existing)scenes.find(s=>s.sceneKey===existing)!.aliases=(scenes.find(s=>s.sceneKey===existing)!.aliases??[]).concat(key);
      else{arrivals.set(page.text,key);add(key,page.title,page.text,source,group,[],status);}
    });
    const lessonText=openingLessonText(route,choice);const key=`${group}.${choice.code}.lesson.1`;
    const existing=lessons.get(lessonText);
    if(existing)scenes.find(s=>s.sceneKey===existing)!.aliases=(scenes.find(s=>s.sceneKey===existing)!.aliases??[]).concat(key);
    else{lessons.set(lessonText,key);add(key,choice.quest,lessonText,source,group,[],status);}
  }
  const displays=route.code==='F01'?[`${group}.reading.1`,`${group}.A.branch.1`]:route.code==='F03'?[`${group}.reading.1`,`${group}.reading.2`,`${group}.reading.3`]:[`${group}.reading.1`];
  addGroup(group,`初章·${route.title}`,source,`${group}.reading.1`,displays,'只在关键画面与文本场景相符时显示。分支的奖励、同行者和地点变化不自动匹配整条路线前缀。');
}
const a01=openingRoutes.find(r=>r.code==='A01')!;
const erisReading=[{title:a01.title,text:a01.moveEntry},{title:'一次过于热情的欢迎',text:a01.pages.map(p=>p.text).join('\n\n').split('再睁眼时，蓝发女神')[0]!.trim()},...readVariable('opening.service.ts','erisPages')];
erisReading.forEach((p:any,i:number)=>add(`opening.A01.eris.reading.${i+1}`,p.title,p.text,namedSource('opening.service.ts'),'opening.A01.eris',['厄里斯']));
const erisBranches=readVariable('opening.service.ts','texts');
for(const code of ['A','B','C'])add(`opening.A01.eris.${code}.branch.1`,'厄里斯·返还',erisBranches[code],namedSource('opening.service.ts'),'opening.A01.eris',['厄里斯']);
addGroup('opening.A01.eris','初章·重返女神殿（厄里斯已接班）',namedSource('opening.service.ts'),'opening.A01.eris.reading.3',['opening.A01.eris.reading.3','opening.A01.eris.reading.4','opening.A01.eris.A.branch.1','opening.A01.eris.B.branch.1','opening.A01.eris.C.branch.1']);

const forestPages=readVariable('adventure.service.ts','forestGuidePages');
for(const [index,p] of Object.entries(forestPages) as [string,{text:string}][])add(`forest.guide.${index}`,`森林引导·${index}`,p.text,namedSource('adventure.service.ts'),'forest.guide',['莱昂','伊芙','希娅'],'supported-existing-save');
addGroup('forest.guide','旧存档·林中的三人冒险团',namedSource('adventure.service.ts'),'forest.guide.2',['forest.guide.2','forest.guide.3','forest.guide.4'],'可复用 opening.F03 图，相同三人、相同森林场所。只听见声音的第1页不显示三人合照。');
for(const [index,text] of Object.entries(forestArrivalTownScenes))add(`forest.town.${index}`,`百纳镇入城·${index}`,text,namedSource('forest-arrival-content.ts'),'forest.town');
addGroup('forest.town','百纳镇·初遇梨子喵',namedSource('forest-arrival-content.ts'),'forest.town.2',['forest.town.2','forest.town.3','forest.town.4','forest.town.5']);
for(const [index,text] of Object.entries(forestArrivalGuildScenes))add(`forest.guild.${index}`,`梨子带路·${index}`,text,namedSource('forest-arrival-content.ts'),'forest.guild',['梨子喵']);
addGroup('forest.guild','百纳镇·梨子带我认识公会',namedSource('forest-arrival-content.ts'),'forest.guild.3',['forest.guild.3']);

// One key scene for each complete lamplight arc/chapter, not every evidence button.
// initializeLamplight no longer opens its locations and no current command
// route exposes this graph. Keep the text census for the exclusion audit only.
const addArc=(group:string,title:string,nodes:any[],status:Scene['status']='retired')=>{
  const prefix=group.startsWith('lamplight.legacy.')?'legacy.':group.startsWith('lamplight.supported.')?'supported.':'';
  for(const node of nodes)add(`lamplight.${prefix}${node.code}`,node.title,[node.intro,...node.findings,node.conclusion].join('\n\n'),namedSource('lamplight-content.generated.ts'),group,[node.npc],status);
  addGroup(group,title,namedSource('lamplight-content.generated.ts'),undefined,undefined,'原始文本含分支作者注，绘图以玩家实际分支和关键NPC为准；仅推荐关键场景显示。');
};
for(const [route,nodes] of Object.entries(lamplightPrivate)){
  if(openingRoutes.some(r=>r.code===route))addArc(`lamplight.private.${route}`,`灯下私章·${route}`,nodes);
  else addArc(`lamplight.supported.${route}`,`历史存档灯下私章·${route}`,nodes,'retired');
}
for(const [route,nodes] of Object.entries(lamplightLegacy))addArc(`lamplight.legacy.${route}`,`旧版灯下私章·${route}`,nodes,'retired');
for(const [hub,nodes] of Object.entries(lamplightLocal))addArc(`lamplight.local.${hub}`,`灯下地方篇·${hub}`,nodes);
addArc('lamplight.join','灯下·汇入世界树',lamplightJoin);
for(let chapter=1;chapter<=8;chapter++)addArc(`lamplight.world.${String(chapter).padStart(2,'0')}`,`灯下世界篇·${chapter}`,lamplightWorld.filter(n=>n.code.startsWith(`WM${String(chapter).padStart(2,'0')}-`)));

for(const profession of hiddenProfessions){
  const group=`hidden_quest.${profession.code}`;
  for(let stage=1;;stage++){
    const story=hiddenQuestStory(profession.code,stage);if(!story)break;
    add(`${group}.${stage}`,`${profession.name}·委托${stage}`,`${story.scene}\n\n${story.speech}`,namedSource('hidden-quest.story.ts'),group,[profession.mentor]);
    add(`${group}.${stage}.completed`,`${profession.name}·委托${stage}完成`,story.completed,namedSource('hidden-quest.story.ts'),group,[profession.mentor]);
  }
  addGroup(group,`隐藏职业·${profession.name}的完整私人委托`,namedSource('hidden-quest.story.ts'),`${group}.1`,[`${group}.1`],hiddenMentorVoices[profession.code].voice);
}
for(const profession of worldTreeAdvancedProfessions){
  const group=`advanced.${profession.code}`;
  add(`${group}.first`,profession.first.title,profession.first.story,namedSource('advanced-profession.config.ts'),group,[profession.mentor.name]);
  add(`${group}.second`,profession.second.title,profession.second.story,namedSource('advanced-profession.config.ts'),group,[profession.mentor.name]);
  add(`${group}.trial`,`${profession.name}·导师试炼`,profession.trial.description,namedSource('advanced-profession.config.ts'),group,[profession.mentor.name]);
  const success=mentorDialogues[profession.mentor.code]?.success;
  if(success)add(`${group}.success`,`${profession.name}·二转完成`,success,namedSource('advanced-profession.dialogue.ts'),group,[profession.mentor.name]);
  addGroup(group,`二转·${profession.name}`,namedSource('advanced-profession.config.ts'),`${group}.trial`,[`${group}.trial`,`${group}.success`]);
}
for(const profession of mapHiddenAdvancedProfessions){
  const group=`map_hidden.${profession.code}`;const quest=mapHiddenAdvancedQuests[profession.code]!;
  add(`${group}.lesson`,`${profession.name}·见闻`,quest.lesson,namedSource('map-hidden-advanced-quest.config.ts'),group,[profession.mentor.name]);
  add(`${group}.trial`,`${profession.name}·实战`,quest.trialInstruction,namedSource('map-hidden-advanced-quest.config.ts'),group,[profession.mentor.name]);
  addGroup(group,`地图隐藏二转·${profession.name}`,namedSource('map-hidden-advanced-quest.config.ts'),`${group}.trial`,[`${group}.trial`]);
}
const addPages=(group:string,title:string,pages:readonly any[],source:string,extras:string[])=>{pages.forEach((p,i)=>add(`${group}.${i+1}`,p.title??`${title}·${i+1}`,p.text,source,group,extras));addGroup(group,title,source);};
addPages('floating.tour','浮叶镇·菲萝缇带路',floatingTourScenes,namedSource('floating-leaf-content.ts'),['菲萝缇']);
for(const [stage,text] of Object.entries(floatingRescueTexts))add(`floating.rescue.${stage}`,`浮叶镇营救·${stage}`,text,namedSource('floating-leaf-content.ts'),'floating.rescue',['菲萝缇']);
addGroup('floating.rescue','浮叶镇·寻找失踪孩子',namedSource('floating-leaf-content.ts'),'floating.rescue.return',['floating.rescue.return']);
addPages('floating.thanks','菲萝缇的假·世界树同行',floatingThanksScenes,namedSource('floating-leaf-content.ts'),['菲萝缇']);
addPages('worldtree.aevier_tour','世界树·艾薇儿的新朋友',aevierTour,namedSource('worldtree-witness-content.ts'),['艾薇儿']);
addPages('worldtree.aevier_challenge','世界树·艾薇儿与艾森的约战',aevierChallenge,namedSource('worldtree-witness-content.ts'),['艾薇儿','艾森']);
add('worldtree.aevier_challenge.victory','艾森败后',aesonVictory('旅人'),namedSource('worldtree-witness-content.ts'),'worldtree.aevier_challenge',['艾薇儿','艾森']);

// Random memory cards are one series; do not paste one named character/location across 500 different situations.
for(const card of heartCards)add(`heart.${card.code}`,card.title,card.prompt,namedSource('heart-question-content.ts'),'heart.mirror');
addGroup('heart.mirror','问心·五百种倒影的共同入口',namedSource('heart-question-content.ts'),undefined,[],'绘制无具体NPC的第一人称魔法镜面/片段光点作为系列入口图；随机prompt涉及五百不同场景，不自动把入口图粘到每一道题。');

const extraInlineSources=['girl-gratitude.service.ts','main-quest.service.ts','dungeon-quest.service.ts','alchemy-creation-quest.service.ts','../response/alchemist.ts','../response/evolution-quest.ts','floating-leaf.service.ts'];
const inlineCandidates=extraInlineSources.flatMap(file=>{
  const source=sourceFile(file);const items:{source:string;line:number;text:string}[]=[];
  const visit=(node:ts.Node)=>{if((ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node)||ts.isTemplateExpression(node))){const text=staticValue(node);if(typeof text==='string'&&text.length>=60&&!/SELECT |INSERT |UPDATE |DELETE |\bFROM\b/.test(text))items.push({source:namedSource(file),line:source.getLineAndCharacterOfPosition(node.getStart()).line+1,text});}ts.forEachChild(node,visit);};visit(source);return items;
});
const inline=(start:string)=>inlineCandidates.find(c=>c.text.startsWith(start));
const addInline=(key:string,title:string,start:string,group:string,npcs:string[])=>{const entry=inline(start);if(!entry)throw Error(`Missing inline scene: ${start}`);return add(key,title,entry.text,`${entry.source}:${entry.line}`,group,npcs);};
const gratitude=[['1','开口的谢意','我刚走近，梨子喵'],['2','第一次同行跨界','界门驿站中央的环形门框'],['3','根桥险情','梨子喵领着我沿巨根'],['4','没有被忘掉','我们坐在世界树高处'],['6','珍惜的同行者','我收下礼物，梨子喵'],['5','芽辉护符','万叶联市坐落在一片']] as const;
for(const [stage,title,start] of gratitude)addInline(`gratitude.pear.${stage}`,title,start,'gratitude.pear',['梨子喵']);
addGroup('gratitude.pear','少女的谢意·梨子喵的芽辉护符',namedSource('girl-gratitude.service.ts'),'gratitude.pear.5',['gratitude.pear.5']);
const goblin=[['king','林间王旗','忽然，沉闷的鼓声'],['guild','失踪的少女','我赶到公会时'],['workshop','请教唯薇安','我把密林深处的异状'],['purchase','天位制裁仪','唯薇安一把收走铜币'],['clue','追踪打斗声','踏进幽暗密林深处'],['found','与梨子并肩','我循着声音穿过'],['suppress','让国王付代价','国王发出短促的笑声']] as const;
for(const [stage,title,start] of goblin)addInline(`rescue.pear.${stage}`,title,start,'rescue.pear',stage==='guild'?['莫妮卡']:['workshop','purchase'].includes(stage)?['唯薇安']:stage==='clue'?[]:['梨子喵']);
addGroup('rescue.pear','失踪的少女·营救梨子与哥布林国王',namedSource('main-quest.service.ts'),'rescue.pear.found',['rescue.pear.found'],'营救时鱼骨头发卡已经丢失，头发沾泥；应维持梨子的脸与发色，但不要画完好的鱼骨发卡。');
for(const [stage,title,start,npc] of [['guild','迷宫封印的由来','[warm]','莫妮卡'],['workshop','破魔传送器','[familiar]','唯薇安'],['entrance','雷恩的告诫','[extra]','雷恩']] as const)addInline(`dungeon.secret.${stage}`,title,start,'dungeon.secret',[npc]);
addGroup('dungeon.secret','地下的秘密·封印与破魔传送器',namedSource('dungeon-quest.service.ts'),'dungeon.secret.entrance',['dungeon.secret.entrance']);
addInline('alchemy.creation.lesson','瓶中之外的世界','晴儿从柜台下翻出一本','alchemy.creation',['晴儿']);
addGroup('alchemy.creation','炼金·瓶中之外的世界',namedSource('alchemy-creation-quest.service.ts'));
addInline('barrier.sky.advice','无形的禁锢','晴儿轻轻放下量杯','barrier.sky',['晴儿']);
addInline('barrier.sky.return','天空粉尘回应感知','晴儿接过天空粉尘','barrier.sky',['晴儿']);
addGroup('barrier.sky','突破·无形的禁锢与天空粉尘',namedSource('../response/alchemist.ts'),'barrier.sky.return',['barrier.sky.return']);
const investigations=readVariable('../response/evolution-quest.ts','investigationStories');
for(const [room,story] of Object.entries(investigations) as [string,{title:string;text:string}][])add(`evolution.library.${room}`,story.title,story.text,namedSource('../response/evolution-quest.ts'),'evolution.library');
const study=inlineCandidates.find(s=>s.source===namedSource('../response/evolution-quest.ts')&&s.text.includes('噶')&&s.text.includes('“'));
if(study)add('evolution.library.study','寻访大学者·噶',study.text,`${study.source}:${study.line}`,'evolution.library',['噶']);
addGroup('evolution.library','突破·世界图书馆与大学者噶',namedSource('../response/evolution-quest.ts'),'evolution.library.hall',['evolution.library.hall'],'噶为女性研究者。推荐大厅书库画面不提前放入尚未见面的研究者。');
const floatingBarrier=inlineCandidates.find(s=>s.source===namedSource('floating-leaf.service.ts')&&s.text.startsWith('我把木叶放进观风台'));
if(floatingBarrier){add('floating.barrier.dust','观风台的天空粉尘',floatingBarrier.text,`${floatingBarrier.source}:${floatingBarrier.line}`,'floating.barrier',['菲萝缇']);addGroup('floating.barrier','浮叶镇·观风台突破',namedSource('floating-leaf.service.ts'))}
const jobs=readVariable('opening-progress.service.ts','newcomerJobs');
for(const [index,job] of jobs.entries()){
  const key=`opening.job.${index+1}`;for(const stage of ['intro','middle','done'])add(`${key}.${stage}`,job.title,job[stage],namedSource('opening-progress.service.ts'),key,[job.npc]);
  addGroup(key,`初行委托·${job.title}`,namedSource('opening-progress.service.ts'),`${key}.intro`,[`${key}.intro`,`${key}.middle`,`${key}.done`]);
}
for(const group of groups){
  const entries=scenes.filter(s=>s.group===group.storyGroupKey);
  group.sceneKeys=entries.flatMap(s=>[s.sceneKey,...s.aliases??[]]);
  group.npcs=[...new Set(entries.flatMap(s=>s.npcs))];
}
const output={schemaVersion:1,generatedAt:'2026-09-30',mode:'one-key-scene-per-complete-story',definitions:{sceneKeys:'归属于完整剧情的全部文本key',displaySceneKeys:'关键插图画面与正文一致的页面；不进行route前缀宽泛回退',supportedExistingSave:'运行时代码允许旧进度读取；不代表新注册会抽到'},stats:{scenes:scenes.length,groups:groups.length,activeGroups:groups.filter(isCurrentStory).length,supportedExistingSaveGroups:groups.filter(g=>g.status==='supported-existing-save').length,retiredGroups:groups.filter(g=>g.status==='retired').length,baseOpeningUniqueTextPages:84},groups:groups.map(g=>({...g,recommendedScene:scenes.find(s=>s.sceneKey===g.recommendedSceneKey)})),scenes,inlineCandidates,characterSources:{existingPearReference:'C:/Users/afshu/AppData/Local/Temp/codex-clipboard-2a8df220-bc54-4452-ad42-2340dfe6df3a.png',descriptions:lamplightPeople,hiddenMentorVoices}};
const destination=path.join(serverRoot,'src/assets/game/story/illustrations/census.json');fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,JSON.stringify(output,null,2)+'\n');
const documentedGroups=(entries:Group[])=>entries.map(g=>{
  const scene=scenes.find(s=>s.sceneKey===g.recommendedSceneKey)!;
  const summary=scene.text.replace(/\r?\n/g,' ').slice(0,110).replaceAll('|','／');
  return `| ${g.storyGroupKey} | ${g.title} | ${g.recommendedSceneKey} | ${g.npcs.join('、')||'场所或意象'} | ${summary} |`;
}).join('\n');
const doc=`# 剧情插画场景清单（2026-09-30）\n\n## 绘制粒度\n\n按用户确认的“每条完整剧情关键场景一幅图片”执行，不按每个弹窗、调查按钮或纯奖励菜单新增一张。视角为主角眼睛看到的画面，通常不画主角本体。\n\n本次静态清点共有 **${output.stats.activeGroups} 个当前剧情分组**，另有 **${output.stats.supportedExistingSaveGroups} 个旧存档续读分组** 和 **${output.stats.retiredGroups} 个已退出分组**，均不配图。森林三人引导可复用 F03 的相同人物、相同林间场景；其余分组先按独立关键画面制作。共有 ${scenes.length} 个归属文本 key，包含问心的500个倒影片段，不能将它们误当500张图。\n\n这里只绘制有当前入口的已实装内容。灯火所至已退出主线（database/lamplight.ts），其配置仅列为 retired 排除审计；历史续读剧情不绘制、不发布。未连接生产数据库检查临时地图开关。\n\n## 机器清单与复核命令\n\n- 机器清单：server/src/assets/game/story/illustrations/census.json。\n- 导出器：server/scripts/export-story-illustration-census.ts。\n- 从 server 目录执行：\n\n\`\`\`powershell\nnode --import tsx scripts/export-story-illustration-census.ts\n\`\`\`\n\n每组包含 storyGroupKey、推荐 scene key 与全文、NPC 名单、sceneKeys（整条剧情的归属文本）、displaySceneKeys（该幅关键图适合显示的具体页面）。后者必须显式匹配；不能按路线前缀将金兔图贴到宝箱分支、将阿库娅图贴到厄里斯接班、将百纳镇图贴到浮叶镇。\n\n## 新手初章最终生效内容\n\nopening-content.ts 的生成内容还会经过最终改写、叙事扩展、奖励策略、保留路线、散文校对。以导入后 openingRoutes 为准，不直接按历史生成文件总量作图。\n\n- 目录保留8条：F01、F02、F03、S03、M01、M02、A01、C02。\n- 新注册抽取7条：F01、F02、F03、S03、M01、M02、A01；C02仅给旧存档续读。\n- 基本独立文本页84：阅读21、分支24、抵达去重27、交接/lesson去重12。\n- A01已有厄里斯接班条件页7个 key；与基本阅读的入场描述有一页相同，不以重复文本强制多做图。\n- choice沿用当前最后阅读页，armed、completed通常是操作/结算状态，纯菜单不另作场景。\n\n## 人物一致性\n\n| 人物 | 已有设定与来源 | 画面约束 |\n| --- | --- | --- |\n| 梨子喵 | 已认可立绘、forest-arrival-content、npc-dialogue.service；阿克谢尔·梨子，半猫族；活泼嘴硬，会紧张和迷路，重视同行者 | 金发、琥珀眼、猫耳、小尾巴、Q版鱼骨发卡；青绿短斗篷、黑短上衣短裤、白金外裙、完整护臂。营救场景原文已丢失发卡，应按场合移除 |\n| 莱昂 | opening-content与forest-arrival-content：年轻剑盾战士，直率可靠，护住同伴 | 年轻人类男子，剑盾为辨识物；未指定发色眼色，新定后固定 |\n| 伊芙 | 同上：红发火焰法师，嘴硬而敏锐 | 红发、火星；不要与希娅画成同脸 |\n| 希娅 | 同上：白袍治疗者，温和细致 | 白袍、绷带/治疗光；未指定发色，新定后固定 |\n| 阿库娅 | message.ts、lamplight-people：蓝发女神，爱面子，负责接引 | 蓝发与神界接引身份固定；后续下界服装可变 |\n| 厄里斯 | divine-message、opening.service：银发女神，温和细致 | 银发与脸固定；不要与阿库娅混用 |\n| 莫妮卡 | npc-dialogue：利落短发的公会接待员，礼貌仔细 | 短发、登记柜台与笔册；眼色发色若代码未指定不能写成旧设定 |\n| 瑟芙菈 | F02：带角魔族少女，弯角缺一小块，银饰有暗红微光，受伤仍警觉嘴硬 | 断角位置、面部、发型固定；肩部包扎随剧情变化 |\n| 菲萝缇 | M01：尖耳见习航务少女，记录板和误运木箱；浮叶正文中勇于认错、会被风吹乱纸页 | 尖耳与脸固定，航务制服/请假短外套依场合变换 |\n| 艾蕾诺 | M02：逃婚贵族少女，泥婚裙、歪花冠；后续珍惜自由与工作所得 | 开场婚礼服；后续工作服变化不能改脸 |\n| 格琳达 | C02正文：巨大霜龙本体，阅读眼镜，掌管客舍 | 不能擅自画成人类少女；巨大龙头、眼镜、账本与炉火 |\n| 晴儿 | npc-dialogue与hiddenMentorVoices：细心温柔的炼金师、药剂与糖水店主 | 同一面部；量杯、糖水、反应釜依任务变化 |\n| 漠北 | npc-dialogue：将近13岁的九尾狐族与矮人混血男孩，手艺沉稳 | 年少体型与兽耳，不画老铁匠 |\n| 唯薇安 | npc-dialogue：看起来16～17岁，半精灵，有数十年经验 | 少女外貌、尖耳、工具与机械，表现活泼而有经验 |\n| 洛文·赫斯特 | npc-dialogue：老书店主，老花镜、耐心传授知识 | 老者身份固定，不受玩家职业立绘年轻人要求覆盖 |\n| 噶 | evolution-quest的引荐函明确使用“她”；图书馆深处研究者 | 女性研究者，不画老爷爷；尚未见面阶段只显示图书馆，不提前贴她的特写 |\n| 雷恩 | npc-dialogue与dungeon-quest：谨慎猎人，弓箭、旧迷宫地图 | 安静警觉，地下入口告诫场景 |\n\n未定义的发色、眼色、脸型由美术首次确定，在每个后续场景继续引用同一人物参考图；不得将新增美术设计冒充既有世界观文字。\n\n## 当前剧情分组\n\n| Group key | 完整剧情 | 推荐场景 key | NPC | 关键画面原文节选 |\n| --- | --- | --- | --- | --- |\n${documentedGroups(groups.filter(isCurrentStory))}\n\n## 旧存档兼容分组（排除，不配图）\n\n这些节点只作文字清点，排除在发布配图之外；已退出的灯火所至也不配图。\n\n| Group key | 完整剧情 | 推荐场景 key | NPC | 关键画面原文节选 |\n| --- | --- | --- | --- | --- |\n${documentedGroups(groups.filter(g=>g.status==='supported-existing-save'))}\n\n## 消息与网页接入位置\n\n| 剧情族 | 文本/状态来源 | QQ Markdown 渲染入口 |\n| --- | --- | --- |\n| 序章接引 | game/divine-message.ts registrationScene；message.ts；registration-message.ts | 同模块 Format Markdown |\n| 初章8路线 | game/opening.service.ts scenePages/view；opening-content.ts | game/opening-message.ts openingFormat |\n| 森林、入镇、公会 | game/adventure.service.ts forestGuidePages/snapshot；forest-arrival-content.ts | response/adventure.ts；App app-command.service 的 forestChapterText/townArrivalText |\n| 灯下主线 | game/lamplight.service.ts；lamplight-content.generated.ts | response/lamplight.ts lamplightFormat |\n| 店内隐藏职业 | game/hidden-quest.service/story/config | response/hidden-profession.ts 委托页与story handler |\n| 普通二转 | game/advanced-profession.config/dialogue/service | response/advanced-profession.ts advancedProfessionDetailFormat、startAdvancedProfessionTrialHandler |\n| 地图隐藏二转 | game/map-hidden-advanced-quest.config、profession.service | response/map-hidden-advanced-profession.ts |\n| 浮叶初游/谢意/营救 | game/floating-leaf-content/service | response/floating-leaf.ts floatingSceneFormat、prose |\n| 世界树艾薇儿/艾森 | game/worldtree-witness-content/service | response/worldtree-witness.ts worldtreeWitnessFormat；战斗胜利需保留实际剧情正文 |\n| 少女谢意 | game/girl-gratitude.service.ts | response/girl-gratitude.ts chapterFormat |\n| 梨子营救 | game/main-quest.service.ts | response/adventure.ts 的主线章节发送 |\n| 天空粉尘 | game/main-quest.service.ts | response/alchemist.ts barrierAdviceFormat、skyDustAdviceFormat；response/main-quest.ts |\n| 世界图书馆 | response/evolution-quest.ts investigationStories；game/main-quest.service.ts | response/evolution-quest.ts worldLibraryFormat、调查、gaStudyHandler |\n| 地下秘密 | game/dungeon-quest.service.ts | response/dungeon-quest.ts chapterFormat |\n| 炼金创造 | game/alchemy-creation-quest.service.ts | 对应炼金学习入口，按 lesson key 显示 |\n\n网页现有 StoryGuideContent 会解析 Format 图片；打包图片需映射到本地 /assets/story/...，QQ使用已上传图库URL。web/vite.config.ts全资源manifest必须包含story目录，避免首次加载漏下剧情图。图库未上传成功的条目保持真实状态，不写虚构URL。\n`;
const documentPath=path.join(root,'docs/剧情插画场景清单-20260930.md');fs.mkdirSync(path.dirname(documentPath),{recursive:true});fs.writeFileSync(documentPath,doc);
const keys=scenes.flatMap(s=>[s.sceneKey,...s.aliases??[]]);const duplicates=keys.filter((key,index)=>keys.indexOf(key)!==index);if(duplicates.length)throw Error(`Duplicate scene keys: ${duplicates.join(',')}`);
console.log(JSON.stringify({path:destination,documentPath,stats:output.stats,inlineCandidates:inlineCandidates.length}));
