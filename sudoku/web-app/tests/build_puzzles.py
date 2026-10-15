#!/usr/bin/env python3
"""Generate unique-solution Sudoku sets with explicit solutions for local verification."""
import json, random, datetime
from pathlib import Path
random.seed(20261014)
ROOT=Path(__file__).resolve().parents[1]
LEVELS=[('mini',4,2,2,8,6),('junior',6,2,3,18,6),('classic',9,3,3,37,7),('challenge',9,3,3,30,7),('master',9,3,3,26,5)]

def build_solution(size, br, bc):
    # Permute bands, stacks, rows inside bands and columns inside stacks.
    base=lambda r,c:(bc*(r % br)+r//br+c) % size
    bands=list(range(size//br)); stacks=list(range(size//bc))
    random.shuffle(bands); random.shuffle(stacks)
    rows=[i for band in bands for i in random.sample(list(range(band*br,band*br+br)),br)]
    cols=[i for stack in stacks for i in random.sample(list(range(stack*bc,stack*bc+bc)),bc)]
    numbers=random.sample(range(1,size+1),size)
    return [numbers[base(r,c)] for r in rows for c in cols]

def solutions_count(given,size,br,bc,limit=2):
    row_masks=[0]*size; col_masks=[0]*size; box_masks=[0]*size
    total=size*size; mask=(1<<size)-1
    boxes_per_row=size//bc
    empties=[]
    for ix,v in enumerate(given):
        r,c=divmod(ix,size); box=r//br*boxes_per_row+c//bc
        if v:
            bit=1<<(v-1)
            if (row_masks[r]|col_masks[c]|box_masks[box])&bit:return 0
            row_masks[r]|=bit;col_masks[c]|=bit;box_masks[box]|=bit
        else:empties.append(ix)
    solutions=0
    def solve():
        nonlocal solutions
        if solutions>=limit:return
        if not empties:
            solutions+=1;return
        best_index=-1;best_mask=0;best_count=size+1
        for pos,cell in enumerate(empties):
            r,c=divmod(cell,size);box=r//br*boxes_per_row+c//bc
            allowed=mask & ~(row_masks[r]|col_masks[c]|box_masks[box]);n=allowed.bit_count()
            if n<best_count:
                best_index=pos;best_mask=allowed;best_count=n
                if n==1:break
                if n==0:return
        cell=empties.pop(best_index);r,c=divmod(cell,size);box=r//br*boxes_per_row+c//bc
        options=best_mask
        while options:
            bit=options&(-options);options-=bit
            row_masks[r]|=bit;col_masks[c]|=bit;box_masks[box]|=bit
            solve()
            row_masks[r]^=bit;col_masks[c]^=bit;box_masks[box]^=bit
            if solutions>=limit:break
        empties.insert(best_index,cell)
    solve();return solutions

def carve(solution,size,br,bc,clues):
    b=solution[:];spots=list(range(size*size));random.shuffle(spots)
    for i in spots:
        if sum(bool(x) for x in b)<=clues:break
        val=b[i];b[i]=0
        if solutions_count(b,size,br,bc)!=1:b[i]=val
    return b

if __name__ == "__main__":
    puzzles=[]
    for lid,n,br,bc,clue_target,num in LEVELS:
        used=set()
        for i in range(1,num+1):
            best=None
            for attempt in range(22):
                sol=build_solution(n,br,bc)
                giv=carve(sol,n,br,bc,clue_target)
                sig=tuple(giv)
                if sig not in used and (best is None or sum(map(bool,giv)) < sum(map(bool,best[0]))):
                    best=(giv,sol)
                if best and sum(map(bool,best[0]))<=clue_target: break
            assert best,lid
            giv,sol=best
            used.add(tuple(giv))
            assert solutions_count(giv,n,br,bc)==1
            puzzles.append({'id':f'{lid}-{i:02}', 'level':lid,'size':n,'boxRows':br,'boxCols':bc,'givens':giv,'solution':sol})
        print(lid,num,'clues',sorted(sum(map(bool,p['givens'])) for p in puzzles if p['level']==lid))
    result={'version':1,'description':'Unique-solution Sudoku puzzles. 0 denotes an empty cell. All data is public; no tokens or personal information.', 'levels':{'mini':{'title':'Малыш','size':4,'label':'Новичок'},'junior':{'title':'Искатель','size':6,'label':'Легко'},'classic':{'title':'Знаток','size':9,'label':'Средне'},'challenge':{'title':'Смельчак','size':9,'label':'Сложно'},'master':{'title':'Легенда','size':9,'label':'Эксперт'}},'puzzles':puzzles}
    path=ROOT/'data/puzzles.json';path.write_text(json.dumps(result,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
    print(len(puzzles),'puzzles',path.stat().st_size,'bytes')
