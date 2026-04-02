'use strict';
/* ═══════════════════════════════════════════════════════════
   SYS://CORRUPT — app.js
   ─────────────────────────────────────────────────────────
   Architecture:
     §1  Config & state
     §2  Utility helpers
     §3  Corruption engine   (visual + control degradation)
     §4  Puzzle definitions  (3 types: Math, Sequence, Pattern)
     §5  Puzzle renderer     (builds DOM for each puzzle type)
     §6  Control system      (swappable action buttons)
     §7  Game log
     §8  HUD updater
     §9  Glitch overlay generator
     §10 Screen manager
     §11 Game controller     (init, loop, win/lose)
═══════════════════════════════════════════════════════════ */

/* ═══ §1  CONFIG & STATE ═══════════════════════════════ */

const CFG = {
  TOTAL_PUZZLES     : 8,          // puzzles to win
  BASE_CORRUPTION   : 0.008,      // integrity lost per second at level 1
  CORRUPTION_SCALE  : 1.22,       // multiplier per completed puzzle
  SWAP_INTERVAL_MIN : 8000,       // ms between first control swap
  SWAP_INTERVAL_DEC : 900,        // ms reduction per corruption level
  INVERT_THRESHOLD  : 0.55,       // integrity below which random invert happens
  GLITCH_TEXT_COUNT : 6,          // artifact strings in overlay
  PUZZLE_BONUS      : 500,        // score per puzzle
  TIME_BONUS_PER_S  : 3,          // score per remaining second on each puzzle
  PUZZLE_TIME       : 30,         // seconds per puzzle
};

const STATE = {
  screen        : 'title',      // title | game | gameover | victory
  integrity     : 1.0,          // 0–1
  corruptionRate: CFG.BASE_CORRUPTION,
  corruptionLevel: 0,           // 0-4 visual tier
  puzzleIndex   : 0,
  score         : 0,
  elapsed       : 0,            // total seconds
  puzzleTimer   : 0,            // seconds remaining this puzzle
  swapMap       : {},           // action → remapped action
  swappedKeys   : new Set(),    // which actions are swapped
  invertActive  : false,
  paused        : false,
  lastTs        : 0,
  // current puzzle state (filled by puzzle loader)
  puzzle        : null,
};

/* ═══ §2  UTILITIES ════════════════════════════════════ */

const rand    = (min, max) => Math.random() * (max - min) + min;
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const pick    = arr => arr[randInt(0, arr.length - 1)];
const shuffle = arr => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmt2  = n => String(n).padStart(2, '0');
const fmtTime = s => `${fmt2(Math.floor(s / 60))}:${fmt2(s % 60)}`;

/* ═══ §3  CORRUPTION ENGINE ════════════════════════════ */

const Corruption = (() => {

  // Glitch art character pool
  const GLITCH_CHARS = '█▓▒░╔╗╝╚╠╣╦╩╬│─┼XZERROR404SYS_FAIL■□▪▫◆◇○●';
  const ERROR_STRINGS = [
    'SEGFAULT', 'OVERFLOW', 'NULL_REF', 'CORRUPT',
    'ERR_0x4F', 'MEMFAIL', 'KERNEL_PANIC', 'STACK_SMH',
    'WATCHDOG', 'BAD_ALLOC', 'ABORT()', 'SIGSEGV',
  ];

  let swapTimer   = 0;
  let swapInterval = CFG.SWAP_INTERVAL_MIN;
  let glitchTimer  = 0;
  let invertTimer  = 0;

  /** Recalculate visual corruption level (0-4) from integrity */
  function calcLevel(integrity) {
    if (integrity > 0.80) return 0;
    if (integrity > 0.60) return 1;
    if (integrity > 0.40) return 2;
    if (integrity > 0.20) return 3;
    return 4;
  }

  /** Apply corruption level CSS class to body */
  function applyLevel(level) {
    for (let i = 0; i <= 4; i++) document.body.classList.remove(`corr-${i}`);
    if (level > 0) document.body.classList.add(`corr-${level}`);
    STATE.corruptionLevel = level;
  }

  /** Randomly swap two control actions */
  function swapControls() {
    const actions = ControlSystem.getActionKeys();
    if (actions.length < 2) return;

    // Pick two distinct actions to swap
    const idxA = randInt(0, actions.length - 1);
    let   idxB = randInt(0, actions.length - 2);
    if (idxB >= idxA) idxB++;

    const a = actions[idxA], b = actions[idxB];

    // Build swap: pressing A triggers B's action and vice versa
    STATE.swapMap[a] = b;
    STATE.swapMap[b] = a;
    STATE.swappedKeys.add(a);
    STATE.swappedKeys.add(b);

    ControlSystem.markSwapped([a, b]);
    GameLog.warn(`CTRL REMAP: [${a.toUpperCase()}] ↔ [${b.toUpperCase()}]`);
  }

  /** Generate random glitch text artifacts */
  function spawnGlitchText() {
    const overlay = document.getElementById('glitch-overlay');
    overlay.innerHTML = '';
    const count = Math.floor(rand(1, CFG.GLITCH_TEXT_COUNT * STATE.corruptionLevel * 0.5 + 1));
    for (let i = 0; i < count; i++) {
      const span = document.createElement('div');
      span.style.cssText = `
        position:absolute;
        left:${rand(0, 90)}%;
        top:${rand(0, 90)}%;
        font-size:${rand(10, 22)}px;
        opacity:${rand(0.2, 0.7)};
        transform:rotate(${rand(-5,5)}deg);
        color:rgba(${rand(0,255)|0},${rand(0,80)|0},${rand(0,80)|0},0.7);
        pointer-events:none;
        white-space:nowrap;
      `;
      // Mix error string + random glitch chars
      let txt = Math.random() < 0.5
        ? pick(ERROR_STRINGS)
        : Array.from({length: randInt(4,12)}, () => GLITCH_CHARS[randInt(0, GLITCH_CHARS.length-1)]).join('');
      span.textContent = txt;
      overlay.appendChild(span);
    }
    // Clear after short flicker
    setTimeout(() => { if (overlay) overlay.innerHTML = ''; }, rand(80, 300));
  }

  /** Randomly invert the screen briefly */
  function triggerInvert() {
    if (STATE.invertActive) return;
    STATE.invertActive = true;
    document.body.classList.add('invert-mode');
    GameLog.err('COLOR MATRIX INVERTED');
    setTimeout(() => {
      document.body.classList.remove('invert-mode');
      STATE.invertActive = false;
    }, rand(600, 2400));
  }

  /** Full CSS variable update every frame */
  function updateCSS() {
    const c = 1 - STATE.integrity;
    document.documentElement.style.setProperty('--corr', c.toFixed(3));

    // Integrity bar colours
    const fill = document.getElementById('int-fill');
    const val  = document.getElementById('int-val');
    const pct  = Math.round(STATE.integrity * 100);
    if (fill) {
      fill.style.width = pct + '%';
      if (STATE.integrity > 0.6) {
        fill.style.background = 'var(--green)';
        fill.style.boxShadow  = '0 0 6px var(--green)';
      } else if (STATE.integrity > 0.35) {
        fill.style.background = 'var(--amber)';
        fill.style.boxShadow  = '0 0 6px var(--amber)';
      } else {
        fill.style.background = 'var(--red)';
        fill.style.boxShadow  = '0 0 8px var(--red)';
      }
    }
    if (val) val.textContent = pct + '%';

    // Title screen bar too
    const tf = document.getElementById('title-integrity');
    const tp = document.getElementById('title-pct');
    if (tf) tf.style.width = pct + '%';
    if (tp) tp.textContent = pct + '%';
  }

  /** Called each frame with delta seconds */
  function tick(dt) {
    if (STATE.screen !== 'game') return;

    // Drain integrity
    STATE.integrity -= STATE.corruptionRate * dt;
    STATE.integrity  = clamp(STATE.integrity, 0, 1);

    updateCSS();

    const level = calcLevel(STATE.integrity);
    if (level !== STATE.corruptionLevel) {
      applyLevel(level);
      if (level > 0) {
        document.getElementById('corruption-banner').classList.remove('hidden');
        GameLog.err(`CORRUPTION LEVEL ${level} — SYSTEM DESTABILISING`);
      }
    }

    // Control swap timer
    swapTimer += dt * 1000;
    swapInterval = Math.max(2500, CFG.SWAP_INTERVAL_MIN - STATE.corruptionLevel * CFG.SWAP_INTERVAL_DEC);
    if (swapTimer >= swapInterval && STATE.corruptionLevel >= 1) {
      swapTimer = 0;
      swapControls();
    }

    // Glitch text timer
    if (STATE.corruptionLevel >= 2) {
      glitchTimer += dt;
      const glitchRate = 0.4 + STATE.corruptionLevel * 0.6;
      if (glitchTimer >= 1 / glitchRate) {
        glitchTimer = 0;
        spawnGlitchText();
      }
    }

    // Random invert
    if (STATE.integrity < CFG.INVERT_THRESHOLD && STATE.corruptionLevel >= 3) {
      invertTimer += dt;
      if (invertTimer >= rand(5, 12)) {
        invertTimer = 0;
        triggerInvert();
      }
    }

    // Puzzle timer
    STATE.puzzleTimer -= dt;
    if (STATE.puzzleTimer <= 0) {
      STATE.puzzleTimer = 0;
      GameLog.err('TIMEOUT — PUZZLE FAILED — INTEGRITY PENALTY');
      STATE.integrity -= 0.12;
      PuzzleLoader.load(STATE.puzzleIndex); // reload same puzzle
    }
  }

  function reset() {
    swapTimer   = 0;
    glitchTimer = 0;
    invertTimer = 0;
    swapInterval = CFG.SWAP_INTERVAL_MIN;
    STATE.swapMap   = {};
    STATE.swappedKeys.clear();
    document.getElementById('glitch-overlay').innerHTML = '';
    document.body.classList.remove('invert-mode');
    STATE.invertActive = false;
    for (let i = 0; i <= 4; i++) document.body.classList.remove(`corr-${i}`);
    STATE.corruptionLevel = 0;
    document.getElementById('corruption-banner').classList.add('hidden');
    updateCSS();
  }

  return { tick, reset, updateCSS };
})();

/* ═══ §4  PUZZLE DEFINITIONS ═══════════════════════════ */
/*
   Three puzzle types, procedurally generated:
     MATH     — pick the correct answer from 4 choices
     SEQUENCE — arrange scrambled numbers in ascending order
     PATTERN  — toggle cells to match a target pattern
*/

const PuzzleDefs = (() => {

  /* ── MATH ── */
  function makeMath(index) {
    const ops   = ['+', '-', '*'];
    const op    = ops[index % 3];
    let a, b, answer;

    if (op === '+') {
      a = randInt(10, 60 + index * 4);
      b = randInt(10, 60 + index * 4);
      answer = a + b;
    } else if (op === '-') {
      a = randInt(30, 90 + index * 4);
      b = randInt(10, a);
      answer = a - b;
    } else {
      a = randInt(2, 9 + Math.floor(index / 2));
      b = randInt(2, 9 + Math.floor(index / 2));
      answer = a * b;
    }

    // Generate 3 wrong choices near the answer
    const wrongs = new Set();
    while (wrongs.size < 3) {
      const w = answer + pick([-3,-2,-1,1,2,3,5,-5,7,-7,10,-10]);
      if (w !== answer && w > 0) wrongs.add(w);
    }

    const choices = shuffle([answer, ...wrongs]);

    return {
      type    : 'MATH',
      id      : `CALC_${String(index + 1).padStart(4,'0')}`,
      question: `${a} ${op} ${b} = ?`,
      answer,
      choices,
      hint    : `Solve the arithmetic. Select the correct result.`,
      actions : choices.map((c, i) => ({ label: String(c), action: `choice_${i}`, value: c })),
    };
  }

  /* ── SEQUENCE ── */
  function makeSequence(index) {
    const len    = 4 + Math.min(index, 3);         // 4–7 items
    const start  = randInt(1, 20 + index * 3);
    const step   = randInt(1, 5 + Math.floor(index / 2));
    const correct = Array.from({length: len}, (_, i) => start + i * step);
    const scrambled = shuffle([...correct]);

    return {
      type     : 'SEQUENCE',
      id       : `SEQ_${String(index + 1).padStart(4,'0')}`,
      correct,
      scrambled,
      current  : Array(len).fill(null), // player's arrangement
      hint     : `Arrange the numbers in ascending order.`,
      actions  : [],          // dynamically created by renderer
    };
  }

  /* ── PATTERN ── */
  function makePattern(index) {
    const size   = 3 + (index >= 4 ? 1 : 0);  // 3×3 or 4×4
    const cells  = size * size;
    const onCount = Math.floor(cells * rand(0.3, 0.55));
    const target = Array.from({length: cells}, (_, i) => i < onCount);
    shuffle(target); // in-place shuffle the booleans

    return {
      type   : 'PATTERN',
      id     : `PAT_${String(index + 1).padStart(4,'0')}`,
      size,
      target,
      current: Array(cells).fill(false),
      hint   : `Toggle cells to match the target pattern. Green = active.`,
      actions: [],
    };
  }

  function generate(index) {
    const type = ['MATH','SEQUENCE','PATTERN'][index % 3];
    if (type === 'MATH')     return makeMath(index);
    if (type === 'SEQUENCE') return makeSequence(index);
    return makePattern(index);
  }

  return { generate };
})();

/* ═══ §5  PUZZLE RENDERER ═══════════════════════════════ */

const PuzzleRenderer = (() => {

  function clear() {
    document.getElementById('puzzle-body').innerHTML = '';
  }

  /* ── MATH renderer ── */
  function renderMath(puzzle) {
    const body = document.getElementById('puzzle-body');
    body.innerHTML = '';

    const disp = document.createElement('div');
    disp.className = 'math-display pop-in';
    disp.textContent = puzzle.question;
    body.appendChild(disp);

    const grid = document.createElement('div');
    grid.className = 'math-choices';
    body.appendChild(grid);

    puzzle.choices.forEach((val, i) => {
      const btn = document.createElement('button');
      btn.className  = 'math-choice';
      btn.textContent = val;
      btn.dataset.action = `choice_${i}`;
      btn.addEventListener('click', () => ControlSystem.fireAction(`choice_${i}`));
      grid.appendChild(btn);
    });

    document.getElementById('puzzle-hint').textContent = puzzle.hint;
  }

  /* ── SEQUENCE renderer ── */
  function renderSequence(puzzle) {
    const body = document.getElementById('puzzle-body');
    body.innerHTML = '';

    // Source pool
    const poolLabel = document.createElement('div');
    poolLabel.className = 'puzzle-label';
    poolLabel.textContent = '▸ AVAILABLE';
    body.appendChild(poolLabel);

    const pool = document.createElement('div');
    pool.className = 'seq-display';
    pool.id = 'seq-pool';
    body.appendChild(pool);

    // Answer slots
    const ansLabel = document.createElement('div');
    ansLabel.className = 'puzzle-label';
    ansLabel.textContent = '▸ ARRANGE IN ORDER';
    body.appendChild(ansLabel);

    const answer = document.createElement('div');
    answer.className = 'seq-answer';
    answer.id = 'seq-answer';
    body.appendChild(answer);

    puzzle._selectedIdx = null;  // index in scrambled array currently selected

    function rebuildPool() {
      pool.innerHTML = '';
      puzzle.scrambled.forEach((val, i) => {
        if (puzzle._placed && puzzle._placed.has(i)) return;
        const cell = document.createElement('div');
        cell.className = 'seq-cell';
        cell.textContent = val;
        cell.dataset.poolIdx = i;
        cell.addEventListener('click', () => {
          if (puzzle._selectedIdx === i) {
            // deselect
            puzzle._selectedIdx = null;
            rebuildPool();
          } else {
            puzzle._selectedIdx = i;
            rebuildPool();
            GameLog.log(`Selected: ${val}`);
          }
        });
        if (puzzle._selectedIdx === i) cell.classList.add('selected');
        pool.appendChild(cell);
      });
    }

    function rebuildSlots() {
      answer.innerHTML = '';
      for (let s = 0; s < puzzle.correct.length; s++) {
        const slot = document.createElement('div');
        slot.className = 'seq-slot';
        slot.dataset.slot = s;
        if (puzzle.current[s] !== null) {
          slot.textContent = puzzle.current[s];
          slot.classList.add('filled');
        } else {
          slot.textContent = '_';
        }
        slot.addEventListener('click', () => {
          // If something selected in pool, place it here
          if (puzzle._selectedIdx !== null && puzzle.current[s] === null) {
            puzzle.current[s] = puzzle.scrambled[puzzle._selectedIdx];
            if (!puzzle._placed) puzzle._placed = new Set();
            puzzle._placed.add(puzzle._selectedIdx);
            puzzle._selectedIdx = null;
            rebuildPool();
            rebuildSlots();
            checkSequence(puzzle);
          } else if (puzzle.current[s] !== null) {
            // Remove from slot — return to pool
            const placedVal = puzzle.current[s];
            // Find the index in scrambled
            for (const [idx, v] of puzzle.scrambled.entries()) {
              if (v === placedVal && puzzle._placed && puzzle._placed.has(idx)) {
                puzzle._placed.delete(idx);
                break;
              }
            }
            puzzle.current[s] = null;
            rebuildPool();
            rebuildSlots();
          }
        });
        answer.appendChild(slot);
      }
    }

    if (!puzzle._placed) puzzle._placed = new Set();
    rebuildPool();
    rebuildSlots();
    document.getElementById('puzzle-hint').textContent = puzzle.hint;
  }

  function checkSequence(puzzle) {
    const filled = puzzle.current.filter(v => v !== null);
    if (filled.length < puzzle.correct.length) return;

    const correct = puzzle.current.every((v, i) => v === puzzle.correct[i]);
    if (correct) {
      GameController.onPuzzleSolved();
    } else {
      // Shake and reset
      document.getElementById('seq-answer').classList.add('shake');
      setTimeout(() => {
        document.getElementById('seq-answer')?.classList.remove('shake');
        puzzle.current = Array(puzzle.correct.length).fill(null);
        puzzle._placed = new Set();
        puzzle._selectedIdx = null;
        STATE.integrity -= 0.04;
        GameLog.warn('WRONG SEQUENCE — INTEGRITY PENALTY');
        renderSequence(puzzle);
      }, 400);
    }
  }

  /* ── PATTERN renderer ── */
  function renderPattern(puzzle) {
    const body = document.getElementById('puzzle-body');
    body.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;gap:24px;align-items:flex-start;justify-content:center;flex-wrap:wrap;';
    body.appendChild(wrap);

    // Target display
    const targetWrap = document.createElement('div');
    targetWrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px;';

    const tLabel = document.createElement('div');
    tLabel.className = 'puzzle-label';
    tLabel.textContent = '▸ TARGET';
    targetWrap.appendChild(tLabel);

    const tGrid = document.createElement('div');
    tGrid.className = 'pattern-grid';
    tGrid.style.gridTemplateColumns = `repeat(${puzzle.size}, 46px)`;
    puzzle.target.forEach(on => {
      const cell = document.createElement('div');
      cell.className = 'pat-cell locked' + (on ? ' on' : '');
      tGrid.appendChild(cell);
    });
    targetWrap.appendChild(tGrid);
    wrap.appendChild(targetWrap);

    // Player grid
    const playerWrap = document.createElement('div');
    playerWrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px;';

    const pLabel = document.createElement('div');
    pLabel.className = 'puzzle-label';
    pLabel.textContent = '▸ YOUR INPUT';
    playerWrap.appendChild(pLabel);

    const pGrid = document.createElement('div');
    pGrid.className = 'pattern-grid';
    pGrid.id = 'player-pattern';
    pGrid.style.gridTemplateColumns = `repeat(${puzzle.size}, 46px)`;

    puzzle.current.forEach((on, i) => {
      const cell = document.createElement('div');
      cell.className = 'pat-cell' + (on ? ' on' : '');
      cell.dataset.idx = i;
      cell.addEventListener('click', () => {
        puzzle.current[i] = !puzzle.current[i];
        cell.classList.toggle('on', puzzle.current[i]);
        checkPattern(puzzle);
      });
      pGrid.appendChild(cell);
    });
    playerWrap.appendChild(pGrid);
    wrap.appendChild(playerWrap);

    document.getElementById('puzzle-hint').textContent = puzzle.hint;
  }

  function checkPattern(puzzle) {
    const match = puzzle.current.every((v, i) => v === puzzle.target[i]);
    if (match) GameController.onPuzzleSolved();
  }

  /* ── Dispatch ── */
  function render(puzzle) {
    clear();
    document.getElementById('puzzle-id').textContent   = puzzle.id;
    document.getElementById('puzzle-type').textContent = puzzle.type;

    if (puzzle.type === 'MATH')     renderMath(puzzle);
    if (puzzle.type === 'SEQUENCE') renderSequence(puzzle);
    if (puzzle.type === 'PATTERN')  renderPattern(puzzle);
  }

  return { render };
})();

/* ═══ §6  PUZZLE LOADER ════════════════════════════════ */

const PuzzleLoader = (() => {
  function load(index) {
    STATE.puzzle      = PuzzleDefs.generate(index);
    STATE.puzzleTimer = CFG.PUZZLE_TIME;
    STATE.swapMap     = {};
    STATE.swappedKeys.clear();

    PuzzleRenderer.render(STATE.puzzle);
    ControlSystem.build(STATE.puzzle);

    const lvlTag = document.getElementById('level-tag');
    if (lvlTag) lvlTag.textContent = `PUZZLE ${index + 1}/${CFG.TOTAL_PUZZLES}`;

    GameLog.ok(`PROC [${STATE.puzzle.id}] LOADED — TYPE:${STATE.puzzle.type}`);
  }
  return { load };
})();

/* ═══ §7  CONTROL SYSTEM ═══════════════════════════════ */
/*
   Builds action buttons in the sidebar.
   When corruption hits, button labels get swapped —
   pressing "A" might fire action "B" and vice versa.
   The player must figure out what each button now does.
*/

const ControlSystem = (() => {

  // Maps action string → handler function
  const _handlers = {};

  // Current button elements: action → element
  const _buttons = {};

  function getActionKeys() {
    return Object.keys(_handlers);
  }

  function build(puzzle) {
    const grid = document.getElementById('ctrl-grid');
    grid.innerHTML = '';
    Object.keys(_handlers).forEach(k => delete _handlers[k]);
    Object.keys(_buttons).forEach(k => delete _buttons[k]);

    if (puzzle.type === 'MATH') {
      puzzle.choices.forEach((val, i) => {
        const action = `choice_${i}`;
        const btn = makeBtn(grid, String(val), action);
        _handlers[action] = () => handleMathChoice(puzzle, val);
        _buttons[action]  = btn;
      });
    }

    if (puzzle.type === 'SEQUENCE') {
      // Controls not really needed here — interaction is direct click
      // But we add Submit and Clear for fun / swap chaos
      const submit = makeBtn(grid, 'SUBMIT', 'seq_submit');
      const clear  = makeBtn(grid, 'CLEAR',  'seq_clear');
      _handlers['seq_submit'] = () => {
        // Force check
        const puzzle = STATE.puzzle;
        const filled = puzzle.current.filter(v => v !== null);
        if (filled.length < puzzle.correct.length) {
          GameLog.warn('INCOMPLETE SEQUENCE');
          return;
        }
        const correct = puzzle.current.every((v, i) => v === puzzle.correct[i]);
        if (correct) {
          GameController.onPuzzleSolved();
        } else {
          shakeBtn(submit);
          STATE.integrity -= 0.04;
          puzzle.current = Array(puzzle.correct.length).fill(null);
          puzzle._placed = new Set();
          puzzle._selectedIdx = null;
          GameLog.warn('WRONG SEQUENCE — INTEGRITY PENALTY');
          PuzzleRenderer.render(STATE.puzzle);
          ControlSystem.build(STATE.puzzle);
        }
      };
      _handlers['seq_clear'] = () => {
        puzzle.current = Array(puzzle.correct.length).fill(null);
        puzzle._placed = new Set();
        puzzle._selectedIdx = null;
        PuzzleRenderer.render(STATE.puzzle);
        ControlSystem.build(STATE.puzzle);
        GameLog.log('Sequence cleared.');
      };
      _buttons['seq_submit'] = submit;
      _buttons['seq_clear']  = clear;
    }

    if (puzzle.type === 'PATTERN') {
      // Clear and Submit
      const submit = makeBtn(grid, 'SUBMIT', 'pat_submit');
      const clear  = makeBtn(grid, 'CLEAR',  'pat_clear');
      _handlers['pat_submit'] = () => {
        const p = STATE.puzzle;
        const match = p.current.every((v, i) => v === p.target[i]);
        if (match) {
          GameController.onPuzzleSolved();
        } else {
          shakeBtn(submit);
          STATE.integrity -= 0.04;
          GameLog.warn('PATTERN MISMATCH — INTEGRITY PENALTY');
        }
      };
      _handlers['pat_clear'] = () => {
        STATE.puzzle.current = Array(STATE.puzzle.target.length).fill(false);
        PuzzleRenderer.render(STATE.puzzle);
        ControlSystem.build(STATE.puzzle);
        GameLog.log('Pattern cleared.');
      };
      _buttons['pat_submit'] = submit;
      _buttons['pat_clear']  = clear;
    }

    // Always add a Skip (costs integrity)
    if (STATE.puzzleIndex < CFG.TOTAL_PUZZLES - 1) {
      const skip = makeBtn(grid, 'SKIP(-15%)', 'skip');
      _handlers['skip'] = () => {
        STATE.integrity -= 0.15;
        GameLog.err('PUZZLE SKIPPED — HEAVY INTEGRITY LOSS');
        GameController.nextPuzzle();
      };
      _buttons['skip'] = skip;
    }
  }

  function makeBtn(parent, label, action) {
    const btn = document.createElement('button');
    btn.className    = 'ctrl-btn';
    btn.textContent  = label;
    btn.dataset.action = action;
    btn.addEventListener('click', () => fireAction(action));
    parent.appendChild(btn);
    return btn;
  }

  function handleMathChoice(puzzle, value) {
    if (value === puzzle.answer) {
      flashBtn(_buttons[`choice_${puzzle.choices.indexOf(value)}`], 'btn-correct');
      setTimeout(() => GameController.onPuzzleSolved(), 300);
    } else {
      const btn = _buttons[`choice_${puzzle.choices.indexOf(value)}`];
      flashBtn(btn, 'btn-wrong');
      shakeBtn(btn);
      STATE.integrity -= 0.07;
      GameLog.err(`WRONG: ${puzzle.question} ≠ ${value} — INTEGRITY PENALTY`);
    }
  }

  function flashBtn(btn, cls) {
    if (!btn) return;
    btn.classList.add(cls);
    setTimeout(() => btn.classList.remove(cls), 600);
  }
  function shakeBtn(btn) {
    if (!btn) return;
    btn.classList.add('shake');
    setTimeout(() => btn.classList.remove('shake'), 400);
  }

  /** Resolve action through swap map, then call handler */
  function fireAction(action) {
    const resolved = STATE.swapMap[action] || action;

    if (resolved !== action) {
      GameLog.warn(`CTRL INTERCEPT: [${action.toUpperCase()}] → [${resolved.toUpperCase()}]`);
    }

    const handler = _handlers[resolved];
    if (handler) handler();
  }

  /** Visually mark swapped buttons */
  function markSwapped(actions) {
    actions.forEach(a => {
      const btn = _buttons[a];
      if (btn) btn.classList.add('swapped-label');
    });
    // Clear after a moment so player must figure it out
    setTimeout(() => {
      actions.forEach(a => {
        const btn = _buttons[a];
        if (btn) btn.classList.remove('swapped-label');
      });
    }, 3000);
  }

  return { build, fireAction, getActionKeys, markSwapped };
})();

/* ═══ §8  GAME LOG ═════════════════════════════════════ */

const GameLog = (() => {
  const MAX = 28;

  function add(text, cls) {
    const body = document.getElementById('log-body');
    if (!body) return;
    const line = document.createElement('div');
    line.className = `log-line ${cls}`;
    line.textContent = `[${fmtTime(Math.floor(STATE.elapsed))}] ${text}`;
    body.insertBefore(line, body.firstChild);

    // Trim
    while (body.children.length > MAX) body.removeChild(body.lastChild);
  }

  return {
    ok  : t => add(t, 'log-ok'),
    log : t => add(t, 'log-ok'),
    warn: t => add(t, 'log-warn'),
    err : t => add(t, 'log-err'),
    crit: t => add(t, 'log-crit'),
  };
})();

/* ═══ §9  HUD UPDATER ══════════════════════════════════ */

const HUD = (() => {
  let fps = 60, frames = 0, fpsTimer = 0;

  function tick(dt) {
    frames++;
    fpsTimer += dt;
    if (fpsTimer >= 0.8) {
      fps = Math.round(frames / fpsTimer);
      frames = 0; fpsTimer = 0;
    }

    STATE.elapsed += dt;

    const tv = document.getElementById('timer-val');
    const sv = document.getElementById('score-val');
    if (tv) {
      const remaining = Math.max(0, Math.ceil(STATE.puzzleTimer));
      tv.textContent = fmtTime(remaining);
      tv.style.color = remaining < 8 ? 'var(--red)' : 'var(--amber)';
    }
    if (sv) sv.textContent = String(STATE.score).padStart(6, '0');
  }
  return { tick };
})();

/* ═══ §10  SCREEN MANAGER ══════════════════════════════ */

const Screens = (() => {
  const IDS = ['screen-title','screen-game','screen-gameover','screen-victory'];

  function show(id) {
    IDS.forEach(s => {
      document.getElementById(s).classList.toggle('hidden', s !== id);
    });
    STATE.screen = id.replace('screen-', '');
  }

  return { show };
})();

/* ═══ §11  GAME CONTROLLER ═════════════════════════════ */

const GameController = (() => {

  function init() {
    // Wire title / gameover / victory buttons
    document.getElementById('btn-start').addEventListener('click', startGame);
    document.getElementById('btn-restart').addEventListener('click', startGame);
    document.getElementById('btn-play-again').addEventListener('click', startGame);

    Screens.show('screen-title');
    Corruption.updateCSS();

    // Start RAF loop (even on title screen for cosmetics)
    requestAnimationFrame(loop);
  }

  function startGame() {
    // Reset state
    STATE.integrity      = 1.0;
    STATE.corruptionRate = CFG.BASE_CORRUPTION;
    STATE.corruptionLevel = 0;
    STATE.puzzleIndex    = 0;
    STATE.score          = 0;
    STATE.elapsed        = 0;
    STATE.swapMap        = {};
    STATE.swappedKeys.clear();
    STATE.paused         = false;
    STATE.lastTs         = performance.now();

    Corruption.reset();

    document.getElementById('log-body').innerHTML =
      '<div class="log-line log-ok">[OK] System initialized.</div>';

    Screens.show('screen-game');
    PuzzleLoader.load(0);
    GameLog.ok('SIMULATION STARTED');
  }

  function onPuzzleSolved() {
    const timeBonus = Math.max(0, Math.ceil(STATE.puzzleTimer)) * CFG.TIME_BONUS_PER_S;
    STATE.score += CFG.PUZZLE_BONUS + timeBonus;
    GameLog.ok(`PUZZLE COMPLETE +${CFG.PUZZLE_BONUS + timeBonus} pts`);

    // Integrity restore (small)
    STATE.integrity = clamp(STATE.integrity + 0.06, 0, 1);
    GameLog.ok('PARTIAL INTEGRITY RESTORE +6%');

    nextPuzzle();
  }

  function nextPuzzle() {
    STATE.puzzleIndex++;

    // Increase corruption speed
    STATE.corruptionRate *= CFG.CORRUPTION_SCALE;

    if (STATE.puzzleIndex >= CFG.TOTAL_PUZZLES) {
      endVictory();
    } else {
      PuzzleLoader.load(STATE.puzzleIndex);
    }
  }

  function endGameOver() {
    Screens.show('screen-gameover');
    STATE.screen = 'gameover';
    document.getElementById('go-stats').innerHTML = `
      PUZZLES SOLVED : ${STATE.puzzleIndex} / ${CFG.TOTAL_PUZZLES}<br>
      FINAL SCORE    : ${String(STATE.score).padStart(6,'0')}<br>
      TIME SURVIVED  : ${fmtTime(Math.floor(STATE.elapsed))}<br>
      INTEGRITY LEFT : 0%
    `;
    GameLog.crit('TOTAL SYSTEM FAILURE');
  }

  function endVictory() {
    Screens.show('screen-victory');
    STATE.screen = 'victory';
    document.getElementById('vic-stats').innerHTML = `
      PUZZLES SOLVED : ${CFG.TOTAL_PUZZLES} / ${CFG.TOTAL_PUZZLES}<br>
      FINAL SCORE    : ${String(STATE.score).padStart(6,'0')}<br>
      TOTAL TIME     : ${fmtTime(Math.floor(STATE.elapsed))}<br>
      INTEGRITY LEFT : ${Math.round(STATE.integrity * 100)}%
    `;
  }

  /* ── RAF loop ── */
  let lastTs = performance.now();

  function loop(ts) {
    requestAnimationFrame(loop);
    const dt = clamp((ts - lastTs) / 1000, 0, 0.1);
    lastTs = ts;

    if (STATE.screen === 'game' && !STATE.paused) {
      Corruption.tick(dt);
      HUD.tick(dt);

      if (STATE.integrity <= 0) {
        endGameOver();
        return;
      }
    }
  }

  return { init, onPuzzleSolved, nextPuzzle };
})();

/* ═══ BOOT ═════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => GameController.init());
