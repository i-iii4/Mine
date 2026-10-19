import { computeBodyHash, sha256 } from "./bodyHash";

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("computeBodyHash (SPEC_EDITING.md, Л11.2)", () => {
  it("gives the SHA-256 of the standard's test vectors", () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    expect(hex(sha256(encode("")))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(hex(sha256(encode("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hex(sha256(encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))))
      .toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    expect(hex(sha256(encode("a".repeat(1000))))).toBe("41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
  });

  it("names a body as the core does: 16 digits of its UTF-8 digest", () => {
    expect(computeBodyHash("")).toBe("e3b0c44298fc1c14");
    expect(computeBodyHash("abc")).toBe("ba7816bf8f01cfea");
    // Cyrillic and a line break of Windows count as their UTF-8 bytes.
    expect(computeBodyHash("Привет\r\n")).toBe("e6ca0a6f8c2ece50");
  });
});
