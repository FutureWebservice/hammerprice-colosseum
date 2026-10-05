import { describe, it, expect } from 'vitest';
import { attributesRecord, houseValueUsd, replicaMeta } from '../inventory';

// Regression: staging stored the trait-list shape while the house code read a key/value object, so every card was valued at the flat
// $25, listed without set or grade, and the restock found no template (the house show lost a card per sale and shrank to one lot).
const traits = [
  { trait_type: 'set', value: 'Pokemon Meg EN-Mega Evolution' }, { trait_type: 'grade', value: 'PRISTINE 10' }, { trait_type: 'grading_company', value: 'CGC' },
  { trait_type: 'Replica of', value: 'GonVZioARi8KAwK6ecSjWk2ZgTizgPq4XqvrcU26TfcP' }, { trait_type: 'Insured value (USD)', value: '85' },
];

describe('attributesRecord', () => {
  it('reads a trait list, however its keys are spelled', () => {
    const a = attributesRecord(traits);
    expect(a).toMatchObject({ set: 'Pokemon Meg EN-Mega Evolution', grade: 'PRISTINE 10', grading_company: 'CGC', replica_of: 'GonVZioARi8KAwK6ecSjWk2ZgTizgPq4XqvrcU26TfcP', insured_value_usd: '85' });
  });
  it('passes a key/value object and JSON text through, and survives junk', () => {
    expect(attributesRecord({ grade: 'MINT 9' })).toEqual({ grade: 'MINT 9' });
    expect(attributesRecord(JSON.stringify(traits)).grade).toBe('PRISTINE 10');
    expect(attributesRecord(null)).toEqual({});
    expect(attributesRecord([1, null, { value: 3 }])).toEqual({});
  });
  it('values and describes a trait-list card like an object card', () => {
    const attributes = attributesRecord(traits);
    expect(houseValueUsd(attributes)).toBe(85);
    expect(replicaMeta({ mint: 'm', name: 'n', imageUrl: null, attributes })).toMatchObject({ setName: 'Pokemon Meg EN-Mega Evolution', grade: 'PRISTINE 10', gradingCompany: 'CGC' });
    expect(houseValueUsd(attributesRecord([{ trait_type: 'grade', value: 'PRISTINE 10' }]))).toBe(120);
  });
});
