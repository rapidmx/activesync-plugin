///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import { ApiErrorMessages, ApiErrors, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { childText, element, findChild, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import type { EasCommandContext, EasCommandHandler } from "../EasCommandHandler.js";
import { asEntity, type Mailbox } from "@rapidmx/restapi";
const { Init } = ObjectDecorators;

/**
 * Handles EAS `Settings`: the first-run/general-purpose device<->server settings exchange. This pragmatic
 * subset supports the sub-elements every real client actually depends on:
 *
 * - `UserInformation`/`Get`: returns the mailbox's `primarySmtpAddress`/`aliasAddresses` as `EmailAddresses`.
 * - `DeviceInformation`/`Set`: acknowledged with `Status 1` but not persisted anywhere - `DeviceSyncState` has
 * no fields for a device's model/IMEI/OS/friendly name, and nothing else in this library currently consumes
 * them. A real client only requires the acknowledgement to proceed past first-run setup, not that the values
 * are retrievable later.
 * - `Oof`/`Get` and `Oof`/`Set`: reads/writes `Mailbox.oofEnabled`/`oofMessage`/`oofStartTime`/`oofEndTime`.
 * `StartTime`/`EndTime` use MS-ASDTYPE's plain `dateTime` type (`Date.prototype.toISOString()`), not Compact
 * DateTime - confirmed against MS-ASSETTINGS directly, unlike `Calendar`/`Tasks`' timestamp fields (see
 * `CompactDateTime.ts`'s own doc comment on that exact distinction). A single combined reply message is stored
 * rather than the spec's three audience-specific `OofMessage` variants (internal/external-known/
 * external-unknown) - matches this codebase's existing "one thing, not three" simplification precedent (e.g.
 * `ContactsSyncAdapter`'s single-slot phone/email handling).
 * - `RightsManagementInformation` is not implemented - deferred, matching this library's "pragmatic subset"
 * precedent elsewhere (e.g. `ComposeMailCommand`'s own documented gaps).
 *
 * `mailboxClass` is supplied by the Mongo/SQL concrete subclasses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class SettingsCommand implements EasCommandHandler {
    public readonly command = "Settings";

    protected abstract mailboxClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private mailboxRepo?: RepoUtils<any>;

    @Init
    public async init(): Promise<void> {
        this.mailboxRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.mailboxClass.name,
            args: [this.mailboxClass],
        });
    }

    public async handle(ctx: EasCommandContext): Promise<WbxmlElement | undefined> {
        if (!this.mailboxRepo) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }

        const children: WbxmlElement[] = [textElement(WbxmlCodePage.Settings, "Status", "1")];

        if (ctx.request && findChild(ctx.request, "DeviceInformation")) {
            children.push(
                element(WbxmlCodePage.Settings, "DeviceInformation", [textElement(WbxmlCodePage.Settings, "Status", "1")]),
            );
        }

        if (ctx.request && findChild(ctx.request, "UserInformation")) {
            const mailbox: Mailbox | undefined = await this.mailboxRepo.findOne(ctx.mailboxUid, { ignoreACL: true });
            if (!mailbox) {
                throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
            }
            children.push(
                element(WbxmlCodePage.Settings, "UserInformation", [
                    textElement(WbxmlCodePage.Settings, "Status", "1"),
                    element(WbxmlCodePage.Settings, "EmailAddresses", [
                        textElement(WbxmlCodePage.Settings, "SmtpAddress", mailbox.primarySmtpAddress),
                        ...mailbox.aliasAddresses.map((address) => textElement(WbxmlCodePage.Settings, "SmtpAddress", address)),
                    ]),
                ]),
            );
        }

        const oofEl = ctx.request ? findChild(ctx.request, "Oof") : undefined;
        if (oofEl) {
            const mailbox: (Mailbox & { uid: string; version: number }) | undefined = await this.mailboxRepo.findOne(
                ctx.mailboxUid,
                { ignoreACL: true },
            );
            if (!mailbox) {
                throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
            }
            const setEl = findChild(oofEl, "Set");
            children.push(setEl ? await this.setOof(ctx, mailbox, setEl) : this.getOof(mailbox));
        }

        return element(WbxmlCodePage.Settings, "Settings", children);
    }

    /** `OofState`: `0`=disabled, `1`=enabled indefinitely, `2`=time-based (only while now is within
     * `StartTime`/`EndTime`). */
    private getOof(mailbox: Mailbox): WbxmlElement {
        const timed = mailbox.oofEnabled && !!mailbox.oofStartTime && !!mailbox.oofEndTime;
        return element(WbxmlCodePage.Settings, "Oof", [
            textElement(WbxmlCodePage.Settings, "Status", "1"),
            element(WbxmlCodePage.Settings, "Get", [
                textElement(WbxmlCodePage.Settings, "OofState", mailbox.oofEnabled ? (timed ? "2" : "1") : "0"),
                ...(timed
                    ? [
                          textElement(WbxmlCodePage.Settings, "StartTime", mailbox.oofStartTime!.toISOString()),
                          textElement(WbxmlCodePage.Settings, "EndTime", mailbox.oofEndTime!.toISOString()),
                      ]
                    : []),
                element(WbxmlCodePage.Settings, "OofMessage", [
                    element(WbxmlCodePage.Settings, "AppliesToInternal", []),
                    textElement(WbxmlCodePage.Settings, "Enabled", mailbox.oofEnabled ? "1" : "0"),
                    textElement(WbxmlCodePage.Settings, "ReplyMessage", mailbox.oofMessage),
                    textElement(WbxmlCodePage.Settings, "BodyType", "Text"),
                ]),
            ]),
        ]);
    }

    private async setOof(
        ctx: EasCommandContext,
        mailbox: Mailbox & { uid: string; version: number },
        setEl: WbxmlElement,
    ): Promise<WbxmlElement> {
        const oofState = childText(setEl, "OofState") ?? "0";
        const oofMessageEl = findChild(setEl, "OofMessage");
        const replyMessage = oofMessageEl ? (childText(oofMessageEl, "ReplyMessage") ?? "") : "";
        const startTime = childText(setEl, "StartTime");
        const endTime = childText(setEl, "EndTime");
        const timed = oofState === "2" && startTime !== undefined && endTime !== undefined;

        // `null`, not `undefined`, to clear a previously-set window when switching away from time-based Oof:
        // TypeORM's `UpdateQueryBuilder` silently drops any `undefined`-valued key from the generated SQL `SET`
        // clause (confirmed by reading its source), so `undefined` here would leave a stale StartTime/EndTime
        // in place on the SQL backend while correctly clearing it on Mongo - `null` clears it on both.
        await this.mailboxRepo!.update(
            {
                uid: mailbox.uid,
                version: mailbox.version,
                oofEnabled: oofState !== "0",
                oofMessage: replyMessage,
                oofStartTime: timed ? new Date(startTime) : null,
                oofEndTime: timed ? new Date(endTime) : null,
            } as any,
            asEntity(this.mailboxRepo!, mailbox),
            { ignoreACL: true, user: ctx.user },
        );

        return element(WbxmlCodePage.Settings, "Oof", [
            textElement(WbxmlCodePage.Settings, "Status", "1"),
            element(WbxmlCodePage.Settings, "Set", [textElement(WbxmlCodePage.Settings, "Status", "1")]),
        ]);
    }
}
