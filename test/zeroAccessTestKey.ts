///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// A mailbox zero-access key for tests: what `Mailbox.zeroAccessKeys` holds, so restapi seals to it.
import "reflect-metadata";
import { createHash, webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

/** A P-256 zero-access key's `Mailbox.zeroAccessKeys` entry, with a self-signed certificate. */
export async function testZeroAccessKey(): Promise<any> {
    const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        name: "CN=zero-access",
        notBefore: new Date(Date.now() - 1000),
        notAfter: new Date(Date.now() + 86_400_000),
        keys: keys as CryptoKeyPair,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    });
    const der = Buffer.from(cert.rawData);
    return {
        publicKey: der.toString("base64"),
        type: "x509",
        useType: "zero-access",
        fingerprint: createHash("sha256").update(der).digest("hex"),
        notBefore: 1,
        notAfter: Number.MAX_SAFE_INTEGER,
    };
}
