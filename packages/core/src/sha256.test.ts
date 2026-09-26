/**
 * The pure-TS SHA-256 behind the event log's hash chain: the FIPS 180-4 /
 * NIST example vectors, every padding boundary, UTF-8 input, and agreement
 * with node:crypto over random inputs (node:crypto is used here only, in the
 * test, never by core itself).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sha256, sha256Hex } from "./sha256";

test("NIST vectors", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(
    sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
  assert.equal(
    sha256Hex(
      "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
    ),
    "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1",
  );
  assert.equal(sha256Hex("a".repeat(1_000_000)), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
});

test("every length across the padding boundaries agrees with node:crypto", () => {
  for (let len = 0; len <= 200; len++) {
    const bytes = new Uint8Array(len).map((_, i) => (i * 31 + len) & 0xff);
    assert.equal(sha256Hex(bytes), createHash("sha256").update(bytes).digest("hex"), `length ${len}`);
  }
});

test("strings hash as UTF-8, and random strings agree with node:crypto", () => {
  assert.equal(sha256Hex("é"), createHash("sha256").update("é", "utf8").digest("hex"));
  assert.equal(sha256Hex("€ 𝄞 名"), createHash("sha256").update("€ 𝄞 名", "utf8").digest("hex"));
  let x = 12345;
  for (let i = 0; i < 300; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const s = Array.from({ length: x % 300 }, (_, j) => String.fromCharCode(32 + ((x >> (j % 16)) + j) % 2000)).join("");
    assert.equal(sha256Hex(s), createHash("sha256").update(s, "utf8").digest("hex"));
  }
  assert.equal(sha256("abc").length, 32);
});
