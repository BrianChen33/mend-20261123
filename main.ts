// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// Sections 1 to 4, 9 and 10 of SPEC.md come from the kit's starter; sections 5 to 8
// (three-tier line matching, unified diffs, SEARCH/REPLACE blocks, V4A patches) are
// written here. In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL
// set, and this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

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
  /** Moves a successful edit made, in order: used to print `R old -> new` lines. */
  readonly moves: { old: string; new: string }[] = [];
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

type Edit = (tree: Tree) => void;

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

/* ------------------------------------------------------------------ */
/* Files as lines (SPEC.md section 3)                                  */
/* ------------------------------------------------------------------ */

interface FileModel {
  br: string;
  lines: string[];
  ends: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  let ends = false;
  if (text.endsWith(br)) {
    lines.pop();
    ends = true;
  }
  return { br, lines, ends };
}

function serializeFile(f: FileModel): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.ends ? f.br : '');
}

/* ------------------------------------------------------------------ */
/* Matching lines (SPEC.md section 5)                                  */
/* ------------------------------------------------------------------ */

function norm(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrences(O: string[], F: string[], tier: number): number[] {
  const pos: number[] = [];
  if (O.length === 0) return pos;
  const on = O.map((l) => norm(l, tier));
  for (let i = 0; i + O.length <= F.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (norm(F[i + j]!, tier) !== on[j]!) {
        ok = false;
        break;
      }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

/** First tier (0, then 1, then 2; only 0 with --strict) at which O occurs at or after `from`. */
function findTier(O: string[], F: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const p = occurrences(O, F, t).filter((i) => i >= from);
    if (p.length > 0) return { tier: t, pos: p };
  }
  return null;
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** One line of N: `ctx` is its index in O when it is a context line, else -1. */
interface NLine {
  text: string;
  ctx: number;
}

/** Replace F[pos .. pos+O.length) with N, honouring context lines and tier-2 re-indent. */
function applyReplace(F: string[], pos: number, O: string[], N: NLine[], tier: number): string[] {
  const out = F.slice(0, pos);
  const P = O.length > 0 ? leadingWs(O[0]!) : '';
  const F0 = pos < F.length ? leadingWs(F[pos]!) : '';
  for (const nl of N) {
    if (nl.ctx >= 0) out.push(F[pos + nl.ctx]!);
    else if (tier === 2 && nl.text !== '' && nl.text.trim() !== '' && nl.text.startsWith(P)) out.push(F0 + nl.text.slice(P.length));
    else out.push(nl.text);
  }
  out.push(...F.slice(pos + O.length));
  return out;
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Shared hunk/chunk body handling (sections 6 and 8)                  */
/* ------------------------------------------------------------------ */

interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

interface Hunk {
  /** The -A of `@@ -A[,B] +C[,D] @@` (1-based old start). */
  a: number;
  body: BodyLine[];
  /** O: context and `-` lines; N: context and `+` lines, in body order. */
  O: string[];
  N: NLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noNewlineAtEnd: boolean;
  /** A `\` line follows the hunk's last `+` line (creation files). */
  noNewlineAfterLastPlus: boolean;
}

function buildHunk(a: number, body: BodyLine[]): Hunk {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      O.push(b.text);
      N.push({ text: b.text, ctx: O.length - 1 });
    } else if (b.kind === '-') O.push(b.text);
    else if (b.kind === '+') N.push({ text: b.text, ctx: -1 });
  }
  let lastCtxPlus = -1;
  let lastPlus = -1;
  body.forEach((b, i) => {
    if (b.kind === ' ' || b.kind === '+') lastCtxPlus = i;
    if (b.kind === '+') lastPlus = i;
  });
  return {
    a,
    body,
    O,
    N,
    noNewlineAtEnd: lastCtxPlus >= 0 && body[lastCtxPlus + 1]?.kind === '\\',
    noNewlineAfterLastPlus: lastPlus >= 0 && body[lastPlus + 1]?.kind === '\\',
  };
}

/** Apply one unified hunk to a file model; `d` is the length drift of earlier hunks. */
function applyUnifiedHunk(model: FileModel, hunk: Hunk, d: number, strict: boolean, path: string): FileModel {
  const { O, N } = hunk;
  if (O.length > 0) {
    const found = findTier(O, model.lines, strict);
    if (!found) throw new Fail('no-match', path);
    const target = hunk.a - 1 + d;
    let best = found.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const lines = applyReplace(model.lines, best, O, N, found.tier);
    let ends = model.ends;
    if (best + O.length === model.lines.length && N.length > 0) ends = !hunk.noNewlineAtEnd;
    return { ...model, lines, ends };
  }
  const ins = Math.min(Math.max(hunk.a + d, 0), model.lines.length);
  const lines = [...model.lines.slice(0, ins), ...N.map((x) => x.text), ...model.lines.slice(ins)];
  let ends = model.ends;
  if (ins === model.lines.length && N.length > 0) ends = !hunk.noNewlineAtEnd;
  return { ...model, lines, ends };
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

function stripDiffPrefix(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** The path after `--- ` or `+++ `, up to the first tab, spaces removed; null for /dev/null. */
function headerPath(line: string): string | null {
  const p = line.slice(4).split('\t')[0]!.trim();
  return p === '/dev/null' ? null : stripDiffPrefix(p);
}

interface SectionBuilder {
  hasPair: boolean;
  pairOld: string | null;
  pairNew: string | null;
  renameOld?: string;
  renameNew?: string;
  diffOld?: string;
  diffNew?: string;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
  hasHunk: boolean;
}

function newSection(): SectionBuilder {
  return { hasPair: false, pairOld: null, pairNew: null, newFile: false, deletedFile: false, hunks: [], hasHunk: false };
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let section: SectionBuilder | null = null;
  const flush = (): void => {
    if (section !== null) {
      edits.push(buildUnifiedEdit(section, strict));
      section = null;
    }
  };
  const n = lines.length;
  let i = 0;
  const isBodyLine = (l: string): boolean => l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\');
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      flush();
      section = newSection();
      section.diffOld = stripDiffPrefix(m[1]!);
      section.diffNew = stripDiffPrefix(m[2]!);
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (section !== null && section.hasPair) flush();
      if (section === null) section = newSection();
      section.hasPair = true;
      section.pairOld = headerPath(l);
      section.pairNew = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (section !== null && !section.hasHunk && l.startsWith('--- ')) {
      // A `--- ` line not followed by a `+++ ` line, inside a section's header.
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('@@')) {
      if (section === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      i++;
      const body: BodyLine[] = [];
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (!isBodyLine(b)) break;
        body.push({ kind: b === '' ? ' ' : (b[0] as BodyLine['kind']), text: b === '' ? '' : b.slice(1) });
        i++;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === ' ' && body[body.length - 1]!.text === '') body.pop();
      section.hunks.push(buildHunk(a, body));
      section.hasHunk = true;
      continue;
    }
    if (section !== null && !section.hasHunk) {
      if (l.startsWith('rename from ')) section.renameOld = stripDiffPrefix(l.slice('rename from '.length).trim());
      else if (l.startsWith('rename to ')) section.renameNew = stripDiffPrefix(l.slice('rename to '.length).trim());
      else if (l.startsWith('new file mode')) section.newFile = true;
      else if (l.startsWith('deleted file mode')) section.deletedFile = true;
      // index, old mode, new mode, similarity/dissimilarity index, Index: and any
      // other header line are ignored.
    }
    // Outside bodies, lines that are not part of a section header are ignored.
    i++;
  }
  flush();
  return edits;
}

function buildUnifiedEdit(sec: SectionBuilder, strict: boolean): Edit {
  const oldP = sec.hasPair ? sec.pairOld : sec.renameOld !== undefined ? sec.renameOld : sec.diffOld !== undefined ? sec.diffOld : null;
  const newP = sec.hasPair ? sec.pairNew : sec.renameNew !== undefined ? sec.renameNew : sec.diffNew !== undefined ? sec.diffNew : null;
  let kind: 'create' | 'delete' | 'move' | 'change';
  if (sec.deletedFile) kind = 'delete';
  else if (sec.newFile) kind = 'create';
  else if (oldP === null) kind = 'create';
  else if (newP === null) kind = 'delete';
  else if (oldP !== newP) kind = 'move';
  else kind = 'change';
  const hunks = sec.hunks;
  return (tree) => {
    const named: string[] = [];
    if (oldP !== null) named.push(oldP);
    if (newP !== null && newP !== oldP) named.push(newP);
    for (const p of named) if (!safe(p)) throw new Fail('unsafe', p);
    if (kind === 'create') {
      const p = newP as string | null;
      if (p === null || !safe(p)) throw new Fail('unsafe', p ?? '');
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of hunks) for (const b of h.body) if (b.kind === '+') plus.push(b.text);
      let ends = true;
      if (plus.length > 0) {
        for (let k = hunks.length - 1; k >= 0; k--) {
          const h = hunks[k]!;
          if (h.body.some((b) => b.kind === '+')) {
            ends = !h.noNewlineAfterLastPlus;
            break;
          }
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (ends ? '\n' : ''));
      return;
    }
    if (kind === 'delete') {
      const p = oldP as string | null;
      if (p === null || !safe(p)) throw new Fail('unsafe', p ?? '');
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const p = oldP!;
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    if (kind === 'move') {
      const np = newP!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
    }
    let model = parseFile(cur);
    let d = 0;
    for (const h of hunks) {
      model = applyUnifiedHunk(model, h, d, strict, p);
      d += h.N.length - h.O.length;
    }
    const out = serializeFile(model);
    if (kind === 'move') {
      tree.now.set(p, null);
      tree.now.set(newP!, out);
      tree.moves.push({ old: p, new: newP! });
    } else {
      tree.now.set(p, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(makeSearchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function makeSearchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const model = parseFile(cur);
    const found = findTier(oldLines, model.lines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const N: NLine[] = newLines.map((t) => ({ text: t, ctx: -1 }));
    const out = applyReplace(model.lines, found.pos[0]!, oldLines, N, found.tier);
    tree.now.set(path, serializeFile({ ...model, lines: out }));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  O: string[];
  N: NLine[];
}

function isV4aBodyLine(l: string): boolean {
  return l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+');
}

function readV4aChunk(lines: string[], start: number, last: number, anchor: string | null): { chunk: V4aChunk; next: number } {
  const body: BodyLine[] = [];
  let eof = false;
  let i = start;
  while (i < last) {
    const l = lines[i]!;
    if (l.trimEnd() === '*** End of File') {
      eof = true;
      i++;
      break;
    }
    if (l.startsWith('@@') || l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:') || l.trim() === '*** End Patch') break;
    if (!isV4aBodyLine(l)) throw new Exit2(`error: parse ${i + 1}`);
    body.push({ kind: l === '' ? ' ' : (l[0] as BodyLine['kind']), text: l === '' ? '' : l.slice(1) });
    i++;
  }
  while (body.length > 0 && body[body.length - 1]!.kind === ' ' && body[body.length - 1]!.text === '') body.pop();
  const hunk = buildHunk(0, body);
  return { chunk: { anchor, eof, O: hunk.O, N: hunk.N }, next: i };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File:')) {
      const path = line.slice('*** Add File:'.length).trim();
      i++;
      const flines: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('+')) {
          flines.push(l.slice(1));
          i++;
        } else if (l === '') {
          flines.push('');
          i++;
        } else break;
      }
      while (flines.length > 0 && flines[flines.length - 1] === '') flines.pop();
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, flines.length === 0 ? '' : flines.join('\n') + '\n');
      });
      continue;
    }
    if (line.startsWith('*** Delete File:')) {
      const path = line.slice('*** Delete File:'.length).trim();
      i++;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    if (line.startsWith('*** Update File:')) {
      const path = line.slice('*** Update File:'.length).trim();
      const updateLine = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to:')) {
        moveTo = lines[i]!.slice('*** Move to:'.length).trim();
        i++;
      }
      const chunks: V4aChunk[] = [];
      let seenChunk = false;
      while (i < last) {
        const l = lines[i]!;
        if (l.trimEnd() === '*** End of File' && !seenChunk) throw new Exit2(`error: parse ${i + 1}`);
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          i++;
          const r = readV4aChunk(lines, i, last, anchor === '' ? null : anchor);
          chunks.push(r.chunk);
          i = r.next;
          seenChunk = true;
        } else if (!seenChunk && isV4aBodyLine(l)) {
          const r = readV4aChunk(lines, i, last, null);
          chunks.push(r.chunk);
          i = r.next;
          seenChunk = true;
        } else if (blank(l)) {
          i++;
        } else break;
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(makeV4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function makeV4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let model = parseFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const a = findTier([ch.anchor], model.lines, strict, cursor);
        if (!a) throw new Fail('no-match', path);
        cursor = a.pos[0]! + 1;
      }
      if (ch.O.length === 0) {
        const ins = ch.eof ? model.lines.length : cursor;
        const lines = [...model.lines.slice(0, ins), ...ch.N.map((x) => x.text), ...model.lines.slice(ins)];
        model = { ...model, lines };
        cursor = ins + ch.N.length;
        continue;
      }
      let found: { tier: number; pos: number[] } | null = null;
      if (ch.eof) {
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          const p = occurrences(ch.O, model.lines, t).filter((i) => i >= cursor && i + ch.O.length === model.lines.length);
          if (p.length > 0) {
            found = { tier: t, pos: p };
            break;
          }
        }
      } else {
        found = findTier(ch.O, model.lines, strict, cursor);
      }
      if (!found) throw new Fail('no-match', path);
      const pos = found.pos[0]!;
      const lines = applyReplace(model.lines, pos, ch.O, ch.N, found.tier);
      model = { ...model, lines };
      cursor = pos + ch.N.length;
    }
    const out = serializeFile(model);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Driver (SPEC.md sections 1, 2 and 10)                               */
/* ------------------------------------------------------------------ */

function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

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
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? parseUnified(lines, strict) : kind === 'search-replace' ? parseSearchReplace(lines, strict) : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p)).sort(byteOrder);
  const rows: { key: string; line: string }[] = [];
  for (const p of changed) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const m of tree.moves) {
    const di = rows.findIndex((r) => r.line === `D ${m.old}`);
    const ai = rows.findIndex((r) => r.line === `A ${m.new}`);
    if (di >= 0 && ai >= 0) {
      rows.splice(Math.max(di, ai), 1);
      rows.splice(Math.min(di, ai), 1);
      rows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
    }
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
