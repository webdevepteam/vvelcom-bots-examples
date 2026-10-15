"""Standalone regression checks for all bundled puzzles."""
from pathlib import Path
import json
import sys
sys.path.insert(0, str(Path(__file__).parent))
from build_puzzles import solutions_count

def check():
    p = json.loads((Path(__file__).resolve().parents[1] / 'data/puzzles.json').read_text('utf-8'))
    seen = set()
    for level in p['levels']:
        assert any(row['level'] == level for row in p['puzzles']), level
    for item in p['puzzles']:
        n = item['size']; br = item['boxRows']; bc = item['boxCols']
        assert len(item['solution']) == len(item['givens']) == n*n, item['id']
        assert item['id'] not in seen, item['id']; seen.add(item['id'])
        assert all(0 <= a <= n and 1 <= b <= n and (not a or a == b) for a, b in zip(item['givens'],item['solution'])), item['id']
        values=set(range(1,n+1))
        for r in range(n): assert set(item['solution'][r*n:r*n+n]) == values
        for c in range(n): assert set(item['solution'][c::n]) == values
        for r in range(0,n,br):
            for c in range(0,n,bc):
                assert {item['solution'][(r+y)*n+c+x] for y in range(br) for x in range(bc)} == values
        assert solutions_count(item['givens'],n,br,bc) == 1, item['id']
    print(f'PASS: {len(seen)} correct, consistent, unique-solution puzzles on all 5 levels')

if __name__=='__main__':check()
