///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { isProtocol16OrLater } from "../src/EasCommandHandler.js";

describe("EasCommandHandler", () => {
    it("isProtocol16OrLater() is true only for an MS-ASProtocolVersion of 16.0 or later.", () => {
        expect(isProtocol16OrLater("16.0")).toBe(true);
        expect(isProtocol16OrLater("16.1")).toBe(true);
        expect(isProtocol16OrLater("14.1")).toBe(false);
        expect(isProtocol16OrLater("2.5")).toBe(false);
        expect(isProtocol16OrLater("abc")).toBe(false);
        expect(isProtocol16OrLater(undefined)).toBe(false);
    });
});
