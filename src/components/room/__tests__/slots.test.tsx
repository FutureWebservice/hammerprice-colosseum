/**
 * The slots are mounted and wired but empty: each renders nothing, so the room, the wizard and the manager look exactly as before
 * until a feature package fills its slot. Their props are the contract the packages build on.
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import StageMedia from '../slots/StageMedia';
import FairnessChip from '../slots/FairnessChip';
import Assistant from '../slots/Assistant';
import LotDescription from '../slots/LotDescription';
import SideChat from '../slots/SideChat';
import ListingAssist from '@/components/sell/slots/ListingAssist';
import VideoOption from '@/components/sell/slots/VideoOption';
import BroadcastLink from '@/components/sell/slots/BroadcastLink';

const SHOW = '3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b10';

describe('empty slots', () => {
  it('render nothing in the room', () => {
    expect(renderToStaticMarkup(<StageMedia showId={SHOW} enabled />)).toBe('');
    expect(renderToStaticMarkup(<FairnessChip showId={SHOW} order={{ mode: 'catalogue' }} />)).toBe(''); // a catalogue show has nothing to prove (the drawn-order states are tested in components/vrf)
    expect(renderToStaticMarkup(<Assistant showId={SHOW} locale="en" />)).toBe('');
    expect(renderToStaticMarkup(<LotDescription description={null} aiAssisted locale="de" />)).toBe(''); // filled by the AI package: empty without a description (src/components/ai/__tests__)
    expect(renderToStaticMarkup(<SideChat showId={SHOW} locale="en" currentLotNumber={1} hasPaddle />)).toBe('');
  });

  it('render nothing in the sell wizard and the show manager', () => {
    expect(renderToStaticMarkup(<ListingAssist lots={[]} locale="en" onApply={() => {}} />)).toBe('');
    // DurationPicker (TIMED) is filled: see src/lib/auction/__tests__/timed-ui.test.tsx
    expect(renderToStaticMarkup(<VideoOption enabled={false} onChange={() => {}} />)).toBe('');
    expect(renderToStaticMarkup(<BroadcastLink showId={SHOW} videoEnabled status="live" />)).toBe('');
  });
});
