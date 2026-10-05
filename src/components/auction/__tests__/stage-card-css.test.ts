/**
 * Guard: the room stage follows the CARD. A portrait 5:7 card, large and centred, whenever no live video plays (live, scheduled,
 * ended alike); a 16:9 frame exists only while a video is present. The stage is capped to the viewport so the bid bar stays in
 * view, and nothing in the stage sits over other text (no negative margin, no gradient overlay on the lower third).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const css = fs.readFileSync(path.join(process.cwd(), 'src/components/auction/auction.css'), 'utf8');
const tsx = fs.readFileSync(path.join(process.cwd(), 'src/components/auction/Stage.tsx'), 'utf8');

/** Every `selector { declarations }` pair in the file (nested @media / @container blocks are flattened: their inner rules are listed too). */
function rules(): { sel: string; body: string }[] {
  const out: { sel: string; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  while ((m = re.exec(stripped))) out.push({ sel: m[1].trim().replace(/^[^]*?;\s*/, ''), body: m[2] });
  return out;
}
const ratio = (body: string): number | null => {
  const m = /aspect-ratio:\s*(\d+)\s*\/\s*(\d+)/.exec(body);
  return m ? Number(m[1]) / Number(m[2]) : null;
};
const rule = (sel: string): string => {
  const r = rules().find((x) => x.sel === sel);
  expect(r, `rule ${sel}`).toBeDefined();
  return r!.body;
};

describe('room stage card', () => {
  it('is a reserved 5:7 box that fills the stage height, centred', () => {
    const card = rule('.ar-video-fallback.is-broadcast');
    expect(card).toMatch(/height:\s*100%/);
    expect(ratio(card)).toBeCloseTo(5 / 7, 5);
    const main = rule('.ar-stage-main');
    expect(main).toMatch(/align-items:\s*center/);
    expect(main).toMatch(/justify-content:\s*center/);
    const pad = /--stage-pad:\s*(\d+)px/.exec(main);
    expect(pad, 'a --stage-pad token').not.toBeNull();
    expect(Number(pad![1])).toBeLessThanOrEqual(16);
    expect(rule('.ar-video-still')).toMatch(/object-fit:\s*contain/);
    expect(rule('.ar-video-still')).toMatch(/padding:\s*0/);
  });

  it('never makes the stage wider than the card allows: the only aspect ratios are 5:7, and 16:9 only for a present video', () => {
    for (const { sel, body } of rules()) {
      if (!/\.ar-stage|\.ar-video/.test(sel)) continue;
      const r = ratio(body);
      if (r == null) continue;
      if (r > 5 / 7 + 1e-9) {
        // a landscape ratio belongs to the video frame, and only while a video is there
        expect(sel, `landscape aspect-ratio on ${sel}`).toMatch(/:has\(\.vd-layer, \.vd-poster\)/);
      }
    }
    expect(rule('.ar-video-wrap')).toMatch(/display:\s*none/); // no stream: no frame at all
  });

  it('is the same in every show state: the card box does not depend on scheduled, live or ended', () => {
    // the card and the information are always rendered; no show-status branch decides whether the card is there
    expect(tsx).toContain('ar-video-still ar-stage-card');
    expect(tsx).toContain('alt=""');
    const card = tsx.slice(tsx.indexOf('ar-video-fallback'), tsx.indexOf('ar-video-wrap'));
    expect(card).not.toMatch(/status/);
    expect(tsx).toContain('<PhaseBanner');
    expect(tsx).toContain('<LowerThird');
  });

  it('is capped to the viewport on a desktop so the bid bar stays visible, and the information sits beside the card when wide', () => {
    expect(css).toMatch(/@media \(min-width: 981px\) \{\s*\.ar-stage \{ max-height: 62vh; \}/);
    expect(css).toMatch(/container: stage \/ inline-size/);
    expect(css).toMatch(/@container stage \(min-width: 600px\) \{\s*[^}]*\.ar-stage-body \{ flex-direction: row/);
  });

  it('gives the wide card panel a percentage height: Safari left a merely stretched auto height at 0 width (a black stage)', () => {
    expect(css).toMatch(/\.ar-stage-main \{ flex: none; align-self: stretch; height: 100%; min-height: 0; aspect-ratio: 5 \/ 7;/);
  });

  it('puts nothing over other text: the lower third is an ordinary block (no negative margin, no gradient overlay)', () => {
    const lt = rule('.ar-lt');
    expect(lt).not.toMatch(/margin(-top)?:\s*-/);
    expect(lt).not.toMatch(/gradient/);
    expect(lt).not.toMatch(/position:\s*absolute/);
    for (const { sel, body } of rules()) {
      if (/\.ar-lt|\.hp-phase|\.ar-lotline/.test(sel)) expect(body, sel).not.toMatch(/margin(-top|-bottom)?:\s*-\d/);
    }
  });

  it('has a soft glow, and the leaving card sits in the same box as the entering one', () => {
    expect(rule('.ar-stage-card')).toMatch(/box-shadow:[^;]*rgba\(232, 199, 118/);
    expect(rule('.ar-stage-card.is-leaving')).toMatch(/animation:\s*ar-stage-card-leave/);
    expect(rule('.ar-video-still')).toMatch(/position:\s*absolute;\s*inset:\s*0/);
  });
});
