/* Browser-independent smoke test: runs the real app.js against a small DOM shim.
   For layout pixels, test in an actual browser/device after deployment. */
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
class Elem {
  constructor(tag='div') {
    this.tagName=tag.toUpperCase();this.id='';this.dataset={};this.children=[];this.listeners={};this.attrs={};
    this.style={setProperty(k,v){this[k]=v}};this.className='';this.disabled=false;this.textContent='';this.innerHTML='';
    this.classList={add:(...x)=>x.forEach(v=>{this.className += ` ${v}`}),remove:(...x)=>x.forEach(v=>{this.className=this.className.replace(v,'')}),toggle:(c,on)=>{const has=this.className.split(/\s+/).includes(c);if(on===false||(on===undefined&&has)){this.className=this.className.replace(c,'');return false}if(!has)this.className+=' '+c;return true},contains:(c)=>this.className.split(/\s+/).includes(c)};
  }
  append(...children){for(const child of children){if(child.tagName==='#FRAGMENT')this.children.push(...child.children);else this.children.push(child)}}
  replaceChildren(...children){this.children=[];this.append(...children)}
  setAttribute(k,v){this.attrs[k]=v}
  getAttribute(k){return this.attrs[k]}
  addEventListener(name,fn){(this.listeners[name] ||= []).push(fn)}
  trigger(name,event={}){for(const fn of this.listeners[name]||[])fn({target:this,...event})}
  click(){this.trigger('click')}
  focus(){}
}
const html=fs.readFileSync(root+'/index.html','utf8');
const ids=[...html.matchAll(/id="([^"]+)"/g)].map(x=>x[1]);
const nodes=Object.fromEntries(ids.map(id=>[id,new Elem()]));
const sizecards=[4,6,9].map(s=>{const b=new Elem('button');b.dataset.size=String(s);return b});
const charSticker=new Elem('div');
const document={
  hidden:false,
  body:new Elem('body'),
  createElement:(tag)=>new Elem(tag),
  createDocumentFragment:()=>new Elem('#fragment'),
  querySelector:(sel)=>{if(sel.startsWith('#'))return nodes[sel.slice(1)];if(sel==='.character-sticker')return charSticker;if(sel.startsWith('meta['))return new Elem('meta');if(sel.startsWith('.cell[data-index=')){const ix=Number(sel.match(/"(\d+)"/)[1]);return nodes['sudoku-board'].children[ix]}return null},
  querySelectorAll:(sel)=>sel==='.size-card'?sizecards:[],
  addEventListener(){},
};
const storage={};const localStorage={getItem:(k)=>storage[k]||null,setItem:(k,v)=>{storage[k]=v}};
const windowObj={scrollTo(){},setTimeout(fn){return 1},setInterval(){},addEventListener(){},removeEventListener(){},location:{search:''}};
const ctx={document,window:windowObj,URLSearchParams,localStorage,navigator:{},console,fetch:async()=>({ok:true,json:async()=>JSON.parse(fs.readFileSync(root+'/data/puzzles.json','utf8'))}),setTimeout:()=>1,clearTimeout(){},Math,JSON,Date};
const puzzleState=()=>JSON.parse(storage['vvelcom.sudoku.v1:browser']);
const cell=(i)=>nodes['sudoku-board'].children[i];
const keypad=(value)=>nodes['number-keypad'].children[value-1];
const run=async()=>{
  vm.runInNewContext(fs.readFileSync(root+'/app.js','utf8'),ctx,{filename:'app.js'});
  for(let i=0;i<18;i++)await Promise.resolve();
  assert.equal(nodes['start-btn'].disabled,false,'start enabled');
  assert.equal(nodes['theme-options'].children.length,6);
  assert.equal(nodes['difficulty-options'].children.length,1);
  nodes['start-btn'].click();
  assert.equal(nodes['sudoku-board'].children.length,16);
  assert.equal(nodes['number-keypad'].children.length,4);
  const p=puzzleState().game.puzzle;const i=p.givens.indexOf(0);const wrong=p.solution[i]%4+1;
  cell(i).click();keypad(wrong).click();
  assert.equal(puzzleState().game.mistakes,1);
  assert.equal(puzzleState().game.board[i],wrong);
  nodes['undo-btn'].click();assert.equal(puzzleState().game.board[i],0);
  cell(i).click();keypad(wrong).click();cell(i).click();cell(i).click();
  assert.equal(puzzleState().game.board[i],0,'double tap erases user value');
  nodes['notes-btn'].click();assert.equal(nodes['notes-guide'].classList.contains('hidden'),false);keypad(1).click();assert.deepEqual(puzzleState().game.notes[i],[1]);
  nodes['notes-btn'].click();assert.equal(nodes['notes-guide'].classList.contains('hidden'),true);nodes['hint-btn'].click();
  assert.equal(puzzleState().game.board[i],p.solution[i]);
  assert.equal(puzzleState().game.hints,2);
  for(let ix=0;ix<16;ix++){
    if(p.givens[ix]||ix===i)continue;
    cell(ix).click();keypad(p.solution[ix]).click();
  }
  assert.equal(puzzleState().stats.wins,1);
  assert.equal(nodes['dialog-title'].textContent,'Ура, получилось!');
  nodes['dialog-buttons'].children.at(-1).click();
  sizecards[2].click();assert.equal(nodes['difficulty-options'].children.length,3);
  nodes['start-btn'].click();assert.equal(nodes['sudoku-board'].children.length,81);
  assert.equal(nodes['number-keypad'].children.length,9);
  const gameBeforeRestart = puzzleState().game;
  nodes['restart-game-btn'].click();
  assert.equal(nodes['dialog-title'].textContent,'Начать эту головоломку сначала?');
  assert.equal(puzzleState().game.paused,false,'restart confirmation never pauses clock');
  nodes['dialog-buttons'].children[0].click();
  const gameAfterRestart = puzzleState().game;
  assert.equal(gameAfterRestart.puzzle.id,gameBeforeRestart.puzzle.id);
  assert.deepEqual(gameAfterRestart.board,gameAfterRestart.puzzle.givens);
  assert.equal(gameAfterRestart.elapsed,gameBeforeRestart.elapsed);
  assert.equal(gameAfterRestart.paused,false);
  nodes['pause-btn'].click();assert.equal(puzzleState().game.paused,true);
  nodes['resume-btn'].click();assert.equal(puzzleState().game.paused,false);
  console.log('PASS runtime: initialization, choices, errors, undo, notes, hint, victory, 9x9 and pause');
};
run().catch(e=>{console.error(e);process.exitCode=1});
