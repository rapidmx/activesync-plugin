///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { JWTUser } from "@rapidrest/core";
import type { HttpRequest, HttpResponse, RepoUtils } from "@rapidrest/service-core";
import type { WbxmlElement } from "./codec/WbxmlElement.js";
import type { DeviceSyncState } from "./models/DeviceSyncState.js";

/**
 * Everything an `EasCommandHandler` needs to process one dispatched EAS command — assembled once by
 * `BaseEasRoute.dispatch()` per request and handed to whichever handler matches `?Cmd=`.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface EasCommandContext {
    /** The authenticated caller, per the same `@AuthUser` JWT payload every other route in this library reads. */
    readonly user: JWTUser;
    /** The `Mailbox` this request operates against — resolved server-side from `user` (`ownerUserUid`), never
     * taken from client input. */
    readonly mailboxUid: string;
    /** The client-supplied `?DeviceId=` query value, identifying this device within the mailbox. */
    readonly deviceId: string;
    /** The client-supplied `?DeviceType=` query value (e.g. `iPhone`, `Android`). */
    readonly deviceType: string;
    /** The protocol version the client negotiated for this request (its `MS-ASProtocolVersion` header, e.g. `"16.1"`),
     * or `undefined` when it sent none - see `isProtocol16OrLater()`. Optional so isolated handler tests can omit it. */
    readonly protocolVersion?: string;
    /** The policy key the device presented (`X-MS-PolicyKey` header, else the `?PolicyKey=` query value). For every
     * command except `Provision`/`Settings`, `BaseEasRoute` has already refused the request unless this equals the
     * stored `deviceSyncState.policyKey`. */
    readonly policyKey?: string;
    /** This device's persisted sync/provisioning state, looked up (or newly created) by `BaseEasRoute` before
     * dispatch. Handlers read/write cursor and provisioning fields on this directly. */
    readonly deviceSyncState: DeviceSyncState;
    /** The live repo backing `deviceSyncState`'s concrete entity class, for handlers that need to persist a
     * change to it (e.g. a new `SyncKey`, an updated `policyKey`, flipping `provisioned`). Typed `RepoUtils<any>`
     * rather than `RepoUtils<DeviceSyncState>` deliberately - `RepoUtils<D>`'s underlying TypeORM `Repository<D>`
     * is not covariant in `D` (a handful of its methods, e.g. `sum()`, use `D`-dependent conditional types), so
     * `BaseEasRoute`'s own `RepoUtils<D>` (for its concrete `D extends DeviceSyncState`) cannot be narrowed to
     * this field's type without `any` somewhere in between. */
    readonly deviceSyncStateRepo: RepoUtils<any>;
    /** Every query-string parameter on the request, for the handful of commands with additional command-
     * specific query parameters beyond the common four already broken out above. */
    readonly query: Record<string, string | string[]>;
    /** The decoded WBXML request body, or `undefined` for a command sent with an empty body (legal for a few
     * commands, e.g. a bare `GetItemEstimate`-less `Ping` continuation). */
    readonly request?: WbxmlElement;
    /** The raw underlying HTTP request, for the rare handler that needs something this context doesn't
     * already surface (e.g. a header). */
    readonly req: HttpRequest;
    /** The underlying HTTP response, when dispatched over HTTP - `PingCommand` registers `onFinish()` on it so a
     * long-poll stops waiting as soon as the client disconnects. Optional so isolated handler tests can omit it. */
    readonly res?: HttpResponse;
}

/**
 * Whether `protocolVersion` is 16.0 or later - where several elements change meaning (e.g. an all-day event carries no
 * `Timezone` and date-only times). A missing or unparseable version counts as earlier: [MS-ASHTTP] requires the header,
 * so only an unusual client omits it, and the pre-16.0 forms are what every 14.x client also understands.
 */
export function isProtocol16OrLater(protocolVersion: string | undefined): boolean {
    const version = Number.parseFloat(protocolVersion ?? "");
    return Number.isFinite(version) && version >= 16;
}

/**
 * One EAS protocol command (`Provision`, `FolderSync`, `Sync`, ...). `BaseEasRoute` builds one instance of
 * each registered handler class in its own `@Init` (via `ObjectFactory`, so a handler can `@Inject` its own
 * dependencies exactly like any other DI-managed class in this library) and dispatches to the one whose
 * `command` matches the request's `?Cmd=` value.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface EasCommandHandler {
    /** The exact `?Cmd=` value this handler answers to (e.g. `"FolderSync"`). */
    readonly command: string;
    /** `true` for the handful of commands (`SendMail`, `SmartForward`, `SmartReply`) whose request body is raw
     * MIME (`Content-Type: message/rfc822`), not WBXML, from protocol version 14.0 onward - the only versions
     * this library ever advertises (see `BaseEasRoute`'s `MS_AS_PROTOCOL_VERSIONS`). `BaseEasRoute.dispatch()`
     * only WBXML-decodes such a request when the client's own `Content-Type` says so (a client may still send
     * the pre-14.0 WBXML-wrapped body despite negotiating a newer version) - otherwise `EasCommandContext.request`
     * is left `undefined` and the handler reads the bytes itself from `ctx.req.rawBody`. Omitted (falsy) for
     * every other command, which is always WBXML regardless of Content-Type. */
    readonly rawBody?: boolean;
    /** Processes the command and returns the WBXML element tree to send back as the response body, or
     * `undefined` for a command whose successful response is legitimately empty. */
    handle(ctx: EasCommandContext): Promise<WbxmlElement | undefined>;
}
