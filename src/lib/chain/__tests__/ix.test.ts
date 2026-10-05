/** The hand-written instruction module must equal @solana/spl-token and mpl-core byte for byte, so the package can be dropped safely. */
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import * as spl from '@solana/spl-token';
import { createNoopSigner, publicKey as umiPk } from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { mplCore, transferV1 } from '@metaplex-foundation/mpl-core';
import { toWeb3JsInstruction } from '@metaplex-foundation/umi-web3js-adapters';
import { ataAddress, coreTransferV1Ix, createAtaIdempotentIx, initializeMint2Ix, mintToIx, tokenAccountAmount, transferCheckedIx } from '../ix';

const k = () => Keypair.generate().publicKey;
const [mint, owner, payer, dest, authority, freeze, asset, coll] = [k(), k(), k(), k(), k(), k(), k(), k()];
const same = (a: ReturnType<typeof transferCheckedIx>, b: ReturnType<typeof transferCheckedIx>) => {
  expect(a.programId.toBase58()).toBe(b.programId.toBase58());
  expect(Buffer.from(a.data).toString('hex')).toBe(Buffer.from(b.data).toString('hex'));
  expect(a.keys.map((x) => [x.pubkey.toBase58(), x.isSigner, x.isWritable])).toEqual(b.keys.map((x) => [x.pubkey.toBase58(), x.isSigner, x.isWritable]));
};

describe('ix.ts against @solana/spl-token', () => {
  it('ATA address, including an off-curve owner', () => {
    expect(ataAddress(mint, owner).toBase58()).toBe(spl.getAssociatedTokenAddressSync(mint, owner).toBase58());
    const pda = PublicKey.findProgramAddressSync([Buffer.from('x')], k())[0];
    expect(ataAddress(mint, pda).toBase58()).toBe(spl.getAssociatedTokenAddressSync(mint, pda, true).toBase58());
  });
  it('createAssociatedTokenAccountIdempotent', () => {
    const ata = ataAddress(mint, owner);
    same(createAtaIdempotentIx(payer, ata, owner, mint), spl.createAssociatedTokenAccountIdempotentInstruction(payer, ata, owner, mint));
  });
  it('transferChecked', () => {
    same(transferCheckedIx(dest, mint, ataAddress(mint, owner), authority, 117_000_000n, 6), spl.createTransferCheckedInstruction(dest, mint, ataAddress(mint, owner), authority, 117_000_000n, 6, [], spl.TOKEN_PROGRAM_ID));
    same(transferCheckedIx(dest, mint, dest, authority, 2n ** 64n - 1n, 6), spl.createTransferCheckedInstruction(dest, mint, dest, authority, 2n ** 64n - 1n, 6));
  });
  it('initializeMint2 with and without a freeze authority', () => {
    same(initializeMint2Ix(mint, 6, authority, null), spl.createInitializeMint2Instruction(mint, 6, authority, null));
    same(initializeMint2Ix(mint, 6, authority, freeze), spl.createInitializeMint2Instruction(mint, 6, authority, freeze));
  });
  it('mintTo', () => same(mintToIx(mint, dest, authority, 1_000_000_000n), spl.createMintToInstruction(mint, dest, authority, 1_000_000_000n)));
  it('refuses an amount that does not fit a u64 or is negative', () => {
    expect(() => transferCheckedIx(dest, mint, dest, authority, 2n ** 64n, 6)).toThrow(RangeError);
    expect(() => transferCheckedIx(dest, mint, dest, authority, -1n, 6)).toThrow(RangeError);
  });
  it('reads the amount of a token account', () => {
    const data = new Uint8Array(165);
    Buffer.from(data.buffer).writeBigUInt64LE(123_456_789n, 64);
    expect(tokenAccountAmount(data)).toBe(123_456_789n);
    expect(() => tokenAccountAmount(new Uint8Array(10))).toThrow();
  });
});

describe('ix.ts against mpl-core', () => {
  const umi = createUmi('http://127.0.0.1:9').use(mplCore());
  for (const withCollection of [true, false]) {
    it(`TransferV1 ${withCollection ? 'with' : 'without'} a collection, authority != payer`, () => {
      const theirs = toWeb3JsInstruction(transferV1(umi, {
        asset: umiPk(asset.toBase58()), collection: withCollection ? umiPk(coll.toBase58()) : undefined, newOwner: umiPk(dest.toBase58()),
        payer: createNoopSigner(umiPk(payer.toBase58())), authority: createNoopSigner(umiPk(authority.toBase58())),
      }).getInstructions()[0]!);
      same(coreTransferV1Ix({ asset, collection: withCollection ? coll : null, payer, authority, newOwner: dest }), theirs as never);
    });
  }
});
