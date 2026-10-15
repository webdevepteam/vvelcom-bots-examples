from pathlib import Path
from playwright.sync_api import sync_playwright
import json
import re
ROOT=Path(__file__).resolve().parent.parent/'web-app'
html=(ROOT/'index.html').read_text().replace('<script defer src="./app.js"></script>','').replace('<link rel="stylesheet" href="./styles.css">','')
html=re.sub(r'<script async src=\"https://apibots[\s\S]*?</script>', '', html)
puzzles=json.loads((ROOT/'data/puzzles.json').read_text())
conf={'backendUrl':'https://functions.yandexcloud.net/test-function'}
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium', args=['--no-sandbox','--disable-dev-shm-usage'])
    context=browser.new_context(viewport={'width':393,'height':852},device_scale_factor=1,is_mobile=True,has_touch=True)
    page=context.new_page()
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.set_content(html)
    page.add_style_tag(content=(ROOT/'styles.css').read_text())
    page.evaluate('''([puzzles,config]) => {
       const data={}; Object.defineProperty(window,'localStorage',{value:{getItem:k=>data[k]??null,setItem:(k,v)=>data[k]=v}});
       window.testCalls=[];
       const initData = new URLSearchParams({query_id:'valid-query',user:JSON.stringify({id:'player1'}),auth_date:'1790000000',hash:'f'.repeat(64)}).toString();
       window.VVelcom={WebApp:{initData,initDataUnsafe:{user:{id:'player1'}}, ready(){},expand(){}, setHeaderColor(){}, BackButton:{onClick(){},show(){},hide(){}},HapticFeedback:{notificationOccurred(){},selectionChanged(){}}}};
       window.fetch=async (url,opts) => {
          const target=String(url);
          if(target.includes('puzzles.json'))return new Response(JSON.stringify(puzzles),{status:200});
          if(target.includes('config.json'))return new Response(JSON.stringify(config),{status:200});
          if(target.includes('functions.yandexcloud.net')){
             window.testCalls.push(JSON.parse(opts.body));
             return new Response(JSON.stringify({ok:true,sentToChat:true}),{status:200,headers:{'Content-Type':'application/json'}});
          }
          throw Error('unknown fetch '+url);
       };
    }''',[puzzles,conf])
    page.add_script_tag(content=(ROOT/'app.js').read_text())
    page.wait_for_selector('.difficulty-card')
    page.locator('#start-btn').click()
    # Complete using exact solution, without waiting for long-press drag.
    state=json.loads(page.evaluate('localStorage.getItem("vvelcom.sudoku.v1:player1")'))
    puzzle=state['game']['puzzle']
    for i,x in enumerate(puzzle['solution']):
        if puzzle['givens'][i]: continue
        page.locator('.cell').nth(i).click()
        page.locator('.key-button').nth(x-1).click()
    assert page.locator('#dialog-title').inner_text()=='Ура, получилось!',page.locator('#dialog-title').inner_text()
    page.locator('#dialog-buttons button').first.click()
    page.wait_for_function('window.testCalls.length===1')
    req=page.evaluate('window.testCalls[0]')
    assert req['puzzleId']==puzzle['id']
    assert req['board']==puzzle['solution']
    assert req['action']=='share'
    assert req['initData']
    assert page.locator('#share-game-btn').is_visible()
    assert not errors,errors
    print('PASS browser: finish puzzle, send signed initData + validated board to cloud function, share action after victory visible')
    browser.close()
