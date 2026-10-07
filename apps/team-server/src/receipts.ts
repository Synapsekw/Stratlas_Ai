/**
 * The server's own hash chain (`aio.receipt/1`): one receipt per accepted op, each naming the
 * previous receipt and signed by the server key (domain `aio.receipt/1`). An export of the
 * server's audit therefore shows exactly which ops the server accepted and in what order, and a
 * removed or edited receipt breaks the chain.
 */
import { contentHash, verifySignature, type Signer } from '@aio/journal';
import { RECEIPT_SCHEMA, Receipt } from '@aio/schema';

/** The receipt id: SHA-256 of the canonical receipt without `id` and `sig`. */
export function receiptId(r: Omit<Receipt, 'id' | 'sig'>): string {
  return contentHash(r);
}

export function makeReceipt(
  signer: Signer,
  serverId: string,
  prev: Receipt | null,
  op: string,
  at: string,
): Receipt {
  const body = {
    schema: RECEIPT_SCHEMA,
    server: serverId,
    seq: (prev?.seq ?? 0) + 1,
    op,
    prev: prev?.id ?? null,
    at,
  };
  const id = receiptId(body);
  return { ...body, id, sig: signer.sign('aio.receipt/1', id) };
}

export interface ReceiptProblem {
  seq: number;
  problem: 'schema' | 'hash' | 'signature' | 'order' | 'link';
}

/** Check a run of receipts from the first: shape, ids, signatures, seq order and links. */
export function verifyReceipts(receipts: readonly unknown[], publicKey: string): ReceiptProblem[] {
  const problems: ReceiptProblem[] = [];
  let prev: Receipt | null = null;
  receipts.forEach((raw, i) => {
    const parsed = Receipt.safeParse(raw);
    const seq = i + 1;
    if (!parsed.success) {
      problems.push({ seq, problem: 'schema' });
      return;
    }
    const r = parsed.data;
    const { id, sig, ...body } = r;
    if (receiptId(body) !== id) problems.push({ seq: r.seq, problem: 'hash' });
    if (!verifySignature(publicKey, 'aio.receipt/1', id, sig))
      problems.push({ seq: r.seq, problem: 'signature' });
    if (r.seq !== (prev?.seq ?? 0) + 1) problems.push({ seq: r.seq, problem: 'order' });
    if (r.prev !== (prev?.id ?? null)) problems.push({ seq: r.seq, problem: 'link' });
    prev = r;
  });
  return problems;
}
