import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import LegalDocument from '@/components/legal/LegalDocument';
import { parseBlocks, parseInline, isSafeHref } from '@/legal/markdown';

const render = (md: string, locale: 'de' | 'en' = 'en') => renderToStaticMarkup(createElement(LegalDocument, { blocks: parseBlocks(md), locale }));

describe('legal markdown renderer', () => {
  it('reads the subset the texts use', () => {
    const b = parseBlocks('# T\n\nline one\nline two\n\n- a\n- b\n\n1. x\n2. y\n\n| H1 | H2 |\n|---|---|\n| c1 | c2 |\n');
    expect(b.map((x) => x.t)).toEqual(['h', 'p', 'ul', 'ol', 'table']);
    const p = b[1] as Extract<(typeof b)[number], { t: 'p' }>;
    expect(p.lines).toHaveLength(2); // a newline inside a paragraph is a line break (address block)
  });

  it('does not turn "1.1 text" into a list and keeps "(\\*)" literal', () => {
    expect(parseBlocks('1.1 A numbered paragraph.')[0].t).toBe('p');
    expect(parseInline('form (\\*) and (\\*) again')).toEqual([{ t: 'text', v: 'form (*) and (*) again' }]);
  });

  it('reads links and emphasis inside bold text', () => {
    const html = render('**In short: see [the policy](/legal/datenschutz) and *this*.**', 'de');
    expect(html).toContain('<strong>');
    expect(html).toContain('href="/de/legal/datenschutz"');
    expect(html).not.toContain('](');
    expect(html).not.toContain('**');
  });

  it('escapes HTML instead of passing it through', () => {
    const html = render('A <script>alert(1)</script> & <b>bold</b> text');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('links only safe targets', () => {
    expect(isSafeHref('/legal/terms')).toBe(true);
    expect(isSafeHref('https://example.com/x')).toBe(true);
    expect(isSafeHref('mailto:a@b.de')).toBe(true);
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'http://plain.example', '//evil.example', 'vbscript:x']) expect(isSafeHref(bad), bad).toBe(false);
    const html = render('[click](javascript:alert(1)) and [ok](https://example.com)');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('>click');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('rewrites locale-free legal links to the canonical page of the current locale', () => {
    expect(render('[t](/legal/terms)', 'de')).toContain('href="/de/legal/agb"');
    expect(render('[t](/legal/agb)', 'en')).toContain('href="/en/legal/terms"');
    expect(render('[i](/legal/impressum)', 'en')).toContain('href="/en/legal/impressum"');
  });

  it('never uses dangerouslySetInnerHTML in the legal code', () => {
    const roots = ['src/legal', 'src/components/legal', 'src/app/[locale]/legal', 'src/components/layout/Footer.tsx'];
    const files: string[] = [];
    const walk = (p: string) => {
      if (fs.statSync(p).isDirectory()) fs.readdirSync(p).forEach((f) => walk(path.join(p, f)));
      else if (/\.(ts|tsx)$/.test(p) && !p.includes('__tests__')) files.push(p);
    };
    roots.forEach(walk);
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) expect(fs.readFileSync(f, 'utf8'), f).not.toContain('dangerouslySetInnerHTML');
  });
});
