///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ComposeMailCommand } from "./ComposeMailCommand.js";
import type { EasCommandContext } from "../EasCommandHandler.js";
import { asEntity, type Message } from "@rapidmx/restapi";

/**
 * Handles EAS `SmartForward`: relays a freshly composed message threaded to (and referencing) the original via
 * `<Source>`, then flips the original's `Forwarded` flag - see `ComposeMailCommand`'s own doc comment for the
 * full shared implementation and this pragmatic subset's scope.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class SmartForwardCommand extends ComposeMailCommand {
    public readonly command = "SmartForward";

    protected override async markOriginal(ctx: EasCommandContext, original: Message & { uid: string; version: number }): Promise<void> {
        await this.messageRepo!.update(
            { uid: original.uid, version: original.version, flags: { ...original.flags, forwarded: true } } as any,
            asEntity(this.messageRepo!, original),
            { ignoreACL: true, user: ctx.user },
        );
    }
}
