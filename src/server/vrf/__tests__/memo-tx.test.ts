/**
 * The memo transactions on LiteSVM (the real Memo program): SA is the fee payer and the only account that holds lamports, the VRF key signs
 * with 0 lamports, and a transaction without the VRF signature is rejected by the program (so a memo cannot be attributed to the key
 * unless the key signed it). The commit and reveal texts of lib/vrf fit and are the ones the browser verifier parses back.
 */
import { describe, expect, it } from 'vitest';
import { Keypair, Transaction, TransactionInstruction } from '@solana/web3.js';
import { getTransactionDecoder } from '@solana/kit';
import { FailedTransactionMetadata, LiteSVM } from 'litesvm';
import bs58 from 'bs58';
import { MEMO_PROGRAM_ID } from '@/lib/chain/ix';
import { MAINNET_USDC_MINT } from '@/lib/chain/config';
import { buildCommitMemo, buildRevealMemo, parseMemo } from '@/lib/vrf';
import { blockhashOfTx, buildMemoTx } from '../chain';

const REQ = '1a2b3c4d-2222-4333-8444-5555abcdef55';
const send = (svm: LiteSVM, base64: string) => svm.sendTransaction(getTransactionDecoder().decode(Buffer.from(base64, 'base64')));

function world() {
  const svm = new LiteSVM();
  const sa = Keypair.generate(), vrf = Keypair.generate();
  svm.airdrop(sa.publicKey.toBase58() as never, 1_000_000_000n as never);
  return { svm, sa, vrf };
}

describe('memo transactions on LiteSVM', () => {
  it('the commit and the reveal memo land with SA as fee payer and the VRF key (0 lamports) as signer', () => {
    const { svm, sa, vrf } = world();
    const beacon = { slot: 400_000_033, blockhash: bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => i + 1)) };
    for (const memo of [buildCommitMemo(REQ, 'a'.repeat(64), 1_790_000_120), buildRevealMemo(REQ, beacon, 'b'.repeat(160))]) {
      const tx = buildMemoTx(memo, sa, vrf, svm.latestBlockhash());
      const r = send(svm, tx.base64);
      expect(r instanceof FailedTransactionMetadata ? r.toString() : 'ok').toBe('ok');
      expect(parseMemo(memo)).not.toBeNull();
      svm.expireBlockhash();
    }
    expect(svm.getBalance(vrf.publicKey.toBase58() as never) ?? 0n).toBe(0n);
    expect(svm.getBalance(sa.publicKey.toBase58() as never)!).toBeLessThan(1_000_000_000n);
  });

  it('the signature of the transaction is the one buildMemoTx reports, and the stored blockhash is readable back', () => {
    const { svm, sa, vrf } = world();
    const bh = svm.latestBlockhash();
    const tx = buildMemoTx(buildCommitMemo(REQ, 'c'.repeat(64), 1_790_000_120), sa, vrf, bh);
    expect(blockhashOfTx(tx.base64)).toBe(bh);
    const t = Transaction.from(Buffer.from(tx.base64, 'base64'));
    expect(bs58.encode(t.signatures[0]!.signature!)).toBe(tx.signature);
    expect(t.signatures.map((s) => s.publicKey.toBase58()).sort()).toEqual([sa.publicKey.toBase58(), vrf.publicKey.toBase58()].sort());
  });

  it('a transaction without the VRF signature is not accepted by the runtime (it cannot be attributed to the key)', () => {
    const { svm, sa, vrf } = world();
    const t = new Transaction({ feePayer: sa.publicKey, recentBlockhash: svm.latestBlockhash() });
    t.add(new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [{ pubkey: vrf.publicKey, isSigner: true, isWritable: false }], data: Buffer.from(buildCommitMemo(REQ, 'd'.repeat(64), 1_790_000_120)) }));
    t.partialSign(sa); // the VRF key did not sign
    expect(() => svm.sendTransaction(getTransactionDecoder().decode(t.serialize({ requireAllSignatures: false, verifySignatures: false })))).toThrow(/missing signatures/i);
  });

  it('only memo texts of ASCII and at most the memo limit can be built', () => {
    const { sa, vrf } = world();
    expect(() => buildMemoTx('héllo', sa, vrf, '11111111111111111111111111111111')).toThrow();
    expect(() => buildMemoTx('x'.repeat(567), sa, vrf, '11111111111111111111111111111111')).toThrow();
    expect(() => buildMemoTx('', sa, vrf, '11111111111111111111111111111111')).toThrow();
  });

  it('cluster-agnostic: the memo texts carry no cluster, so the same builder serves devnet and mainnet (the mainnet USDC mint is not involved)', () => {
    expect(MAINNET_USDC_MINT).toMatch(/^EPjF/);
    expect(buildCommitMemo(REQ, 'e'.repeat(64), 1_790_000_120)).not.toMatch(/devnet|mainnet/);
  });
});
