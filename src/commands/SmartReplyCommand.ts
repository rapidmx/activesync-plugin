///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ComposeMailCommand } from "./ComposeMailCommand.js";
import type { EasCommandContext } from "../EasCommandHandler.js";
import { asEntity, type Message } from "@rapidmx/restapi";

/**
 * Handles EAS `SmartReply`: relays a freshly composed message threaded to (and referencing) the original via
 * `<Source>`, then flips the original's `Answered` flag - see `ComposeMailCommand`'s own doc comment for the
 * full shared implementation and this pragmatic subset's scope.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class SmartReplyCommand extends ComposeMailCommand {
    public readonly command = "SmartReply";
    protected override readonly threadsToOriginal: boolean = true;

    protected override async markOriginal(ctx: EasCommandContext, original: Message & { uid: string; version: number }): Promise<void> {
        await this.messageRepo!.update(
            {
                uid: original.uid,
                version: original.version,
                // `lastVerbExecutedAt` pairs with `answered` so `EmailSyncAdapter.render()` can emit MS-ASEMAIL2's
                // `LastVerbExecuted`/`LastVerbExecutionTime` - restapi itself never sets this (see its own doc
                // comment), so every caller that flips `answered`/`forwarded` true is expected to stamp it.
                flags: { ...original.flags, answered: true, lastVerbExecutedAt: new Date() },
            } as any,
            asEntity(this.messageRepo!, original),
            { ignoreACL: true, user: ctx.user },
        );
    }
}
