"""Real Chromium mobile viewport smoke: notes, double tap, reset, timer continuity."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json
import re
ROOT=Path(__file__).resolve().parent.parent/'web-app'
html=(ROOT/'index.html').read_text().replace('<script defer src="./app.js"></script>','').replace('<link rel="stylesheet" href="./styles.css">','')
html=re.sub(r'<script async src=\"https://apibots[\s\S]*?</script>', '', html)
puzzles=json.loads((ROOT/'data/puzzles.json').read_text())
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
    context=browser.new_context(viewport={'width':393,'height':852},device_scale_factor=1,is_mobile=True,has_touch=True)
    page=context.new_page()
    errors=[]
    page.on('pageerror',lambda e: errors.append(str(e)))
    page.set_content(html)
    page.add_style_tag(content=(ROOT/'styles.css').read_text())
    page.evaluate('''(puzzles)=>{
      const data={};Object.defineProperty(window,'localStorage',{value:{getItem:k=>data[k]??null,setItem:(k,v)=>data[k]=v}});
      window.fetch=async (url)=>{
        if(String(url).includes('puzzles.json'))return new Response(JSON.stringify(puzzles),{status:200});
        if(String(url).includes('config.json'))return new Response(JSON.stringify({backendUrl:''}),{status:200});
        throw new Error('Unexpected URL '+url);
      };
    }''',puzzles)
    page.add_script_tag(content=(ROOT/'app.js').read_text())
    page.wait_for_selector('.difficulty-card')
    page.locator('#start-btn').click()
    read=lambda:json.loads(page.evaluate('localStorage.getItem("vvelcom.sudoku.v1:browser")'))['game']
    state=read(); ix=state['puzzle']['givens'].index(0); wrong=(state['puzzle']['solution'][ix]%4)+1
    # Enter a wrong digit, then double-tap the same editable cell
    page.locator('.cell').nth(ix).click()
    page.locator('.key-button').nth(wrong-1).click()
    assert read()['board'][ix]==wrong
    page.locator('.cell').nth(ix).click()
    page.locator('.cell').nth(ix).click()
    assert read()['board'][ix]==0, 'second tap must erase user value'
    # Fixed initial digit stays unchanged even with rapid taps
    given=next(i for i,v in enumerate(state['puzzle']['givens']) if v)
    page.locator('.cell').nth(given).click()
    page.locator('.cell').nth(given).click()
    assert read()['board'][given]==state['puzzle']['givens'][given]
    # Notes: offer candidates, display tiny values, preserve on other cells
    page.locator('.cell').nth(ix).click()
    page.locator('#notes-btn').click()
    assert page.locator('#notes-guide').is_visible()
    page.locator('.key-button').nth(0).click()
    page.locator('.key-button').nth(1).click()
    assert read()['notes'][ix]==[1,2]
    assert page.locator('.cell').nth(ix).locator('.notes-grid').count()==1
    page.locator('#notes-btn').click()
    assert not page.locator('#notes-guide').is_visible()
    # Add another real value, advance clock, reset current puzzle (not a new one)
    page.locator('.key-button').nth(wrong-1).click()
    initial_id=read()['puzzle']['id']
    page.wait_for_timeout(1150)
    elapsed_before=read()['elapsed']
    page.locator('#restart-game-btn').click()
    assert read()['paused'] is False, 'confirmation must not pause timer'
    page.wait_for_timeout(1150)
    elapsed_on_confirm=read()['elapsed']
    assert elapsed_on_confirm>elapsed_before, 'timer must run even while confirmation open'
    page.locator('#dialog-buttons button').first.click()
    result=read()
    assert result['puzzle']['id']==initial_id
    assert result['board']==result['puzzle']['givens']
    assert all(not x for x in result['notes'])
    assert result['elapsed']>=elapsed_on_confirm
    assert result['paused'] is False
    assert result['mistakes']==0 and result['hints']==3 and result['history']==[]
    assert not errors,errors
    print('PASS Chromium mobile: tap-to-erase, immutable givens, candidate notes, restart preserving running timer')
    browser.close()
