///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import {
    ApiErrorMessages,
    ApiErrors,
    HttpRequest,
    HttpResponse,
    isDuplicateKeyError,
    ObjectFactory,
    RepoUtils,
    RouteDecorators,
} from "@rapidrest/service-core";
import { timingSafeEqualStrings } from "./CryptoUtils.js";
import { WbxmlDecodeError, WbxmlDecoder } from "./codec/WbxmlDecoder.js";
import { WbxmlEncoder } from "./codec/WbxmlEncoder.js";
import type { WbxmlElement } from "./codec/WbxmlElement.js";
import type { EasCommandHandler } from "./EasCommandHandler.js";
import { persistDeviceSyncState } from "./EasSyncKeyUtils.js";
import { Mailbox, resolveCallerMailboxUid } from "@rapidmx/restapi";
import { DeviceSyncState } from "./models/DeviceSyncState.js";
const { Config, Init, Logger } = ObjectDecorators;
const { Auth, Options, Post, Request, Response, User: AuthUser } = RouteDecorators;

/** HTTP 449 ("Retry With") is not a standard HTTP status, but is the long-established Exchange ActiveSync
 * convention a real client recognizes as "you must successfully complete `Provision` before this command will
 * be honored" - simpler than constructing a command-specific WBXML error body for every possible command a
 * client might send before it's provisioned. */
const HTTP_STATUS_RETRY_WITH = 449;

/** `MS-ASProtocolVersions` value this library actually implements against: confirmed via `[MS-ASHTTP]` that
 * "14.0"/"14.1" are the versions whose `ComposeMail`/`Email2` WBXML code pages cover MIME-based
 * `SendMail`/`SmartForward`/`SmartReply` (what `ComposeMailCommand` actually sends) - not 12.x (which predates
 * MIME-based compose). `16.0`/`16.1` are now included too, now that `SettingsCommand` implements `Oof` (their
 * other headline addition, `RightsManagementInformation`, remains unimplemented, but that alone doesn't gate
 * the version string - `MS-ASProtocolCommands` below is the real capability gate, derived live from
 * `this.handlers`, so a client probing capabilities correctly sees any specific unsupported command regardless
 * of which protocol versions are declared, exactly as it already does for `GetItemEstimate`/`MoveItems`/
 * `ResolveRecipients`). No MS-ASCMD `Sync`/`FolderSync`/`Provision` schema element became newly mandatory
 * between 14.1 and 16.1 outside `Oof`/IRM. Ascending, matching the order Microsoft's own spec lists them in. */
const MS_AS_PROTOCOL_VERSIONS = "14.0,14.1,16.0,16.1";

/** Default `mail:eas:max_request_bytes` - comfortably above a real device's largest request (a `SendMail` with
 * attachments), far below the host-wide body limit. The WBXML decoder's own element limits bound memory further. */
const DEFAULT_MAX_REQUEST_BYTES = 16 * 1024 * 1024;

/** Settings request elements a device may send before it is provisioned (and without a policy key): the first-run
 * `UserInformation` lookup and `DeviceInformation` report. Anything else - `Oof` in particular, which writes the
 * mailbox's automatic replies - needs a provisioned device. */
const SETTINGS_WITHOUT_PROVISIONING = new Set(["UserInformation", "DeviceInformation"]);

function firstQueryValue(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

/** An acceptable `DeviceId`: up to 128 visible ASCII characters other than parentheses and commas. [MS-ASHTTP] only
 * allows alphanumerics; this stays more tolerant of real clients while keeping the value out of the query parser's
 * `op(value)` and `in(a,b)` syntax - `DeviceId` goes straight into `find()` criteria for the device's own rows. */
const DEVICE_ID_PATTERN = /^[\x21-\x27\x2a\x2b\x2d-\x7e]{1,128}$/;

/** `DeviceId` values the query parser gives a meaning of its own even without an operator: `me` becomes the caller's
 * uid (or a 403 without one) and `null` becomes an IS NULL match. Both are refused like any other malformed id. */
const RESERVED_DEVICE_IDS: ReadonlySet<string> = new Set(["me", "null"]);

/** Whether `deviceId` is an acceptable `DeviceId` (`DEVICE_ID_PATTERN`, and not one of `RESERVED_DEVICE_IDS`). */
export function isValidDeviceId(deviceId: string | undefined): deviceId is string {
    return deviceId !== undefined && DEVICE_ID_PATTERN.test(deviceId) && !RESERVED_DEVICE_IDS.has(deviceId);
}

/**
 * Abstract base for the single fixed EAS endpoint (`POST /Microsoft-Server-ActiveSync` by MS-ASHTTP
 * convention, though the concrete path is left to the consuming application to mount via `@Route(...)` — see
 * `BaseMailIngestRoute.ts` for the identical undecorated-base-class pattern this follows). Unlike every other
 * route in this library, EAS dispatches on a `Cmd` query parameter against one URL rather than path-based REST
 * routing, so there is exactly one `@Post()` method here, not one per operation.
 *
 * **Auth**: `@Auth(["jwt"])` — the framework's own default strategy, unchanged from every other route in this
 * app. A real native EAS client obtaining that JWT in the first place (rather than the app's own web/API
 * clients, which already have one) requires an OAuth 2.0 Authorization Server capability this library
 * deliberately does not implement itself — see the architecture plan's "Auth" section for the full reasoning
 * behind this choice over a per-request Basic Auth strategy.
 *
 * **Dispatch flow**: reject a body over `mail:eas:max_request_bytes` (413), resolve the caller's own `Mailbox` (never
 * a client-supplied one — `resolveCallerMailboxUid`), find-or-create that (mailbox, device) pair's `DeviceSyncState`,
 * refuse a `blocked` device (one that acknowledged a remote wipe) with 403 for anything but `Provision` (which
 * answers Status 129 itself), decode the WBXML request body (if any; malformed or over the decoder's element limits
 * -> 400), enforce the provisioning gate (provisioned *and* presenting the stored policy key, else 449 - only
 * `Provision` and a `Settings` request limited to `UserInformation`/`DeviceInformation` are exempt), dispatch to the matching registered
 * `EasCommandHandler`, record `lastSyncAt` (best-effort), and encode the handler's response back to WBXML.
 *
 * **Command handlers** are supplied via `commandHandlerClasses` (empty by default — this class alone is just
 * the transport skeleton; concrete command support, e.g. `ProvisionCommand`/`FolderSyncCommand`, is added
 * incrementally in later work by having a concrete subclass populate this array) and instantiated once each in
 * `@Init` via `ObjectFactory`, so a handler can `@Inject` its own dependencies like any other DI-managed class
 * in this library.
 *
 * **`OPTIONS` protocol discovery**: real EAS clients conventionally probe `OPTIONS` before their first `POST`
 * to read `MS-ASProtocolVersions`/`MS-ASProtocolCommands` and learn what the server supports - see `options()`
 * below. This requires `@rapidrest/service-core` >=1.5.0, whose global CORS middleware consults
 * `IHttpRouter.hasExplicitOptionsRoute()` before its blanket preflight `204` - confirmed live end to end
 * against a real `service-core` 1.5.0 install (`test/routes/{mongo,sql}/EasRoute.test.ts`'s `OPTIONS`
 * describe block), not assumed.
 *
 * `deviceSyncStateClass`/`mailboxClass` are supplied by the Mongo/SQL concrete subclasses, following the exact
 * one-line-per-backend pattern used throughout this library's other routes/jobs.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseEasRoute<D extends DeviceSyncState, M extends Mailbox = Mailbox> {
    protected abstract deviceSyncStateClass: any;
    protected abstract mailboxClass: any;

    /** Command handler classes to instantiate (one each) in `@Init`. Empty until a concrete command lands -
     * every request is then answered with HTTP 501 (see `dispatch()`), which is the correct, honest behavior
     * for a transport skeleton with no commands implemented yet, not a bug to work around. */
    protected commandHandlerClasses: any[] = [];

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private deviceSyncStateRepo?: RepoUtils<D>;
    private mailboxRepo?: RepoUtils<M>;
    private readonly handlers = new Map<string, EasCommandHandler>();

    /** Largest request body `dispatch()` accepts (HTTP 413 beyond it). */
    @Config("mail:eas:max_request_bytes", DEFAULT_MAX_REQUEST_BYTES)
    private maxRequestBytes: number = DEFAULT_MAX_REQUEST_BYTES;

    @Logger
    private logger: any;

    @Init
    public async init(): Promise<void> {
        this.deviceSyncStateRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.deviceSyncStateClass.name,
            args: [this.deviceSyncStateClass],
        });
        this.mailboxRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.mailboxClass.name,
            args: [this.mailboxClass],
        });
        for (const HandlerClass of this.commandHandlerClasses) {
            const handler: EasCommandHandler = await this._objectFactory!.newInstance(HandlerClass);
            this.handlers.set(handler.command, handler);
        }
    }

    /**
     * Answers a real client's pre-flight `MS-ASProtocolVersions`/`MS-ASProtocolCommands` capability probe -
     * see this class's own doc comment for the `service-core` version dependency this needs to actually run.
     * Deliberately unauthenticated (no `@Auth`): this is capability discovery, not mailbox access, and a real
     * Exchange server answers it the same way regardless of credentials. `MS-ASProtocolCommands` is built from
     * `this.handlers`, not a separately-maintained list, so it can never drift out of sync with the commands a
     * concrete subclass actually registered via `commandHandlerClasses`.
     */
    @Options()
    public async options(@Response res: HttpResponse): Promise<void> {
        res.setHeader("MS-ASProtocolVersions", MS_AS_PROTOCOL_VERSIONS)
            .setHeader("MS-ASProtocolCommands", Array.from(this.handlers.keys()).join(","))
            .status(200)
            .send();
    }

    @Auth(["jwt"])
    @Post()
    public async dispatch(@Request req: HttpRequest, @Response res: HttpResponse, @AuthUser user?: JWTUser): Promise<void> {
        if (!this.deviceSyncStateRepo || !this.mailboxRepo) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        if (!user) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }

        const cmd: string | undefined = firstQueryValue(req.query["Cmd"]);
        const deviceId: string | undefined = firstQueryValue(req.query["DeviceId"]);
        const deviceType: string = firstQueryValue(req.query["DeviceType"]) ?? "Unknown";
        const policyKey: string | undefined = firstQueryValue(req.query["PolicyKey"]);
        if (!cmd || !isValidDeviceId(deviceId)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }

        // service-core has no per-route body limit, so the host-wide `max_body_size` still bounds how much was
        // read; this rejects anything beyond the (much lower) EAS limit before any decoding or database work.
        const declaredLength = Number(firstQueryValue(req.headers["content-length"]));
        if ((Number.isFinite(declaredLength) && declaredLength > this.maxRequestBytes) || (req.rawBody?.length ?? 0) > this.maxRequestBytes) {
            res.status(413).send();
            return;
        }

        const mailboxUid: string | undefined = await resolveCallerMailboxUid(this.mailboxRepo, user);
        if (!mailboxUid) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }

        const deviceSyncState: D = await this.findOrCreateDeviceSyncState(mailboxUid, deviceId, deviceType);

        // A device that acknowledged a remote wipe stays locked out until an administrator unblocks it.
        if (deviceSyncState.blocked && cmd !== "Provision") {
            res.status(403).send();
            return;
        }

        const handler: EasCommandHandler | undefined = this.handlers.get(cmd);

        // Settings is decoded ahead of the provisioning gate, which needs to see what it asks for; everything else is
        // only decoded once the gate has passed.
        let request: WbxmlElement | undefined = cmd === "Settings" && handler ? this.decodeRequest(req) : undefined;

        // Every command except what must work on an unprovisioned device (Provision itself, and the first-run
        // Settings lookups real clients make before provisioning completes) requires the device to be provisioned AND
        // to present the policy key it acknowledged ([MS-ASPROV]: `X-MS-PolicyKey`, or the `PolicyKey` query value).
        // A missing or stale key - e.g. one from before an admin-requested remote wipe, which clears the stored key -
        // is sent back through Provision with the same 449 rather than being served.
        if (!this.exemptFromProvisioning(cmd, request)) {
            const presentedKey: string | undefined = firstQueryValue(req.headers["x-ms-policykey"]) ?? policyKey;
            if (
                !deviceSyncState.provisioned ||
                !deviceSyncState.policyKey ||
                !presentedKey ||
                !timingSafeEqualStrings(presentedKey, deviceSyncState.policyKey)
            ) {
                res.status(HTTP_STATUS_RETRY_WITH).send();
                return;
            }
        }

        if (!handler) {
            res.status(501).send();
            return;
        }
        if (cmd !== "Settings") {
            request = this.decodeRequest(req);
        }

        const response: WbxmlElement | undefined = await handler.handle({
            user,
            mailboxUid,
            deviceId,
            deviceType,
            policyKey: firstQueryValue(req.headers["x-ms-policykey"]) ?? policyKey,
            deviceSyncState,
            deviceSyncStateRepo: this.deviceSyncStateRepo,
            query: req.query,
            request,
            req,
            res,
        });

        // Bookkeeping only - the command already ran, so failing to record the timestamp must never turn a
        // successful response into an error.
        try {
            await persistDeviceSyncState(deviceSyncState, this.deviceSyncStateRepo, { lastSyncAt: new Date() });
        } catch (err: any) {
            this.logger?.warn(`BaseEasRoute: failed to record lastSyncAt for device ${deviceId}: ${err?.message}`);
        }

        if (!response) {
            res.status(200).send();
            return;
        }

        const buffer: Buffer = new WbxmlEncoder().encode(response);
        res.setHeader("Content-Type", "application/vnd.ms-sync.wbxml")
            .setHeader("Content-Length", buffer.length)
            .status(200)
            .send(buffer);
    }

    /** Decodes the WBXML request body, if any (malformed or over the decoder's element limits -> 400). */
    private decodeRequest(req: HttpRequest): WbxmlElement | undefined {
        try {
            return req.rawBody && req.rawBody.length > 0 ? new WbxmlDecoder().decode(req.rawBody) : undefined;
        } catch (err) {
            if (err instanceof WbxmlDecodeError) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `Malformed WBXML request: ${err.message}`);
            }
            throw err;
        }
    }

    /** `Provision`, and a `Settings` request whose every element is one `SETTINGS_WITHOUT_PROVISIONING` allows. */
    private exemptFromProvisioning(cmd: string, request: WbxmlElement | undefined): boolean {
        if (cmd === "Provision") {
            return true;
        }
        return cmd === "Settings" && (request?.children ?? []).every((child) => SETTINGS_WITHOUT_PROVISIONING.has(child.tag));
    }

    private async findOrCreateDeviceSyncState(mailboxUid: string, deviceId: string, deviceType: string): Promise<D> {
        const existing: D[] = await this.deviceSyncStateRepo!.find(
            { mailboxUid, deviceId },
            { ignoreACL: true, limit: 1 },
        );
        if (existing[0]) {
            return existing[0];
        }
        const instance: D = this.deviceSyncStateRepo!.instantiateObject({
            mailboxUid,
            deviceId,
            deviceType,
            folderSyncKeys: {},
            provisioned: false,
        });
        try {
            return await this.deviceSyncStateRepo!.create(instance, { ignoreACL: true });
        } catch (err) {
            // TOCTOU: two concurrent first requests from the same (mailbox, deviceId) can both see no existing
            // row above and both reach here. The unique index on (mailboxUid, deviceId) lets only one `create()`
            // win; the loser hits a duplicate-key error (surfaced by `RepoUtils.create()` as
            // `ApiErrors.IDENTIFIER_EXISTS`, or the raw driver error if some other layer throws first). Rather
            // than fail the request, transparently read back the winner's row - it's the same logical state a
            // request arriving a moment later would have found via the `find()` above.
            if (err instanceof ApiError ? err.code === ApiErrors.IDENTIFIER_EXISTS : isDuplicateKeyError(err)) {
                const winner: D[] = await this.deviceSyncStateRepo!.find(
                    { mailboxUid, deviceId },
                    { ignoreACL: true, limit: 1 },
                );
                if (winner[0]) {
                    return winner[0];
                }
            }
            throw err;
        }
    }
}
