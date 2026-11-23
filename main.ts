// main.ts is mend, the CLI SPEC.md (version 1) specifies: one patch tool for every AI edit format.
// It reads a patch in unified diff, SEARCH/REPLACE, V4A or JSON form, finds the lines each edit names
// at the first of three matching tiers, and writes every change or none (atomic). Node 22, the standard
// library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over
// to runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** An edit, applied to the tree as earlier edits left it. It returns a move pair when it moves a file. */
type Edit = (tree: Tree) => { move?: [string, string] } | void;

// ---------------------------------------------------------------------------
// Section 5: matching lines, and section 3: a file's lines and line break.
// ---------------------------------------------------------------------------

interface FileParts {
  br: string;
  lines: string[];
  finalBr: boolean;
}

/** Split a file's text at its own line break (section 3). */
function splitFile(text: string): FileParts {
  if (text === '') return { br: '\n', lines: [], finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBr = text.endsWith(br);
  if (finalBr) parts.pop();
  return { br, lines: parts, finalBr };
}

/** Join a file's lines back with its break; a file of no lines is written empty. */
function joinFile(p: FileParts): string {
  if (p.lines.length === 0) return '';
  return p.lines.join(p.br) + (p.finalBr ? p.br : '');
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions where O occurs in lines at one tier; occurrences may overlap. */
function occurrencesAt(O: string[], lines: string[], tier: number): number[] {
  const pos: number[] = [];
  if (O.length === 0 || O.length > lines.length) return pos;
  const want = O.map((l) => normLine(l, tier));
  outer: for (let i = 0; i + O.length <= lines.length; i++) {
    for (let j = 0; j < O.length; j++) {
      if (normLine(lines[i + j]!, tier) !== want[j]) continue outer;
    }
    pos.push(i);
  }
  return pos;
}

/** The first tier at which O occurs at least once, with its positions (null: no tier). */
function findTier(O: string[], lines: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAt(O, lines, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** Occurrences at or after `from`; for an end-of-file chunk only those ending at the last line. */
function findTierFrom(
  O: string[],
  lines: string[],
  from: number,
  strict: boolean,
  eofOnly: boolean,
): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAt(O, lines, t).filter((p) => p >= from && (!eofOnly || p + O.length === lines.length));
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of N: `ctx` >= 0 is a context line paired with O[ctx]; -1 is a new-only line. */
interface NItem {
  text: string;
  ctx: number;
}

/**
 * Build the lines that replace a matched run. A context line is written as the file's own matched
 * line, never the patch's. At tier 2 every other line of N that is not empty and not only whitespace
 * and starts with P (the leading spaces/tabs of O's first line) has that P replaced by F (the leading
 * spaces/tabs of the file's first matched line); any other line is written as it is.
 */
function buildReplacement(O: string[], nItems: NItem[], lines: string[], at: number, tier: number): string[] {
  let f = '';
  let p = '';
  if (tier === 2 && O.length > 0) {
    f = /^[ \t]*/.exec(lines[at]!)![0];
    p = /^[ \t]*/.exec(O[0]!)![0];
  }
  return nItems.map((it) => {
    if (it.ctx >= 0) return lines[at + it.ctx]!;
    if (tier === 2) {
      const t = it.text;
      if (t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(p)) return f + t.slice(p.length);
    }
    return it.text;
  });
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

interface Hunk {
  /** A: the 1-based old-file line the hunk starts at. */
  a: number;
  /** O: the hunk's context and `-` lines, in body order. */
  o: string[];
  /** N: the hunk's context and `+` lines, in body order. */
  n: NItem[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  noEolAfterLastPlus: boolean;
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  gitOld: string | null;
  gitNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** `@@ -A[,B] +C[,D] @@`, single spaces, closing `@@`, optionally followed by any text. */
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** The path after `--- ` / `+++ `: text after the four characters, up to the first tab, spaces removed. */
function dashPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

/** A leading `a/` or `b/` is removed from a `---` / `+++` path. */
function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** `diff --git a/<X> b/<Y>`, split at the first ` b/`; Y is the rest of the line. Null when not that form. */
function parseGit(line: string): [string, string] | null {
  if (!line.startsWith('diff --git a/')) return null;
  const rest = line.slice('diff --git a/'.length);
  const k = rest.indexOf(' b/');
  if (k < 0) return null;
  return [rest.slice(0, k), rest.slice(k + 3)];
}

/**
 * A hunk's body: the lines after the header that start with ` `, `-`, `+` or `\`, or are empty.
 * It ends at the first other line, at a `diff --git ` line, at a `--- ` line followed by a `+++ ` line,
 * or at the end of the patch; a `--- ` line not followed by `+++ ` is an old line. Empty lines at the
 * end of a body are not part of it.
 */
function parseHunkBody(lines: string[], start: number): { body: string[]; end: number } {
  const body: string[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l === '' || l[0] === ' ' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      j++;
      continue;
    }
    if (l[0] === '-') {
      if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
      body.push(l);
      j++;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return { body, end: j };
}

function buildHunk(a: number, body: string[]): Hunk {
  const o: string[] = [];
  const n: NItem[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  body.forEach((l, idx) => {
    if (l === '' || l[0] === ' ') {
      const t = l === '' ? '' : l.slice(1);
      o.push(t);
      n.push({ text: t, ctx: o.length - 1 });
      lastCtxPlus = idx;
    } else if (l[0] === '-') {
      o.push(l.slice(1));
    } else if (l[0] === '+') {
      n.push({ text: l.slice(1), ctx: -1 });
      lastCtxPlus = idx;
      lastPlus = idx;
    }
  });
  const followsBackslash = (idx: number): boolean =>
    idx >= 0 && body[idx + 1] !== undefined && body[idx + 1]![0] === '\\';
  return { a, o, n, noEol: followsBackslash(lastCtxPlus), noEolAfterLastPlus: followsBackslash(lastPlus) };
}

/** Apply one hunk to the file's current lines. `d` is the running length drift of this section. */
function applyHunk(
  cur: { lines: string[]; finalBr: boolean },
  h: Hunk,
  strict: boolean,
  d: number,
  path: string,
): { lines: string[]; finalBr: boolean } {
  if (h.o.length === 0) {
    const pos = Math.min(Math.max(h.a + d, 0), cur.lines.length);
    const ins = h.n.map((it) => it.text);
    const lines = [...cur.lines.slice(0, pos), ...ins, ...cur.lines.slice(pos)];
    const finalBr = pos === cur.lines.length ? !h.noEol : cur.finalBr;
    return { lines, finalBr };
  }
  const found = findTier(h.o, cur.lines, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let at = found.pos[0]!;
  let best = Math.abs(at - target);
  for (const p of found.pos) {
    const dist = Math.abs(p - target);
    if (dist < best) {
      at = p;
      best = dist;
    }
  }
  const seg = buildReplacement(h.o, h.n, cur.lines, at, found.tier);
  const lines = [...cur.lines.slice(0, at), ...seg, ...cur.lines.slice(at + h.o.length)];
  const runsToEnd = at + h.o.length === cur.lines.length;
  const finalBr = runsToEnd ? !h.noEol : cur.finalBr;
  return { lines, finalBr };
}

/** Apply a section's hunks in order, each to the result of the ones before it. */
function applyUnifiedHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const parts = splitFile(text);
  let cur: { lines: string[]; finalBr: boolean } = { lines: parts.lines, finalBr: parts.finalBr };
  let d = 0;
  for (const h of hunks) {
    cur = applyHunk(cur, h, strict, d, path);
    d += h.n.length - h.o.length;
  }
  return joinFile({ br: parts.br, lines: cur.lines, finalBr: cur.finalBr });
}

function unifiedEdit(s: UniSection, strict: boolean): Edit {
  // Per path: the `---`/`+++` path, else `rename from`/`to`, else the `diff --git` path.
  const oldP = s.oldPath ?? s.renameFrom ?? s.gitOld;
  const newP = s.newPath ?? s.renameTo ?? s.gitNew;
  // Listed order: creation, deletion, move, change.
  const kind: 'create' | 'delete' | 'move' | 'change' =
    oldP === '/dev/null' || s.newFile
      ? 'create'
      : newP === '/dev/null' || s.deletedFile
        ? 'delete'
        : oldP !== null && newP !== null && oldP !== newP
          ? 'move'
          : 'change';
  if (kind === 'create') {
    const target = newP ?? '';
    return (tree) => {
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const plus: string[] = [];
      for (const h of s.hunks) for (const it of h.n) if (it.ctx < 0) plus.push(it.text);
      let noEol = false;
      for (let k = s.hunks.length - 1; k >= 0; k--) {
        const h = s.hunks[k]!;
        if (h.n.some((it) => it.ctx < 0)) {
          noEol = h.noEolAfterLastPlus;
          break;
        }
      }
      tree.now.set(target, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
    };
  }
  if (kind === 'delete') {
    const target = oldP ?? '';
    return (tree) => {
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
    };
  }
  if (kind === 'move') {
    const from = oldP!;
    const to = newP!;
    return (tree) => {
      if (!safe(from)) throw new Fail('unsafe', from);
      if (!safe(to)) throw new Fail('unsafe', to);
      const cur = tree.get(from);
      if (cur === null) throw new Fail('missing', from);
      if (tree.get(to) !== null) throw new Fail('exists', to);
      const out = applyUnifiedHunks(cur, s.hunks, strict, from);
      tree.now.set(to, out);
      tree.now.set(from, null);
      return { move: [from, to] as [string, string] };
    };
  }
  const target = oldP ?? newP ?? '';
  return (tree) => {
    if (!safe(target)) throw new Fail('unsafe', target);
    const cur = tree.get(target);
    if (cur === null) throw new Fail('missing', target);
    tree.now.set(target, applyUnifiedHunks(cur, s.hunks, strict, target));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  const fresh = (): UniSection => ({
    oldPath: null,
    newPath: null,
    renameFrom: null,
    renameTo: null,
    gitOld: null,
    gitNew: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  let cur: UniSection | null = null;
  let seenHunk = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const g = parseGit(line);
      if (g === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.gitOld = g[0];
      cur.gitNew = g[1];
      sections.push(cur);
      seenHunk = false;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const { body, end } = parseHunkBody(lines, i + 1);
      cur.hunks.push(buildHunk(Number(m[1]), body));
      seenHunk = true;
      i = end;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        // SPEC §6: a pair in a section's header (before its first hunk) is part of that
        // header, so a second (or later) pair overwrites the paths (last wins) instead
        // of starting a new section. Only a pair after a body/hunk starts a new section.
        if (cur !== null && !seenHunk) {
          cur.oldPath = stripAB(dashPath(line));
          cur.newPath = stripAB(dashPath(next));
        } else {
          cur = fresh();
          cur.oldPath = stripAB(dashPath(line));
          cur.newPath = stripAB(dashPath(next));
          sections.push(cur);
          seenHunk = false;
        }
        i += 2;
        continue;
      }
      if (cur !== null && !seenHunk) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (cur !== null && !seenHunk) {
      if (line.startsWith('+++ ')) cur.newPath = stripAB(dashPath(line));
      else if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const parts = splitFile(cur);
    const found = findTier(oldLines, parts.lines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const at = found.pos[0]!;
    const seg = buildReplacement(
      oldLines,
      newLines.map((t) => ({ text: t, ctx: -1 })),
      parts.lines,
      at,
      found.tier,
    );
    const lines = [...parts.lines.slice(0, at), ...seg, ...parts.lines.slice(at + oldLines.length)];
    tree.now.set(path, joinFile({ br: parts.br, lines, finalBr: parts.finalBr }));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let eq = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          eq = j;
          break;
        }
      }
      if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
      // The path is the nearest line before the SEARCH line, and after the previous block's
      // REPLACE line (or the start of the patch), that is not blank and does not start with
      // three backticks; the path is that line with its surrounding whitespace removed.
      let path: string | null = null;
      for (let j = i - 1; j > prevReplaceEnd; j--) {
        const l = lines[j]!;
        if (blank(l)) continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) path = prevPath;
      if (path === null) throw new Exit2(`error: parse ${searchLine}`);
      edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
      prevPath = path;
      prevReplaceEnd = rep;
      i = rep + 1;
      continue;
    }
    i++;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

type V4AHeader = { kind: 'add' | 'delete' | 'update'; path: string };

/** A section header: `*** Add File: `, `*** Delete File: ` or `*** Update File: ` plus its path. */
function v4aHeader(line: string): V4AHeader | null {
  if (line.startsWith('*** Add File: ')) return { kind: 'add', path: line.slice('*** Add File: '.length).trim() };
  if (line.startsWith('*** Delete File: ')) return { kind: 'delete', path: line.slice('*** Delete File: '.length).trim() };
  if (line.startsWith('*** Update File: ')) return { kind: 'update', path: line.slice('*** Update File: '.length).trim() };
  return null;
}

interface VChunk {
  /** Null: no anchor (empty anchor text). */
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NItem[];
}

function v4aSectionEdit(hdr: V4AHeader, bodyIdx: number[], lines: string[], headerLine: number, strict: boolean): Edit {
  if (hdr.kind === 'add') {
    const fileLines: string[] = [];
    for (const idx of bodyIdx) {
      const l = lines[idx]!;
      if (l === '') fileLines.push('');
      else if (l.startsWith('+')) fileLines.push(l.slice(1));
      else throw new Exit2(`error: parse ${idx + 1}`);
    }
    return (tree) => {
      if (!safe(hdr.path)) throw new Fail('unsafe', hdr.path);
      if (tree.get(hdr.path) !== null) throw new Fail('exists', hdr.path);
      tree.now.set(hdr.path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (hdr.kind === 'delete') {
    for (const idx of bodyIdx) {
      if (!blank(lines[idx]!)) throw new Exit2(`error: parse ${idx + 1}`);
    }
    return (tree) => {
      if (!safe(hdr.path)) throw new Fail('unsafe', hdr.path);
      if (tree.get(hdr.path) === null) throw new Fail('missing', hdr.path);
      tree.now.set(hdr.path, null);
    };
  }
  // Update: an optional `*** Move to: <path>` as the first line, then chunks.
  let moveTo: string | null = null;
  let k = 0;
  if (bodyIdx.length > 0) {
    const l0 = lines[bodyIdx[0]!]!;
    if (l0.startsWith('*** Move to: ')) {
      moveTo = l0.slice('*** Move to: '.length).trim();
      k = 1;
    }
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  let firstChunk = true;
  for (; k < bodyIdx.length; k++) {
    const idx = bodyIdx[k]!;
    const l = lines[idx]!;
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${idx + 1}`);
      cur.eof = true;
      cur = null;
      firstChunk = false;
      continue;
    }
    if (l.startsWith('@@')) {
      cur = { anchor: l.slice(2).trim(), eof: false, o: [], n: [] };
      chunks.push(cur);
      firstChunk = false;
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (!firstChunk) throw new Exit2(`error: parse ${idx + 1}`);
        cur = { anchor: null, eof: false, o: [], n: [] };
        chunks.push(cur);
        firstChunk = false;
      }
      if (l === '') {
        cur.o.push('');
        cur.n.push({ text: '', ctx: cur.o.length - 1 });
      } else if (l[0] === ' ') {
        const t = l.slice(1);
        cur.o.push(t);
        cur.n.push({ text: t, ctx: cur.o.length - 1 });
      } else if (l[0] === '-') {
        cur.o.push(l.slice(1));
      } else {
        cur.n.push({ text: l.slice(1), ctx: -1 });
      }
      continue;
    }
    throw new Exit2(`error: parse ${idx + 1}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
  return (tree) => {
    if (!safe(hdr.path)) throw new Fail('unsafe', hdr.path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const curText = tree.get(hdr.path);
    if (curText === null) throw new Fail('missing', hdr.path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const parts = splitFile(curText);
    let linesNow = parts.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const found = findTierFrom([ch.anchor], linesNow, cursor, strict, false);
        if (found === null) throw new Fail('no-match', hdr.path);
        cursor = found.pos[0]! + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.eof ? linesNow.length : cursor;
        const ins = ch.n.map((it) => it.text);
        linesNow = [...linesNow.slice(0, at), ...ins, ...linesNow.slice(at)];
        cursor = at + ins.length;
      } else {
        const found = findTierFrom(ch.o, linesNow, cursor, strict, ch.eof);
        if (found === null) throw new Fail('no-match', hdr.path);
        const at = found.pos[0]!;
        const seg = buildReplacement(ch.o, ch.n, linesNow, at, found.tier);
        linesNow = [...linesNow.slice(0, at), ...seg, ...linesNow.slice(at + ch.o.length)];
        cursor = at + seg.length;
      }
    }
    const out = joinFile({ br: parts.br, lines: linesNow, finalBr: parts.finalBr });
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(hdr.path, null);
      return { move: [hdr.path, moveTo] as [string, string] };
    }
    tree.now.set(hdr.path, out);
  };
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const hdr = v4aHeader(line);
    if (hdr === null) throw new Exit2(`error: parse ${i + 1}`);
    let j = i + 1;
    const raw: number[] = [];
    while (j < last) {
      if (v4aHeader(lines[j]!) !== null) break;
      raw.push(j);
      j++;
    }
    // Blank lines at the end of a section (before the next section or `*** End Patch`) are not part
    // of it; blank lines before a `*** End of File` line stay part of the chunk.
    let rawEnd = raw.length;
    while (rawEnd > 0 && blank(lines[raw[rawEnd - 1]!]!)) rawEnd--;
    edits.push(v4aSectionEdit(hdr, raw.slice(0, rawEnd), lines, i + 1, strict));
    i = j;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits.
// ---------------------------------------------------------------------------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 1: invocation; section 2: output and exit codes; section 10: order.
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: [string, string][] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      const m = edit(tree);
      if (m !== undefined && m.move !== undefined) moves.push(m.move);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: a successful move whose old path existed before the patch and does not after it,
  // and whose new path did not exist before it and does after it, is one `R` line sorting by <new>;
  // it replaces that pair's `D` and `A` lines. All rows sort in UTF-8 byte order of their sort key.
  const rows: { key: string; text: string }[] = [];
  const covered = new Set<string>();
  for (const [o, nw] of moves) {
    const nowO = tree.now.has(o) ? tree.now.get(o)! : undefined;
    const nowN = tree.now.has(nw) ? tree.now.get(nw)! : undefined;
    if (tree.original(o) !== null && nowO === null && tree.original(nw) === null && nowN !== null && nowN !== undefined) {
      rows.push({ key: nw, text: `R ${o} -> ${nw}` });
      covered.add(o);
      covered.add(nw);
    }
  }
  for (const p of tree.now.keys()) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  const outRows = rows.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
