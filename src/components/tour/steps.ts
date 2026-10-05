/**
 * The tour steps. A tour is one flow: the room (five steps) or the sell wizard (four).
 * `anchor` is the value of the `data-tour` attribute the page puts on the element. A step whose anchor is not on the
 * page is skipped. The `help` step is shared: the Help button sits in the site header and in the room's top bar.
 */
export const TOUR_STEPS = [
  { id: 'stage', anchor: 'stage' },
  { id: 'clock', anchor: 'clock' },
  { id: 'bid', anchor: 'bid' },
  { id: 'rail', anchor: 'rail' },
  { id: 'help', anchor: 'help' },
] as const;

export const SELL_TOUR_STEPS = [
  { id: 'sellSteps', anchor: 'sell-steps' },
  { id: 'sellStep', anchor: 'sell-step' },
  { id: 'sellPublish', anchor: 'sell-nav' },
  { id: 'help', anchor: 'help' },
] as const;

export type TourFlow = 'room' | 'sell';
export type TourStepId =
  | (typeof TOUR_STEPS)[number]['id']
  | (typeof SELL_TOUR_STEPS)[number]['id'];

export interface TourStep { id: TourStepId; anchor: string }

const FLOWS: Record<TourFlow, readonly TourStep[]> = { room: TOUR_STEPS, sell: SELL_TOUR_STEPS };
export const stepsOf = (flow: TourFlow): readonly TourStep[] => FLOWS[flow];
export const ALL_TOUR_STEP_IDS: readonly TourStepId[] = [...new Set([...TOUR_STEPS, ...SELL_TOUR_STEPS].map((s) => s.id))];
