/**
 * The few SPL Token / Associated Token / Core instructions the settlement needs, written by hand so that
 * `@solana/spl-token` (and its audit findings) can later be dropped. Pure and browser-safe: only @solana/web3.js.
 * The tests compare every builder byte for byte with the package and with mpl-core's own builder.
 */
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
export const CORE_PROGRAM_ID = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
export const MINT_SIZE = 82;
/** Byte offset of the u64 `amount` inside an SPL token account. */
export const TOKEN_AMOUNT_OFFSET = 64;

const u64le = (n: bigint): Buffer => {
  if (n < 0n || n >= 1n << 64n) throw new RangeError('amount does not fit a u64');
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const meta = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });

/** The associated token account of `owner` for `mint` (owner may be off curve). */
export function ataAddress(mint: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
}

/** Succeeds whether or not the account exists, so there is no race between "check" and "send". */
export function createAtaIdempotentIx(payer: PublicKey, ata: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [meta(payer, true, true), meta(ata, false, true), meta(owner, false, false), meta(mint, false, false), meta(SystemProgram.programId, false, false), meta(TOKEN_PROGRAM_ID, false, false)],
    data: Buffer.from([1]),
  });
}

export function transferCheckedIx(source: PublicKey, mint: PublicKey, dest: PublicKey, authority: PublicKey, amount: bigint, decimals: number): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [meta(source, false, true), meta(mint, false, false), meta(dest, false, true), meta(authority, true, false)],
    data: Buffer.concat([Buffer.from([12]), u64le(amount), Buffer.from([decimals])]),
  });
}

export function initializeMint2Ix(mint: PublicKey, decimals: number, mintAuthority: PublicKey, freezeAuthority: PublicKey | null): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [meta(mint, false, true)],
    data: Buffer.concat([Buffer.from([20, decimals]), mintAuthority.toBuffer(), freezeAuthority ? Buffer.concat([Buffer.from([1]), freezeAuthority.toBuffer()]) : Buffer.from([0])]),
  });
}

export function mintToIx(mint: PublicKey, dest: PublicKey, authority: PublicKey, amount: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [meta(mint, false, true), meta(dest, false, true), meta(authority, true, false)],
    data: Buffer.concat([Buffer.from([7]), u64le(amount)]),
  });
}

/** Core `TransferV1`: the asset's OWNER authorises (`authority`), `payer` only pays. Optional accounts are the program id placeholder. */
export function coreTransferV1Ix(a: { asset: PublicKey; collection: PublicKey | null; payer: PublicKey; authority: PublicKey; newOwner: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      meta(a.asset, false, true),
      meta(a.collection ?? CORE_PROGRAM_ID, false, false),
      meta(a.payer, true, true),
      meta(a.authority, true, false),
      meta(a.newOwner, false, false),
      meta(CORE_PROGRAM_ID, false, false), // system program slot: placeholder
      meta(CORE_PROGRAM_ID, false, false), // log wrapper slot: placeholder
    ],
    data: Buffer.from([14, 0]), // TransferV1 discriminator, compressionProof = None
  });
}

/** The amount of an SPL token account's raw data. */
export function tokenAccountAmount(data: Uint8Array): bigint {
  if (data.length < TOKEN_AMOUNT_OFFSET + 8) throw new RangeError('not a token account');
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).readBigUInt64LE(TOKEN_AMOUNT_OFFSET);
}
