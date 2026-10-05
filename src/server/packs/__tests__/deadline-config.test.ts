import { describe, expect, it } from 'vitest';
import { deliveryDeadlineS } from '../instance';
import { DEFAULT_DELIVERY_DEADLINE_S } from '../payfirst';

describe('PACK_DELIVERY_DEADLINE_S (how long a pack operator has to deliver a drawn card)', () => {
  it('defaults to 24 hours, accepts 1 hour to 7 days, and falls back to the default for anything else', () => {
    expect(DEFAULT_DELIVERY_DEADLINE_S).toBe(86_400);
    expect(deliveryDeadlineS({})).toBe(86_400);
    expect(deliveryDeadlineS({ PACK_DELIVERY_DEADLINE_S: '43200' })).toBe(43_200);
    expect(deliveryDeadlineS({ PACK_DELIVERY_DEADLINE_S: ' 3600 ' })).toBe(3_600);
    expect(deliveryDeadlineS({ PACK_DELIVERY_DEADLINE_S: '604800' })).toBe(604_800);
    for (const bad of ['', 'abc', '0', '-5', '59', '3599', '604801', '1.5', '1e9']) expect(deliveryDeadlineS({ PACK_DELIVERY_DEADLINE_S: bad }), bad).toBe(86_400);
  });
});
