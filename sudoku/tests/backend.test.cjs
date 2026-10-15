'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const app = require(path.join(__dirname, '../cloud-function/index.js'));
const puzzles = require('../cloud-function/puzzles.json').puzzles;
const token = 'vv_test-not-a-real-token';
const url = 'https://my-game.example';
process.env.VVELCOM_BOT_TOKEN = token;
process.env.ALLOWED_ORIGINS = url;
process.env.GAME_URL = url + '/index.html';
process.env.VVELCOM_WEBHOOK_SECRET = 'valid-secret-123';
function sign(payload) {
  const params = new URLSearchParams({auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({id:'user-123', first_name: 'Игрок'}), ...payload});
  const sorted = [...params].sort(([a],[b])=>a < b ? -1 : a > b ? 1 : 0).map(([k,v])=>`${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256','WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256',secret).update(sorted).digest('hex');
  params.set('hash',hash);
  return params.toString();
}
const puzzle = puzzles[0];
function shareBody(initData=sign({query_id:'q_valid_1'})) {
  return {action:'share',initData, puzzleId:puzzle.id,board:puzzle.solution,elapsed:79,mistakes:0,hintsUsed:0};
}
function req(body, headers = {origin:url}) {
  return {httpMethod:'POST',headers,body:JSON.stringify(body),isBase64Encoded:false};
}
function decode(res) {return JSON.parse(res.body);}

test('health and CORS preflight allow only declared origin', async () => {
  let r=await app.handler({httpMethod:'GET',headers:{origin:url}});
  assert.equal(r.statusCode,200);
  assert.equal(r.headers['Access-Control-Allow-Origin'],url);
  r=await app.handler({httpMethod:'OPTIONS',headers:{Origin:url}});
  assert.equal(r.statusCode,204);
  assert.equal(r.headers['Access-Control-Allow-Headers'],'Content-Type');
  r=await app.handler({httpMethod:'POST',headers:{Origin:'https://evil.example'},body:'{}'});
  assert.equal(r.statusCode,403);
});

test('signed initData accepted; tampering, old and future auth rejected', () => {
  const good=sign({query_id:'abc'});
  assert.equal(app.verifyInitData(good,token).queryId,'abc');
  assert.equal(app.verifyInitData(good.replace('user-123','user-999'),token),null);
  const old=sign({auth_date:String(Math.floor(Date.now()/1000)-90000), query_id:'abc'});
  assert.equal(app.verifyInitData(old,token),null);
  const future=sign({auth_date:String(Math.floor(Date.now()/1000)+600), query_id:'abc'});
  assert.equal(app.verifyInitData(future,token),null);
});

test('correct solved board sends answerWebAppQuery with game stats', async (t) => {
  const original=global.fetch;
  const calls=[];
  global.fetch=async (target, init) => {
    calls.push({target, body:JSON.parse(init.body)});
    return {ok:true,status:200,json:async()=>({ok:true,result:{message_id:'xyz'}})};
  };
  t.after(()=>{global.fetch=original});
  const r=await app.handler(req(shareBody()));
  assert.equal(r.statusCode,200,r.body);
  assert.equal(decode(r).sentToChat,true);
  assert.equal(calls.length,1);
  assert.ok(calls[0].target.includes('/answerWebAppQuery'));
  assert.equal(calls[0].body.web_app_query_id,'q_valid_1');
  assert.match(calls[0].body.result.input_message_content.message_text,/Время: 01:19/);
  assert.match(calls[0].body.result.input_message_content.message_text,/кнопку ниже/);
  const feedBtn=calls[0].body.result.reply_markup.inline_keyboard[0][0];
  assert.equal(feedBtn.text,'📣 В ленту');
  assert.match(feedBtn.share_to_feed.text,/Время: 01:19/);
  assert.doesNotMatch(feedBtn.share_to_feed.text,/кнопку ниже/);
});

test('tampered initData and invalid board never call Bot API',async(t)=>{
  const old=global.fetch;
  global.fetch=async()=>{throw new Error('Bot API must not be called')};
  t.after(()=>{global.fetch=old});
  const badAuth=shareBody('auth_date=1&user=%7B%7D&hash=deadbeef');
  assert.equal((await app.handler(req(badAuth))).statusCode,401);
  const badGame=shareBody();badGame.board=badGame.board.slice();badGame.board[0]=0;
  assert.equal((await app.handler(req(badGame))).statusCode,422);
  const invalidTime=shareBody();invalidTime.elapsed='10';
  assert.equal((await app.handler(req(invalidTime))).statusCode,422);
});

test('missing query id reports unsupported launch context',async()=>{
  const r=await app.handler(req(shareBody(sign({}))));
  assert.equal(r.statusCode,409);
  assert.equal(decode(r).code,'QUERY_UNAVAILABLE');
});

test('Bot API failures produce safe 502 without leaking token',async(t)=>{
  const old=global.fetch;
  global.fetch=async()=>({ok:false,status:400,json:async()=>({ok:false,description:'invalid query'})});
  t.after(()=>{global.fetch=old});
  const r=await app.handler(req(shareBody()));
  assert.equal(r.statusCode,502);
  assert.equal(r.body.includes(token),false);
});

test('webhook requires secret and /start produces web_app button',async(t)=>{
  const old=global.fetch;
  const calls=[];
  global.fetch=async(_,data)=>{calls.push(JSON.parse(data.body));return {ok:true,status:200,json:async()=>({ok:true,result:{}})};};
  t.after(()=>{global.fetch=old});
  const event={httpMethod:'POST',queryStringParameters:{mode:'webhook'},body:JSON.stringify({message:{chat:{id:'chat-42',type:'private'},text:'/start'}})};
  assert.equal((await app.handler(event)).statusCode,403);
  event.headers={'X-Messenger-Webhook-Secret':'valid-secret-123'};
  const r=await app.handler(event);
  assert.equal(r.statusCode,200,r.body);
  assert.equal(calls.length,1);
  assert.equal(calls[0].chat_id,'chat-42');
  assert.equal(calls[0].reply_markup.inline_keyboard[0][0].web_app.url,url+'/index.html');
});



test('webhook has no feed callbacks and ignores other messages', async t => {
  const old=global.fetch; let sent=0;
  global.fetch=async()=>{sent++;throw Error('Unexpected Bot API call')};
  t.after(()=>{global.fetch=old});
  const r=await app.handler({httpMethod:'POST',queryStringParameters:{mode:'webhook'},
    headers:{'X-Telegram-Bot-Api-Secret-Token':'valid-secret-123'},
    body:JSON.stringify({callback_query:{id:'x',from:{id:'user-123'},data:'sf1.fake'}})});
  assert.equal(r.statusCode,200);assert.equal(sent,0);
});

test('webhook: unknown text gets help with menu buttons, /name renames', async t => {
  const old=global.fetch; const calls=[];
  global.fetch=async(_,data)=>{calls.push(JSON.parse(data.body));return {ok:true,status:200,json:async()=>({ok:true,result:{}})};};
  t.after(()=>{global.fetch=old});
  const send=(text,from={id:'user-777',first_name:'Пользователь'})=>app.handler({httpMethod:'POST',queryStringParameters:{mode:'webhook'},
    headers:{'X-Telegram-Bot-Api-Secret-Token':'valid-secret-123'},
    body:JSON.stringify({message:{chat:{id:'c1',type:'private'},from,text}})});
  assert.equal((await send('привет')).statusCode,200);
  assert.match(calls[0].text,/не понял/);
  const data=calls[0].reply_markup.inline_keyboard.flat().map(b=>b.callback_data).filter(Boolean);
  assert.deepEqual(data,['sd:top','sd:stats','sd:name']);
  assert.equal((await send('/name')).statusCode,200);
  assert.match(calls[1].text,/Игрок/);
});
