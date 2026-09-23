///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";

/**
 * Constant-time comparison of two UTF-8 strings, for comparing a client-presented secret (a `PolicyKey`) against
 * the stored value without leaking how many leading bytes matched through response-timing differences - the
 * risk a plain `!==`/`===` comparison carries. `crypto.timingSafeEqual` throws when its two buffers differ in
 * length, so that case is checked first (and is itself not a secret worth hiding: an attacker can already infer
 * the stored key's length from the fixed `crypto.randomBytes(8).toString("hex")` policy-key format).
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
    const bufA = Buffer.from(a, "utf-8");
    const bufB = Buffer.from(b, "utf-8");
    if (bufA.length !== bufB.length) {
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}
