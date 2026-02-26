'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { collectChangedMethodsByClass, buildImpactedMethodsByClass } = require('../src/modules/method-impact-helpers');
const { createTempDir, writeFile } = require('./_test-helpers');

const changedEntry = { status: 'M', effectivePath: 'src/pages/A.ts', oldPath: 'src/pages/A.ts', newPath: 'src/pages/A.ts' };

const collect = (baseContent, headContent) =>
  collectChangedMethodsByClass({
    changedPomEntries: [changedEntry],
    baseRef: 'HEAD',
    readChangeContents: () => ({
      basePath: 'src/pages/A.ts',
      headPath: 'src/pages/A.ts',
      baseContent,
      headContent,
    }),
  });

const hasMethod = (result, className, methodName) => Boolean(result.changedMethodsByClass.get(className)?.has(methodName));

test('Type-only changes do not trigger runtime top-level impact', () => {
  const result = collect(
    'import type { X } from "./x"; export class A { run(){ return 1; } }',
    'import type { Y } from "./x"; export class A { run(){ return 1; } }'
  );
  assert.equal(result.stats.topLevelRuntimeChangedFiles, 0);
});

test('Interface-only change yields no impacted methods', () => {
  const result = collect(
    'interface A1 { a: string }; export class A { run(){ return 1; } }',
    'interface A1 { a: number }; export class A { run(){ return 1; } }'
  );
  assert.equal(result.stats.semanticChangedMethodsCount, 0);
});

test('TypeAlias-only change yields no impacted methods', () => {
  const result = collect(
    'type A1 = { a: string }; export class A { run(){ return 1; } }',
    'type A1 = { a: number }; export class A { run(){ return 1; } }'
  );
  assert.equal(result.stats.semanticChangedMethodsCount, 0);
});

test('Type-only import change yields no runtime top-level impact', () => {
  const result = collect(
    'import type { X } from "./x"; export class A { run(){ return 1; } }',
    'import type { Z } from "./z"; export class A { run(){ return 1; } }'
  );
  assert.equal(result.stats.topLevelRuntimeChangedFiles, 0);
});

test('Runtime import change triggers top-level runtime impact', () => {
  const result = collect(
    'import { x } from "./x"; export class A { run(){ return 1; } }',
    'import { y } from "./x"; export class A { run(){ return 1; } }'
  );
  assert.equal(result.stats.topLevelRuntimeChangedFiles, 1);
});

test('Export statement change triggers top-level runtime impact', () => {
  const result = collect(
    'export const A = 1; export class Page { run(){ return 1; } }',
    'export const A = 2; export class Page { run(){ return 1; } }'
  );
  assert.equal(result.stats.topLevelRuntimeChangedFiles, 1);
});

test('Top-level function body change triggers file-wide seed impact', () => {
  const result = collect(
    'function f(){ return 1; } export class Page { run(){return 1;} other(){return 2;} }',
    'function f(){ return 2; } export class Page { run(){return 1;} other(){return 2;} }'
  );
  assert.equal(result.stats.topLevelRuntimeChangedFiles, 1);
  assert.equal(hasMethod(result, 'Page', 'run'), true);
  assert.equal(hasMethod(result, 'Page', 'other'), true);
});

test('VariableStatement const value change triggers file-wide seed impact', () => {
  const result = collect(
    'const SELECTOR = ".one"; export class Page { run(){ return 1; } other(){ return 2; } }',
    'const SELECTOR = ".two"; export class Page { run(){ return 1; } other(){ return 2; } }'
  );
  assert.equal(result.stats.topLevelRuntimeChangedFiles, 1);
  assert.equal(hasMethod(result, 'Page', 'run'), true);
  assert.equal(hasMethod(result, 'Page', 'other'), true);
});

test('Object literal selector map change triggers file-wide seed impact', () => {
  const result = collect(
    'const selectors = { open: ".open" }; export class Page { run(){ return selectors.open; } other(){ return 2; } }',
    'const selectors = { open: ".start" }; export class Page { run(){ return selectors.open; } other(){ return 2; } }'
  );
  assert.equal(result.stats.topLevelRuntimeChangedFiles, 1);
  assert.equal(hasMethod(result, 'Page', 'run'), true);
  assert.equal(hasMethod(result, 'Page', 'other'), true);
});

test('new Map(...) initializer change triggers file-wide seed impact', () => {
  const result = collect(
    'const m = new Map([["k", 1]]); export class Page { run(){ return m.get("k"); } other(){ return 2; } }',
    'const m = new Map([["k", 2]]); export class Page { run(){ return m.get("k"); } other(){ return 2; } }'
  );
  assert.equal(result.stats.topLevelRuntimeChangedFiles, 1);
  assert.equal(hasMethod(result, 'Page', 'run'), true);
  assert.equal(hasMethod(result, 'Page', 'other'), true);
});

test('Top-level function signature change triggers file-wide seed impact', () => {
  const result = collect(
    'function f(a:number){ return a; } export class Page { run(){ return f(1); } other(){ return 2; } }',
    'function f(a:string){ return a; } export class Page { run(){ return f("1"); } other(){ return 2; } }'
  );
  assert.equal(result.stats.topLevelRuntimeChangedFiles, 1);
  assert.equal(hasMethod(result, 'Page', 'run'), true);
  assert.equal(hasMethod(result, 'Page', 'other'), true);
});

test('Top-level enum value change triggers file-wide seed impact', () => {
  const result = collect(
    'enum K { Open = "open" } export class Page { run(){ return K.Open; } other(){ return 2; } }',
    'enum K { Open = "start" } export class Page { run(){ return K.Open; } other(){ return 2; } }'
  );
  assert.equal(result.stats.topLevelRuntimeChangedFiles, 1);
  assert.equal(hasMethod(result, 'Page', 'run'), true);
  assert.equal(hasMethod(result, 'Page', 'other'), true);
});

test('Top-level runtime whitespace-only change yields no impact', () => {
  const result = collect('const A=1; export class Page { run(){ return 1; } }', 'const   A = 1; export class Page { run(){ return 1; } }');
  assert.equal(result.stats.topLevelRuntimeChangedFiles, 0);
});

test('Top-level runtime comment-only change yields no impact', () => {
  const result = collect('const A=1; export class Page { run(){ return 1; } }', '// comment\nconst A=1; export class Page { run(){ return 1; } }');
  assert.equal(result.stats.topLevelRuntimeChangedFiles, 0);
});

test('Method body comment-only change yields no semantic change', () => {
  const result = collect('export class A { run(){ return 1; } }', 'export class A { run(){ /*c*/ return 1; } }');
  assert.equal(result.stats.semanticChangedMethodsCount, 0);
});

test('Method body whitespace-only change yields no semantic change', () => {
  const result = collect('export class A { run(){ return 1 + 2; } }', 'export class A { run(){ return 1+2; } }');
  assert.equal(result.stats.semanticChangedMethodsCount, 0);
});

test('Method literal change triggers semantic change', () => {
  const result = collect('export class A { run(){ return 1; } }', 'export class A { run(){ return 2; } }');
  assert.equal(hasMethod(result, 'A', 'run'), true);
});

test('Method operator change triggers semantic change', () => {
  const result = collect('export class A { run(a:number,b:number){ return a+b; } }', 'export class A { run(a:number,b:number){ return a-b; } }');
  assert.equal(hasMethod(result, 'A', 'run'), true);
});

test('Method call target change triggers semantic change', () => {
  const result = collect(
    'export class A { a(){return 1;} b(){return 2;} run(){ return this.a(); } }',
    'export class A { a(){return 1;} b(){return 2;} run(){ return this.b(); } }'
  );
  assert.equal(hasMethod(result, 'A', 'run'), true);
});

test('Method parameter list change triggers semantic change', () => {
  const result = collect('export class A { run(a:number){ return a; } }', 'export class A { run(a:number,b:number){ return a+b; } }');
  assert.equal(hasMethod(result, 'A', 'run'), true);
});

test('Method default parameter change triggers semantic change', () => {
  const result = collect('export class A { run(a:number=1){ return a; } }', 'export class A { run(a:number=2){ return a; } }');
  assert.equal(hasMethod(result, 'A', 'run'), true);
});

test('Method rest parameter change triggers semantic change', () => {
  const result = collect('export class A { run(...a:number[]){ return a.length; } }', 'export class A { run(...a:string[]){ return a.length; } }');
  assert.equal(hasMethod(result, 'A', 'run'), true);
});

test('Method optional parameter change triggers semantic change', () => {
  const result = collect('export class A { run(a?:number){ return a||0; } }', 'export class A { run(a:number){ return a; } }');
  assert.equal(hasMethod(result, 'A', 'run'), true);
});

test('Method default/rest/optional parameter changes trigger semantic change', () => {
  const a = collect('export class A { run(a:number=1){ return a; } }', 'export class A { run(a:number=2){ return a; } }');
  const b = collect('export class A { run(...a:number[]){ return a.length; } }', 'export class A { run(...a:string[]){ return a.length; } }');
  const c = collect('export class A { run(a?:number){ return a||0; } }', 'export class A { run(a:number){ return a; } }');
  assert.equal(hasMethod(a, 'A', 'run'), true);
  assert.equal(hasMethod(b, 'A', 'run'), true);
  assert.equal(hasMethod(c, 'A', 'run'), true);
});

test('Method return type and async modifier changes trigger semantic change', () => {
  const a = collect('export class A { run():number{ return 1; } }', 'export class A { run():string{ return "1"; } }');
  const b = collect('export class A { run(){ return 1; } }', 'export class A { async run(){ return 1; } }');
  assert.equal(hasMethod(a, 'A', 'run'), true);
  assert.equal(hasMethod(b, 'A', 'run'), true);
});

test('Accessibility modifier change triggers semantic change', () => {
  const result = collect('export class A { public run(){ return 1; } }', 'export class A { protected run(){ return 1; } }');
  assert.equal(hasMethod(result, 'A', 'run'), true);
});

test('Method added/removed/renamed are detected', () => {
  const added = collect('export class A { one(){return 1;} }', 'export class A { one(){return 1;} two(){return 2;} }');
  const removed = collect('export class A { one(){return 1;} two(){return 2;} }', 'export class A { one(){return 1;} }');
  const renamed = collect('export class A { old(){return 1;} }', 'export class A { newer(){return 1;} }');
  assert.equal(hasMethod(added, 'A', 'two'), true);
  assert.equal(hasMethod(removed, 'A', 'two'), true);
  assert.equal(hasMethod(renamed, 'A', 'old') || hasMethod(renamed, 'A', 'newer'), true);
});

test('Getter and setter add/remove/change are detected', () => {
  const added = collect('export class A { get x(){ return 1; } }', 'export class A { get x(){ return 2; } set x(v:number){} }');
  const removed = collect('export class A { get x(){ return 1; } set x(v:number){} }', 'export class A { get x(){ return 1; } }');
  assert.equal(added.stats.semanticChangedMethodsCount >= 1, true);
  assert.equal(removed.stats.semanticChangedMethodsCount >= 1, true);
});

test('Arrow/function-expression property methods are detected', () => {
  const arrow = collect('export class A { run = () => 1; }', 'export class A { run = () => 2; }');
  const fnExpr = collect('export class A { run = function(){ return 1; }; }', 'export class A { run = function(){ return 2; }; }');
  assert.equal(hasMethod(arrow, 'A', 'run'), true);
  assert.equal(hasMethod(fnExpr, 'A', 'run'), true);
});

test('Arrow property whitespace-only change yields no change', () => {
  const result = collect('export class A { run = () => { return 1; }; }', 'export class A { run = ()=>{return 1;}; }');
  assert.equal(result.stats.semanticChangedMethodsCount, 0);
});

test('Overload changes impact method even if implementation unchanged', () => {
  const overloadAdded = collect(
    'export class A { run(a:number):number; run(a:any){ return a; } }',
    'export class A { run(a:number):number; run(a:string):string; run(a:any){ return a; } }'
  );
  const orderChanged = collect(
    'export class A { run(a:number):number; run(a:string):string; run(a:any){ return a; } }',
    'export class A { run(a:string):string; run(a:number):number; run(a:any){ return a; } }'
  );
  assert.equal(hasMethod(overloadAdded, 'A', 'run'), true);
  assert.equal(hasMethod(orderChanged, 'A', 'run'), true);
});

test('Propagation handles cycles and mutual recursion deterministically', () => {
  const dir = createTempDir();
  const file = writeFile(
    dir,
    'A.ts',
    'export class A { a(){ return this.b(); } b(){ return this.a(); } c(){ return this.a(); } }'
  );

  const result = buildImpactedMethodsByClass({
    impactedClasses: new Set(['A']),
    changedMethodsByClass: new Map([['A', new Set(['a'])]]),
    parentsByChild: new Map(),
    pageFiles: [file],
  });

  const methods = Array.from(result.impactedMethodsByClass.get('A') || []).sort();
  assert.deepEqual(methods, ['a', 'b', 'c']);
});

test('Unresolvable this/super calls do not crash and produce warnings', () => {
  const dir = createTempDir();
  const file = writeFile(dir, 'A.ts', 'export class A { run(){ return this.unknown(); } }');
  const file2 = writeFile(dir, 'B.ts', 'export class B extends A { run2(){ return super.unknown(); } }');

  const result = buildImpactedMethodsByClass({
    impactedClasses: new Set(['A', 'B']),
    changedMethodsByClass: new Map([['A', new Set(['run'])]]),
    parentsByChild: new Map([['B', 'A']]),
    pageFiles: [file, file2],
  });

  assert.equal(Array.isArray(result.warnings), true);
  assert.equal(result.warnings.length > 0, true);
});

test('Deep this chain treated as uncertain and does not crash', () => {
  const dir = createTempDir();
  const file = writeFile(dir, 'A.ts', 'export class A { run(){ return this.a.b.c(); } c(){ return 1; } }');

  const result = buildImpactedMethodsByClass({
    impactedClasses: new Set(['A']),
    changedMethodsByClass: new Map([['A', new Set(['c'])]]),
    parentsByChild: new Map(),
    pageFiles: [file],
  });

  assert.equal(Array.isArray(result.warnings), true);
  assert.equal(result.warnings.some((w) => w.includes('Deep this.* chain')), true);
});

test('Composition call this.child.foo() resolves when child is new Child() in ctor', () => {
  const dir = createTempDir();
  const child = writeFile(dir, 'Child.ts', 'export class Child { foo(){ return 1; } }');
  const page = writeFile(dir, 'Page.ts', 'export class Page { constructor(){ this.child = new Child(); } run(){ return this.child.foo(); } }');

  const result = buildImpactedMethodsByClass({
    impactedClasses: new Set(['Child']),
    changedMethodsByClass: new Map([['Child', new Set(['foo'])]]),
    parentsByChild: new Map(),
    pageFiles: [child, page],
  });

  const pageMethods = Array.from(result.impactedMethodsByClass.get('Page') || []);
  assert.equal(pageMethods.includes('run'), true);
});

test('Composition call resolves when child is typed as namespace-qualified class', () => {
  const dir = createTempDir();
  const child = writeFile(dir, 'Child.ts', 'export class Child { foo(){ return 1; } }');
  const page = writeFile(dir, 'Page.ts', 'export class Page { child: Pages.Child; run(){ return this.child.foo(); } }');

  const result = buildImpactedMethodsByClass({
    impactedClasses: new Set(['Child']),
    changedMethodsByClass: new Map([['Child', new Set(['foo'])]]),
    parentsByChild: new Map(),
    pageFiles: [child, page],
  });

  const pageMethods = Array.from(result.impactedMethodsByClass.get('Page') || []);
  assert.equal(pageMethods.includes('run'), true);
});

test('Composition call with unknown child type is marked uncertain', () => {
  const dir = createTempDir();
  const page = writeFile(dir, 'Page.ts', 'export class Page { run(){ return this.child.foo(); } foo(){ return 1; } }');

  const result = buildImpactedMethodsByClass({
    impactedClasses: new Set(['Page']),
    changedMethodsByClass: new Map([['Page', new Set(['foo'])]]),
    parentsByChild: new Map(),
    pageFiles: [page],
  });

  assert.equal(result.warnings.some((w) => w.includes('Unknown composed field type')), true);
});

test('Call graph resolves this.foo() to nearest ancestor in lineage', () => {
  const dir = createTempDir();
  const base = writeFile(dir, 'Base.ts', 'export class Base { foo(){ return 1; } }');
  const child = writeFile(dir, 'Child.ts', 'export class Child extends Base { caller(){ return this.foo(); } }');

  const result = buildImpactedMethodsByClass({
    impactedClasses: new Set(['Base']),
    changedMethodsByClass: new Map([['Base', new Set(['foo'])]]),
    parentsByChild: new Map([['Child', 'Base']]),
    pageFiles: [base, child],
  });

  const childMethods = Array.from(result.impactedMethodsByClass.get('Child') || []);
  assert.equal(childMethods.includes('caller'), true);
});

test('Call graph resolves super.foo() only via parent chain', () => {
  const dir = createTempDir();
  const base = writeFile(dir, 'Base.ts', 'export class Base { foo(){ return 1; } }');
  const child = writeFile(dir, 'Child.ts', 'export class Child extends Base { caller(){ return super.foo(); } }');
  const grand = writeFile(dir, 'Grand.ts', 'export class Grand extends Child { caller2(){ return super.caller(); } }');

  const result = buildImpactedMethodsByClass({
    impactedClasses: new Set(['Base']),
    changedMethodsByClass: new Map([['Base', new Set(['foo'])]]),
    parentsByChild: new Map([['Child', 'Base'], ['Grand', 'Child']]),
    pageFiles: [base, child, grand],
  });

  const childMethods = Array.from(result.impactedMethodsByClass.get('Child') || []);
  const grandMethods = Array.from(result.impactedMethodsByClass.get('Grand') || []);
  assert.equal(childMethods.includes('caller'), true);
  assert.equal(grandMethods.includes('caller2'), true);
});
