import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";

bitcoin.initEccLib(ecc);

/**
 * Turns a RAVN BTC-source execute() result (depositAddress + depositAmount) into a
 * ready-to-sign PSBT — the missing last-mile step between "here's where to send BTC" and
 * an agent actually being able to send it, without RAVN ever touching a private key.
 *
 * RAVN's BTC-source venues all resolve to a plain single-recipient payment — not the
 * multi-wallet PSBT co-signing some aggregators need for their own UTXO-consolidation
 * routes. So this only ever needs ONE signer: whatever wallet holds fromAddress's key signs
 * the returned PSBT and broadcasts it. No custody, no key material crosses this boundary —
 * UTXOs and fee data come from a public indexer (mempool.space), and the caller supplies
 * nothing but public addresses and an amount.
 *
 * Self-contained by design: no dependency on any RAVN backend, so it works identically
 * whether run from RAVN's own app or here, standalone.
 */

const MEMPOOL_API = "https://mempool.space/api";
const DUST_THRESHOLD_SATS = 546n;

interface MempoolUtxo {
  txid: string;
  vout: number;
  value: number;
  status?: { confirmed: boolean };
}

export interface PrepareBtcSendResult {
  psbtBase64: string;
  inputCount: number;
  totalInputSats: string;
  feeRateSatsPerVb: number;
  estimatedFeeSats: string;
  changeSats: string;
}

export interface PrepareBtcSendError {
  error: string;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

// ponytail: fixed per-vbyte constants (P2WPKH/P2TR industry-standard figures), not a
// byte-exact estimate from a fully built+signed transaction — accurate to within a couple
// vbytes, immaterial at typical fee rates. Revisit only if this ever needs satoshi-exact fees.
const OVERHEAD_VB = 10.5;
const INPUT_VB = { p2wpkh: 68, p2tr: 57.5 } as const;
const OUTPUT_VB = { p2wpkh: 31, p2tr: 43 } as const;
// toAddress isn't restricted to p2wpkh/p2tr like fromAddress is (the deposit address could
// legitimately be legacy/P2SH/HTLC) — for any output kind this tool doesn't recognize,
// assume the largest known output size rather than the smallest, so the fee estimate only
// ever errs toward overpaying, never underpaying.
const CONSERVATIVE_OUTPUT_VB = Math.max(...Object.values(OUTPUT_VB));

type AddressKind = keyof typeof INPUT_VB;

function addressKind(address: string): AddressKind | null {
  if (/^(bc1p|tb1p)/i.test(address)) return "p2tr";
  if (/^(bc1q|tb1q)/i.test(address)) return "p2wpkh";
  return null;
}

function outputVb(address: string): number {
  const kind = addressKind(address);
  return kind ? OUTPUT_VB[kind] : CONSERVATIVE_OUTPUT_VB;
}

export async function prepareBtcSend(params: {
  fromAddress: string;
  toAddress: string;
  amountSats: string;
  feeRateSatsPerVb?: number;
  network?: "mainnet" | "testnet";
}): Promise<PrepareBtcSendResult | PrepareBtcSendError> {
  const kind = addressKind(params.fromAddress);
  if (!kind) {
    return {
      error:
        "fromAddress must be a native SegWit (bc1q…/tb1q…) or Taproot (bc1p…/tb1p…) address " +
        "— legacy (1…/3…) sources aren't supported by this tool yet.",
    };
  }

  let amountSats: bigint;
  try {
    amountSats = BigInt(params.amountSats);
  } catch {
    return { error: "amountSats must be an integer string, in satoshis" };
  }
  if (amountSats <= 0n) return { error: "amountSats must be a positive integer" };
  if (amountSats < DUST_THRESHOLD_SATS) {
    return { error: `amountSats (${amountSats}) is below the dust threshold (${DUST_THRESHOLD_SATS} sats) — most nodes will refuse to relay it` };
  }

  const network = params.network === "testnet" ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;

  let utxos: MempoolUtxo[];
  let feeRateSatsPerVb: number;
  try {
    const base = params.network === "testnet" ? `${MEMPOOL_API}/testnet` : MEMPOOL_API;
    [utxos, feeRateSatsPerVb] = await Promise.all([
      fetchJson<MempoolUtxo[]>(`${base}/address/${params.fromAddress}/utxo`),
      params.feeRateSatsPerVb !== undefined
        ? Promise.resolve(params.feeRateSatsPerVb)
        : fetchJson<{ halfHourFee: number }>(`${base}/v1/fees/recommended`).then((f) => f.halfHourFee),
    ]);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return { error: `Failed to fetch UTXOs/fee rate from mempool.space: ${message}` };
  }

  // Unconfirmed UTXOs can vanish (RBF, eviction) between preparing and signing — a
  // confirmed-only input set means the PSBT stays valid for as long as the caller needs to
  // get it signed, not just until the mempool changes its mind.
  utxos = utxos.filter((u) => u.status?.confirmed !== false);
  if (utxos.length === 0) {
    return { error: `No confirmed, spendable UTXOs found for ${params.fromAddress}` };
  }

  let script: Uint8Array;
  try {
    script = bitcoin.address.toOutputScript(params.fromAddress, network);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return { error: `fromAddress is not a valid address for this network: ${message}` };
  }
  try {
    bitcoin.address.toOutputScript(params.toAddress, network);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return { error: `toAddress is not a valid address for this network: ${message}` };
  }

  const paymentOutputVb = outputVb(params.toAddress);
  const changeOutputVb = OUTPUT_VB[kind]; // change always returns to fromAddress, whose kind is known

  // ponytail: greedy largest-first coin selection — minimizes input count (and so fees) for
  // the common case, not a byte-optimal (branch-and-bound) selector. Revisit only if dust /
  // UTXO-set management ever becomes a real problem for callers of this tool.
  const sorted = [...utxos].sort((a, b) => b.value - a.value);

  const selected: MempoolUtxo[] = [];
  let totalIn = 0n;
  let fee = 0n;
  for (const utxo of sorted) {
    selected.push(utxo);
    totalIn += BigInt(utxo.value);
    const vsize = OVERHEAD_VB + selected.length * INPUT_VB[kind] + paymentOutputVb + changeOutputVb;
    fee = BigInt(Math.ceil(vsize * feeRateSatsPerVb));
    if (totalIn >= amountSats + fee) break;
  }

  if (totalIn < amountSats + fee) {
    return {
      error:
        `Insufficient balance: ${params.fromAddress} holds ${totalIn} sats across ` +
        `${utxos.length} confirmed UTXO(s), need ~${amountSats + fee} sats (amount + estimated fee)`,
    };
  }

  const psbt = new bitcoin.Psbt({ network });
  for (const utxo of selected) {
    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: { script, value: BigInt(utxo.value) },
    });
  }
  psbt.addOutput({ address: params.toAddress, value: amountSats });

  const change = totalIn - amountSats - fee;
  const changeSats = change >= DUST_THRESHOLD_SATS ? change : 0n;
  if (changeSats > 0n) {
    psbt.addOutput({ address: params.fromAddress, value: changeSats });
  } else if (change > 0n) {
    // Sub-dust leftover isn't worth its own output — folds into the fee instead.
    fee += change;
  }

  return {
    psbtBase64: psbt.toBase64(),
    inputCount: selected.length,
    totalInputSats: totalIn.toString(),
    feeRateSatsPerVb,
    estimatedFeeSats: fee.toString(),
    changeSats: changeSats.toString(),
  };
}
