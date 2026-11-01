import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPending } from '../../src/pending.ts';
import type { Fingerprint } from '../../src/images.ts';

// The parked-picks store on its own (src/pending.ts): a 100-byte budget keeps the sizes readable.
const info = {} as Fingerprint;
const meta = { source_url: null, page_title: null };
const entry = (userId: number, bytes: number) => ({ buf: Buffer.alloc(bytes), info, meta, userId });

describe('pending picks', () => {
  it("keeps one user's pick while another fills the store", () => {
    const p = createPending({ maxBytes: 100 });
    const alice = p.put(entry(1, 10));
    const bob = Array.from({ length: 20 }, () => p.put(entry(2, 30)));
    assert.ok(p.get(alice), "alice's pick survives");
    assert.ok(p.get(bob.at(-1)!), "bob's newest is kept");
    assert.equal(bob.filter((t) => p.get(t)).length, 3, 'bob keeps what fits beside alice');
  });

  it('makes room for a new pick from the biggest holder when the uploader has nothing to give up', () => {
    const p = createPending({ maxBytes: 100 });
    const alice = p.put(entry(1, 20));
    const bob = [p.put(entry(2, 40)), p.put(entry(2, 40))];
    const carol = p.put(entry(3, 30));
    assert.ok(p.get(carol));
    assert.ok(p.get(alice));
    assert.equal(p.get(bob[0]), null, "bob's oldest went");
    assert.ok(p.get(bob[1]));
  });

  it('refuses an entry bigger than the whole store, keeping the rest', () => {
    const p = createPending({ maxBytes: 100 });
    const alice = p.put(entry(1, 50));
    assert.throws(() => p.put(entry(2, 101)), { status: 413 });
    assert.ok(p.get(alice));
  });

  it('accepts an entry exactly the size of the store, pushing out the rest', () => {
    const p = createPending({ maxBytes: 100 });
    const alice = p.put(entry(1, 50));
    const bob = p.put(entry(2, 100));
    assert.ok(p.get(bob));
    assert.equal(p.get(alice), null);
  });

  it('expires entries after the ttl', () => {
    const p = createPending({ ttlMs: -1 });
    assert.equal(p.get(p.put(entry(1, 10))), null);
  });
});
