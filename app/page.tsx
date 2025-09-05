'use client';
import React from 'react';

// ==== Types ====
type Dir = 'across' | 'down';
interface Item { id: string; kanji: string; hira: string; }
interface CellWordRef { id: string; idx: number; dir: Dir }
interface Cell { ch: string; words: CellWordRef[] }
interface Placement { id: string; kanji: string; dir: Dir; startX: number; startY: number; len: number }
interface Bounds { minX: number; maxX: number; minY: number; maxY: number }

export default function KanaCrosswordApp(): React.ReactElement {
  // ==== State ====
  const [title, setTitle] = React.useState<string>('よみクロスワード');
  const [rawInput, setRawInput] = React.useState<string>('視点=してん\n海底＝かいてい\n教科書＝きょうかしょ');
  const [placements, setPlacements] = React.useState<Placement[]>([]);
  const [grid, setGrid] = React.useState<Map<string, Cell>>(new Map());
  const [bounds, setBounds] = React.useState<Bounds>({ minX: 0, maxX: 0, minY: 0, maxY: 0 });
  const [clueNums, setClueNums] = React.useState<Record<string, number>>({});
  const [labelStyle, setLabelStyle] = React.useState<'numeric' | 'alpha'>('numeric');
  const [message, setMessage] = React.useState<string>('');
  const [tab, setTab] = React.useState<'input' | 'puzzle' | 'answer'>('input');
  const [selectedCells, setSelectedCells] = React.useState<Set<string>>(new Set());
  const [testResults, setTestResults] = React.useState<Array<{ name: string; pass: boolean }> | null>(null);
  const [puzzlePrompt, setPuzzlePrompt] = React.useState<string>(''); // 並び替え問題の文面（講師入力）
  const [puzzleAnswer, setPuzzleAnswer] = React.useState<string>(''); // 模範解答（任意）

  // ==== Utils ====
  const keyOf = (x: number, y: number): string => `${x},${y}`;
  const fromKey = (k: string): [number, number] => k.split(',').map(Number) as [number, number];
  const splitChars = (s: string): string[] => Array.from(s);

  function toHiragana(str: string): string {
    return Array.from(str)
      .map((c: string) => {
        const code = c.codePointAt(0)!; // c は1文字想定
        if (code >= 0x30a1 && code <= 0x30f6) return String.fromCodePoint(code - 0x60); // カタカナ→ひらがな
        if (code >= 0xff66 && code <= 0xff9d) {
          const fw = c.normalize('NFKC');
          return toHiragana(fw);
        }
        return c;
      })
      .join('');
  }

  // 解答表示用のカスタム描画関数
  function AnswerBoxes({ letters }: { letters: string[] }): React.ReactElement {
    return (
      <div className='mt-2 flex gap-1 flex-wrap'>
        {letters.map((ch, i) => (
          <div key={i} className='w-9 h-9 border-4 border-rose-500 rounded-[6px] flex items-center justify-center'>
            <span className='font-extrabold text-lg'>{ch}</span>
          </div>
        ))}
      </div>
    );
  }

  function parseInput(text: string): { items: Item[]; warnings: string[] } {
    // 全角「＝」→半角へ（例ボタンの互換も担保）
    const normalized = text.replace(/＝/g, '=');
    const lines = normalized
      .split(/\r?\n/)
      .map((s: string) => s.trim())
      .filter(Boolean);
    const items: Item[] = [];
    const warnings: string[] = [];
    lines.forEach((line: string, i: number) => {
      let kanji = '',
        yomi = '';
      const m = line.match(/^(.+?)[(（]([ぁ-んァ-ンー]+)[)）]$/);
      if (m) {
        kanji = m[1].trim();
        yomi = m[2].trim();
      } else if (line.includes('=')) {
        const [a, b] = line.split('=');
        kanji = a.trim();
        yomi = (b || '').trim();
      } else {
        const parts = line.split(/\s+/);
        if (parts.length >= 2) {
          kanji = parts.slice(0, -1).join(' ');
          yomi = parts.at(-1)!;
        } else {
          kanji = line;
          yomi = '';
        }
      }
      const hira = toHiragana(yomi);
      if (!hira) warnings.push(`行${i + 1}: 「${kanji}」の読みが未指定です（例: ${kanji}=かな）`);
      items.push({ id: `w${i}`, kanji, hira });
    });
    return { items, warnings };
  }

  // ==== Crossword builder ====
// ==== Crossword builder ====
function buildCrossword(items: Item[]): { grid: Map<string, Cell>; placements: Placement[] } {
  const grid = new Map<string, Cell>();
  const placements: Placement[] = [];

  // --- ガチャ度（確率）調整用 ---
  const RANDOM_PICK_PROB = 0.28; // 28%の確率で「ベスト以外」を選ぶ
  const TOP_K_FOR_RANDOM = 4;    // ランダム時は上位K候補から選ぶ（品質を落とし過ぎないため）

  // --- 接触禁止を厳しめにした配置可否判定（現状の仕様を維持）---
  function canPlace(chars: string[], dir: Dir, sx: number, sy: number): boolean {
    const has = (x:number,y:number)=> grid.has(keyOf(x,y));

    // 単語の直前・直後は必ず空白
    const beforeX = dir==='across' ? sx-1 : sx;
    const beforeY = dir==='across' ? sy   : sy-1;
    const afterX  = dir==='across' ? sx+chars.length : sx;
    const afterY  = dir==='across' ? sy               : sy+chars.length;
    if (has(beforeX, beforeY) || has(afterX, afterY)) return false;

    for (let i=0; i<chars.length; i++){
      const x = dir==='across' ? sx+i : sx;
      const y = dir==='across' ? sy   : sy+i;
      const k = keyOf(x,y);
      const cell = grid.get(k);

      // 既存マスあり → 同じ文字で、かつ同方向に既出でない（=交差のみOK）
      if (cell){
        if (cell.ch !== chars[i]) return false;
        if (cell.words.some(w=>w.dir===dir)) return false; // 平行重なり禁止
        continue; // 交差はOK
      }

      // 新規マスの周辺接触禁止（交差以外の接触を不可）
      if (dir==='across'){
        if (has(x, y-1) || has(x, y+1)) return false;
      } else { // down
        if (has(x-1, y) || has(x+1, y)) return false;
      }
    }
    return true;
  }

  function placeWord(entry: Item, dir: Dir, sx: number, sy: number): void {
    const chars = splitChars(entry.hira);
    for (let i = 0; i < chars.length; i++) {
      const x = dir === 'across' ? sx + i : sx;
      const y = dir === 'across' ? sy : sy + i;
      const k = keyOf(x, y);
      const existing = grid.get(k);
      const cell: Cell = existing ?? { ch: chars[i], words: [] };
      if (!existing) grid.set(k, cell);
      cell.words.push({ id: entry.id, idx: i, dir });
    }
    placements.push({ id: entry.id, kanji: entry.kanji, dir, startX: sx, startY: sy, len: entry.hira.length });
  }

  // --- ここから “ガチャ” 仕様 ---
  if (!items.length) return { grid, placements };

  // ① 単語リストをシャッフル（毎回違う並びにする）
  const wordList = [...items];
  for (let i = wordList.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [wordList[i], wordList[j]] = [wordList[j], wordList[i]];
  }

  // 1語目は原点に横置き
  placeWord(wordList[0], 'across', 0, 0);

  // ② 各語の配置：候補を集めて、たまにランダムで選ぶ
  for (let wi = 1; wi < wordList.length; wi++) {
    const entry = wordList[wi];
    const chars = splitChars(entry.hira);

    // 既存グリッドの文字位置インデックス
    const posByChar = new Map<string, Array<{ key: string; cell: Cell }>>();
    grid.forEach((cell, key) => {
      if (!posByChar.has(cell.ch)) posByChar.set(cell.ch, []);
      posByChar.get(cell.ch)!.push({ key, cell });
    });

    // 候補を全部集める（scoreで良し悪しを評価）
    const candidates: Array<{dir:Dir; sx:number; sy:number; overlaps:number; score:number}> = [];
    let best: null | {dir:Dir; sx:number; sy:number; overlaps:number; score:number} = null;

    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const hits = posByChar.get(ch) || [];
      for (const h of hits) {
        const [x, y] = fromKey(h.key);
        const existingDir = h.cell.words[0]?.dir || 'across';
        const tryDirs: Dir[] = existingDir === 'across' ? ['down', 'across'] : ['across', 'down'];
        for (const dir of tryDirs) {
          const sx = dir === 'across' ? x - i : x;
          const sy = dir === 'across' ? y : y - i;
          if (!canPlace(chars, dir, sx, sy)) continue;

          // 重なり数（交差数）と原点からの近さでスコア
          let overlaps = 0;
          for (let j = 0; j < chars.length; j++) {
            const cx = dir === 'across' ? sx + j : sx;
            const cy = dir === 'across' ? sy : sy + j;
            const c = grid.get(keyOf(cx, cy));
            if (c && c.ch === chars[j]) overlaps++;
          }
          const score = overlaps * 1000 - Math.abs(sx) - Math.abs(sy);
          const cand = { dir, sx, sy, overlaps, score };
          candidates.push(cand);
          if (!best || score > best.score) best = cand;
        }
      }
    }

    if (candidates.length) {
      // 並び替えて品質順に（先頭がベスト）
      candidates.sort((a,b)=> b.score - a.score);

      // RANDOM_PICK_PROB の確率で「上位Kの中からランダム」
      const useRandom = Math.random() < RANDOM_PICK_PROB;
      const pool = useRandom ? candidates.slice(0, Math.min(TOP_K_FOR_RANDOM, candidates.length))
                             : [candidates[0]];
      const pick = pool[Math.floor(Math.random() * pool.length)];
      placeWord(entry, pick.dir, pick.sx, pick.sy);
      continue;
    }

    // 交差候補が無いとき：少しだけ詰めつつ独立配置（1行の空白は確保）
    let maxY = -Infinity;
    grid.forEach((_, key) => { const [, y] = fromKey(key); if (y > maxY) maxY = y; });
    const sy = (isFinite(maxY) ? maxY : -1) + 2; // 1行空ける

    if (canPlace(chars, 'across', 0, sy)) {
      placeWord(entry, 'across', 0, sy);
    } else if (canPlace(chars, 'down', 0, sy)) {
      placeWord(entry, 'down', 0, sy);
    } else {
      let placed = false;
      for (let sx = -4; sx <= 20 && !placed; sx++) {
        if (canPlace(chars, 'across', sx, sy)) { placeWord(entry, 'across', sx, sy); placed = true; }
      }
      if (!placed) placeWord(entry, 'across', 0, sy + 1);
    }
  }

  return { grid, placements };
}

  function computeBounds(grid: Map<string, Cell>): Bounds {
    if (grid.size === 0) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    grid.forEach((_, key) => {
      const [x, y] = fromKey(key);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    });
    return { minX, maxX, minY, maxY };
  }

  // 正しいカギ番号付け（よこ→左が空、たて→上が空）。同一セル始点の重複は統合
  function computeClueNumbers(placements: Placement[], grid: Map<string, Cell>): Record<string, number> {
    const numbers: Record<string, number> = {};
    let n = 1;
    const filled = new Set<string>([...grid.keys()]);
    const has = (x: number, y: number) => filled.has(keyOf(x, y));

    // よこ
    placements
      .filter((p) => p.dir === 'across')
      .sort((a, b) => (a.startY === b.startY ? a.startX - b.startX : a.startY - b.startY))
      .forEach((p) => {
        if (!has(p.startX - 1, p.startY)) numbers[p.id] = n++;
      });

    // たて（すでに振られていれば再利用）
    placements
      .filter((p) => p.dir === 'down')
      .sort((a, b) => (a.startX === b.startX ? a.startY - b.startY : a.startX - b.startX))
      .forEach((p) => {
        if (!has(p.startX, p.startY - 1)) numbers[p.id] = numbers[p.id] ?? n++;
      });

    return numbers;
  }

  function labelFromNumber(num: number): string {
    if (labelStyle === 'alpha') {
      let n = num,
        s = '';
      while (n > 0) {
        n--;
        s = String.fromCharCode(65 + (n % 26)) + s;
        n = Math.floor(n / 26);
      }
      return s;
    }
    return String(num);
  }

  function rebuild(): void {
    const { items, warnings } = parseInput(rawInput);
    setMessage(warnings.join('\n'));
    const { grid, placements } = buildCrossword(items.filter((it) => it.hira));
    setGrid(grid);
    setPlacements(placements);
    setBounds(computeBounds(grid));
    setClueNums(computeClueNumbers(placements, grid));
    // レイアウト変化時は特別マスをリセット
    setSelectedCells(new Set());
  }

  React.useEffect(() => {
    rebuild();
  }, []);

  // ==== Special cells ====
  const selectedLetters = React.useMemo<string[]>(() => {
    const arr: string[] = [];
    for (const k of selectedCells) {
      const c = grid.get(k);
      if (c) arr.push(c.ch);
    }
    return arr;
  }, [selectedCells, grid]);

  function toggleCellSpecial(k: string): void {
    setSelectedCells((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  // ==== Tests ====
  function runTests(): void {
    const results: Array<{ name: string; pass: boolean }> = [];
    // 1) 入力形式と全角＝の正規化
    {
      const t = '視点=してん\n海底＝かいてい\n教科書（きょうかしょ）';
      const { items } = parseInput(t);
      const pass = items.length === 3 && items[0].hira === 'してん' && items[1].hira === 'かいてい' && items[2].hira === 'きょうかしょ';
      results.push({ name: 'parse: 入力形式/全角＝対応', pass });
    }
    // 2) カタカナ→ひらがな
    {
      const pass = toHiragana('カタカナ') === 'かたかな';
      results.push({ name: 'toHiragana 基本', pass });
    }
    // 3) 交差: すな × あな が交差する
    {
      const words: Item[] = [
        { id: 'w0', kanji: '砂', hira: 'すな' },
        { id: 'w1', kanji: '穴', hira: 'あな' },
        { id: 'w2', kanji: '視点', hira: 'してん' }
      ];
      const { grid: g } = buildCrossword(words);
      let overlap = false;
      g.forEach((c) => {
        const ids = new Set(c.words.map((w) => w.id));
        if (ids.has('w0') && ids.has('w1')) overlap = true;
      });
      results.push({ name: '交差: すな×あな', pass: overlap });
    }
    // 4) 独立配置: してん は他と交差しない（この例では）
    {
      const words: Item[] = [
        { id: 'w0', kanji: '砂', hira: 'すな' },
        { id: 'w1', kanji: '穴', hira: 'あな' },
        { id: 'w2', kanji: '視点', hira: 'してん' }
      ];
      const { grid: g } = buildCrossword(words);
      let w2Overlap = false;
      g.forEach((c) => {
        const ids = new Set(c.words.map((w) => w.id));
        if (ids.has('w2') && (ids.has('w0') || ids.has('w1'))) w2Overlap = true;
      });
      results.push({ name: '独立配置: してん', pass: !w2Overlap });
    }
    // 5) ラベル A,B,...,Z,AA の生成
    {
      const conv = (n: number) => {
        let s = '';
        let nn = n;
        while (nn > 0) {
          nn--;
          s = String.fromCharCode(65 + (nn % 26)) + s;
          nn = Math.floor(nn / 26);
        }
        return s;
      };
      const pass = [1, 2, 26, 27, 28].map(conv).join(',') === ['A', 'B', 'Z', 'AA', 'AB'].join(',');
      results.push({ name: 'ラベル A,B... 検証', pass });
    }
    // 6) スペース区切り入力のサポート
    {
      const t = '海底 かいてい\n教科書 きょうかしょ';
      const { items } = parseInput(t);
      const pass = items.length === 2 && items[0].hira === 'かいてい' && items[1].hira === 'きょうかしょ';
      results.push({ name: 'parse: スペース区切り', pass });
    }
    setTestResults(results);
  }

  // ==== Render helpers ====
  const width = Math.max(1, bounds.maxX - bounds.minX + 1);
  const height = Math.max(1, bounds.maxY - bounds.minY + 1);
  const cellSize = 36;

  const startNumByCell = new Map<string, number>();
  placements.forEach((p) => {
    const k = keyOf(p.startX, p.startY);
    const num = clueNums[p.id];
    if (num) startNumByCell.set(k, num);
  });

  function GridView({ showLetters, allowSelect }: { showLetters: boolean; allowSelect: boolean }): React.ReactElement {
    return (
      <div className='relative inline-block'>
        <div
          className='bg-white rounded-md shadow border overflow-hidden'
          style={{ width: width * cellSize, height: height * cellSize }}
        >
          {Array.from({ length: height }).map((_, ry) => (
            <div key={ry} className='flex'>
              {Array.from({ length: width }).map((_, rx) => {
                const x = bounds.minX + rx,
                  y = bounds.minY + ry;
                const k = keyOf(x, y);
                const cell = grid.get(k);
                const has = !!cell;
                const isSpecial = selectedCells.has(k);
                return (
                  <div
                    key={rx}
                    onClick={() => allowSelect && has && toggleCellSpecial(k)}
                    className={`relative flex items-center justify-center select-none ${
                      allowSelect && has ? 'cursor-pointer' : ''
                    }`}
                    style={{
                      width: cellSize,
                      height: cellSize,
                      borderRight: '1px solid #cbd5e1',
                      borderBottom: '1px solid #cbd5e1',
                      background: has ? '#fff' : '#e5e7eb'
                    }}
                  >
                    {startNumByCell.has(k) && (
                      <div className='absolute top-0.5 left-1 text-[10px] text-gray-500'>
                        {labelFromNumber(startNumByCell.get(k)!)}
                      </div>
                    )}
                    {has && (
                      <div
                        className={`text-lg ${isSpecial ? 'font-extrabold' : 'font-medium'} ${
                          showLetters ? 'text-gray-900' : 'text-transparent'
                        }`}
                      >
                        {cell!.ch}
                      </div>
                    )}
                    {has && isSpecial && (
                      <div className='pointer-events-none absolute inset-0 border-4 border-rose-500 rounded-[6px]' />
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          <div
            className='pointer-events-none absolute inset-0'
            style={{ borderTop: '1px solid #cbd5e1', borderLeft: '1px solid #cbd5e1' }}
          />
        </div>
      </div>
    );
  }

  function ClueList(): React.ReactElement {
    const across = placements
      .filter((p) => p.dir === 'across')
      .sort((a, b) => (clueNums[a.id] || 0) - (clueNums[b.id] || 0));
    const down = placements
      .filter((p) => p.dir === 'down')
      .sort((a, b) => (clueNums[a.id] || 0) - (clueNums[b.id] || 0));
    return (
      <div className='grid grid-cols-1 md:grid-cols-2 gap-4 mt-3'>
        <div className='bg-white rounded-md border p-3'>
          <div className='font-bold mb-1'>よこ（Across）</div>
          <ul className='space-y-1'>
            {across.map((p) => (
              <li key={p.id}>
                <span className='font-semibold mr-1'>{labelFromNumber(clueNums[p.id])}.</span>
                {p.kanji}
              </li>
            ))}
            {!across.length && <li className='text-gray-500'>（なし）</li>}
          </ul>
        </div>
        <div className='bg-white rounded-md border p-3'>
          <div className='font-bold mb-1'>たて（Down）</div>
          <ul className='space-y-1'>
            {down.map((p) => (
              <li key={p.id}>
                <span className='font-semibold mr-1'>{labelFromNumber(clueNums[p.id])}.</span>
                {p.kanji}
              </li>
            ))}
            {!down.length && <li className='text-gray-500'>（なし）</li>}
          </ul>
        </div>
      </div>
    );
  }

  // ==== UI ====
  const exampleText = '視点=してん\n海底＝かいてい\n教科書＝きょうかしょ';
  const examplePrompt = '公園の遊具になるように並び替えよう';
  const exampleAnswer = 'うんてい';

  function handlePrint(): void { window.print(); }

  return (
    <div className='p-4 print:p-0'>
      {/* 印刷用グローバルCSS */}
      <style jsx global>{`
        @media print {
          @page { size: A4; margin: 12mm; }
          html, body { margin: 0 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .no-print, .screen-root { display: none !important; }
          .print-root { display: block !important; }

          /* デフォルトは改ページしない */
          .print-page { page-break-after: auto; break-after: auto; margin: 0; padding: 0; }

          /* 最後以外のページだけ改ページを強制 */
          .print-page:not(:last-child) { 
            page-break-after: always !important; 
            break-after: page !important; 
          }
        }

        @media screen {
          .print-root { display: none; }
        }
      `}</style>

      {/* ===== 画面表示（タブ） ===== */}
      <div className='screen-root'>
        {/* ツールバー */}
        <div className='flex gap-2 mb-4'>
          <button onClick={() => setTab('input')} className={`px-3 py-1 border rounded ${tab === 'input' ? 'bg-indigo-600 text-white' : 'bg-white'}`}>問題＆解答設定</button>
          <button onClick={() => setTab('puzzle')} className={`px-3 py-1 border rounded ${tab === 'puzzle' ? 'bg-indigo-600 text-white' : 'bg-white'}`}>クロスワード（問題用）</button>
          <button onClick={() => setTab('answer')} className={`px-3 py-1 border rounded ${tab === 'answer' ? 'bg-indigo-600 text-white' : 'bg-white'}`}>クロスワード（解答用）</button>

          {tab === 'input' ? (
            <div className='flex items-center gap-2 ml-auto'>
              <button
                onClick={() => { setTitle('よみクロスワード'); setRawInput(''); setPuzzlePrompt(''); setPuzzleAnswer(''); }}
                className='px-3 py-1.5 border rounded'>クリア</button>
              <button
                onClick={() => { setTitle('よみクロスワード（例）'); setRawInput(exampleText); setPuzzlePrompt(examplePrompt); setPuzzleAnswer(exampleAnswer); }}
                className='px-3 py-1.5 border rounded'>例</button>
            </div>
          ) : (<div className='ml-auto' />)}

          <div className='flex items-center gap-2'>
            <button onClick={handlePrint} className='px-3 py-1.5 bg-green-600 text-white rounded'>印刷（問題→解答 2ページ）</button>
          </div>

          <div className='flex items-center gap-2'>
            <label className='text-sm'>ラベル</label>
            <select className='border rounded px-2 py-1' value={labelStyle} onChange={(e) => setLabelStyle(e.target.value as 'numeric' | 'alpha')}>
              <option value='numeric'>1,2,3...</option>
              <option value='alpha'>A,B,C...</option>
            </select>
          </div>
        </div>

        {/* タブ本体 */}
        {tab === 'input' && (
          <div>
            <div className='mb-2'>
              <h1 className='text-xl font-bold'>問題＆解答設定</h1>
            </div>

            {/* クロスワード名 */}
            <div className='mb-3'>
              <label className='block text-sm font-semibold mb-1'>クロスワード名</label>
              <div className='flex gap-2'>
                <input className='flex-1 border rounded px-2 py-1' value={title} onChange={(e) => setTitle(e.target.value)} placeholder='例：よみクロスワード' />
                <button type='button' className='px-3 py-1.5 border rounded' onClick={() => setTitle('よみクロスワード')} title='既定値に戻す'>既定に戻す</button>
              </div>
            </div>

            <textarea className='w-full h-40 border p-2 font-mono' value={rawInput} onChange={(e) => setRawInput(e.target.value)} />
            <div className='mt-2 flex gap-2 items-center'>
              <button onClick={rebuild} className='px-4 py-2 bg-blue-600 text-white rounded'>クロス生成</button>
              <button onClick={runTests} className='px-3 py-2 bg-violet-600 text-white rounded'>検証を実行</button>
              <div className='text-sm text-gray-600'>形式：漢字=かな ／ 漢字 かな ／ 漢字（かな）</div>
            </div>
            {message && <div className='mt-2 text-sm text-amber-700 whitespace-pre-wrap'>{message}</div>}

            {/* 特別マス選択・問題文設定 */}
            <div className='mt-6 grid grid-cols-1 md:grid-cols-2 gap-4'>
              <div>
                <div className='font-semibold mb-2'>特別マスの選択</div>
                <div className='text-sm text-gray-600 mb-2'>盤面のセルをクリックでトグル選択（上限なし）。</div>
                <GridView showLetters={true} allowSelect={true} />
              </div>
              <div className='bg-white border rounded p-3 space-y-3'>
                <div>
                  <div className='font-semibold'>並び替えの問題文（問題タブに表示）</div>
                  <textarea className='mt-1 w-full border rounded px-2 py-1' rows={3} value={puzzlePrompt} onChange={(e) => setPuzzlePrompt(e.target.value)} placeholder='例：公園の遊具になるように並び替えよう' />
                </div>
                <div>
                  <div className='font-semibold'>模範解答（任意・解答タブに表示）</div>
                  <input className='mt-1 w-full border rounded px-2 py-1' value={puzzleAnswer} onChange={(e) => setPuzzleAnswer(e.target.value)} placeholder='例：うんてい' />
                </div>
                <div className='text-sm'>
                  選択文字（参考）：
                  <div className='mt-1 font-mono tracking-widest'>{selectedLetters.join(' ') || '（未選択）'}</div>
                  <div className='mt-1 text-xs text-gray-600'>※ 問題タブでは文字は表示されません（赤枠だけ表示）。</div>
                </div>
                <div>
                  <button onClick={() => setSelectedCells(new Set())} className='px-3 py-1.5 rounded border'>特別マスを全解除</button>
                </div>
              </div>
            </div>
          </div>
        )}

        {tab === 'puzzle' && (
          <div>
            <h1 className='text-xl font-bold mb-2'>{title}（問題用）</h1>
            <GridView showLetters={false} allowSelect={false} />
            <ClueList />
            <div className='mt-4 font-bold'>太四角の並び替え問題（以下にあてはまる言葉を作ってね）</div>
            <div className='text-sm text-gray-800 whitespace-pre-wrap'>{puzzlePrompt || '（講師が問題文を入力）'}</div>
            <div className='mt-2 flex gap-1'>
              {Array.from({ length: selectedLetters.length || 5 }).map((_, i) => (
                <div key={i} className='w-9 h-9 border-4 border-rose-500 rounded-md'></div>
              ))}
            </div>
          </div>
        )}

        {tab === 'answer' && (
          <div>
            <h1 className='text-xl font-bold mb-2'>{title}（解答用）</h1>
            <GridView showLetters={true} allowSelect={false} />
            <ClueList />

            <div className='mt-4 bg-white border rounded p-3 space-y-3'>
              <div>
                <div className='mt-4 font-bold'>並び替え問題文</div>
                <div className='text-sm text-gray-800 whitespace-pre-wrap'>
                  {puzzlePrompt || '（講師が問題文を入力）'}
                </div>
              </div>
              {Boolean(puzzleAnswer) && (
                <div>
                  <div className='font-bold'>すべての文字</div>
                  <AnswerBoxes letters={selectedLetters} />
                </div>
              )}
              <div>
                <div className='font-bold'>模範解答</div>
                {puzzleAnswer ? (
                  <AnswerBoxes letters={Array.from(puzzleAnswer)} />
                ) : (
                  <AnswerBoxes letters={selectedLetters} />
                )}
              </div>
            </div>
          </div>
        )}
      </div>{/* /screen-root */}

      {/* ===== 印刷用（常にDOMに置き、印刷時だけ表示） ===== */}
      <div className='print-root'>
        {/* ページ1: 問題用 */}
        <div className='print-page'>
          <h1 className='text-xl font-bold mb-2'>{title}（問題用）</h1>
          <GridView showLetters={false} allowSelect={false} />
          <ClueList />
          <div className='mt-4 font-bold'>太四角の並び替え問題（以下にあてはまる言葉を作ってね）</div>
          <div className='text-sm text-gray-800 whitespace-pre-wrap'>{puzzlePrompt || '（講師が問題文を入力）'}</div>
          <div className='mt-2 flex gap-1'>
            {Array.from({ length: selectedLetters.length || 5 }).map((_, i) => (
              <div key={i} className='w-9 h-9 border-4 border-rose-500 rounded-md'></div>
            ))}
          </div>
        </div>

        {/* ページ2: 解答用 */}
        <div className='print-page'>
          <h1 className='text-xl font-bold mb-2'>{title}（解答用）</h1>
          <GridView showLetters={true} allowSelect={false} />
          <ClueList />
          <div className='mt-4 bg-white border rounded p-3 space-y-3'>
            <div>
              <div className='mt-4 font-bold'>並び替え問題文</div>
              <div className='text-sm text-gray-800 whitespace-pre-wrap'>
                {puzzlePrompt || '（講師が問題文を入力）'}
              </div>
            </div>
            {Boolean(puzzleAnswer) && (
              <div>
                <div className='font-bold'>すべての文字</div>
                <AnswerBoxes letters={selectedLetters} />
              </div>
            )}
            <div>
              <div className='font-bold'>模範解答</div>
              {puzzleAnswer ? (
                <AnswerBoxes letters={Array.from(puzzleAnswer)} />
              ) : (
                <AnswerBoxes letters={selectedLetters} />
              )}
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}
